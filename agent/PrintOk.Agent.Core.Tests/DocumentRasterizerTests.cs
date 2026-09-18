using System.Runtime.Versioning;
using Microsoft.Extensions.Logging.Abstractions;
using PrintOk.WindowsPrintAgent.Services;
using SkiaSharp;
using Xunit;

namespace PrintOk.Agent.Core.Tests;

/// <summary>
/// The agent draws the customer's file itself rather than asking Windows to
/// open it.
///
/// This exists because of what a shop owner photographed: a confirmed, paid job
/// opened the Windows Photo Printing Wizard on the counter PC — paper type set
/// to "Labels" — and waited for someone to click Print. ShellExecute's "print"
/// verb does not print a file, it asks whichever application owns that file
/// type to print it, and for an image that application needs a human.
/// </summary>
// Matches the rasterizer's own platform annotations; PDFium ships natives for
// exactly these three and the test runs on whichever one CI is using.
[SupportedOSPlatform("windows")]
[SupportedOSPlatform("linux")]
[SupportedOSPlatform("macos")]
public class DocumentRasterizerTests
{
    private static string Fixture(string name) =>
        Path.Combine(Path.GetTempPath(), $"printok_test_{Guid.NewGuid():N}_{name}");

    private static string WritePng(int width, int height)
    {
        string path = Fixture("page.png");
        using var bitmap = new SKBitmap(width, height);
        using (var canvas = new SKCanvas(bitmap))
        {
            canvas.Clear(SKColors.White);
            using var paint = new SKPaint { Color = SKColors.Black };
            canvas.DrawRect(10, 10, width - 20, height - 20, paint);
        }
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        File.WriteAllBytes(path, data.ToArray());
        return path;
    }

    [Theory]
    [InlineData("scan.pdf", true)]
    [InlineData("photo.png", true)]
    [InlineData("photo.JPG", true)]
    [InlineData("shot.webp", true)]     // System.Drawing cannot decode this; Skia can
    [InlineData("essay.docx", false)]   // needs Word, so it stays on the shell path
    [InlineData("sheet.xlsx", false)]
    public void Knows_what_it_can_draw_without_other_software(string name, bool expected)
    {
        Assert.Equal(expected, DocumentRasterizer.CanRender(name));
    }

    [Fact]
    public void Renders_an_image_as_a_single_page()
    {
        string path = WritePng(800, 600);
        try
        {
            using var doc = DocumentRasterizer.Open(path, NullLogger.Instance);
            Assert.NotNull(doc);
            Assert.Equal(1, doc!.PageCount);

            using SKBitmap page = doc.RenderPage(0);
            Assert.Equal(800, page.Width);
            Assert.Equal(600, page.Height);
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void Refuses_a_file_that_is_not_the_image_its_name_claims()
    {
        // A corrupt upload must fail here, before the job is reported as
        // printing, rather than halfway through the spool.
        string path = Fixture("not-really.png");
        File.WriteAllText(path, "this is not a PNG");
        try
        {
            Assert.Null(DocumentRasterizer.Open(path, NullLogger.Instance));
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void Refuses_a_pdf_that_is_not_a_pdf()
    {
        string path = Fixture("broken.pdf");
        File.WriteAllText(path, "%PDF-1.4 and then nothing valid at all");
        try
        {
            Assert.Null(DocumentRasterizer.Open(path, NullLogger.Instance));
        }
        finally { File.Delete(path); }
    }

    /// <summary>
    /// The page has to come out at print resolution. A page rendered at screen
    /// DPI and scaled up to A4 is visibly soft, and the customer paid for it.
    /// </summary>
    /// <summary>
    /// The PDF under test is the separator sheet the agent itself prints between
    /// batches, which makes this two checks in one: that PDFium is present and
    /// renders, and that the PDF this codebase hand-writes is a real one. A
    /// separator that no renderer accepts would jam every batch it precedes.
    /// </summary>
    [Fact]
    public void Renders_a_pdf_page_at_print_resolution()
    {
        string? path = SeparatorSheet.TryCreate("invoice", 3, NullLogger.Instance);
        Assert.NotNull(path);

        try
        {
            using var doc = DocumentRasterizer.Open(path!, NullLogger.Instance);
            Assert.NotNull(doc);
            Assert.Equal(1, doc!.PageCount);

            using SKBitmap page = doc.RenderPage(0);

            // The sheet is A4: 595 x 842 points. At 300dpi that is 2479 x 3508.
            Assert.InRange(page.Width, 2400, 2560);
            Assert.InRange(page.Height, 3400, 3600);

            // And it is a real rendering, not a blank sheet.
            Assert.Contains(EveryTenthPixel(page), c => c != SKColors.White && c.Alpha != 0);
        }
        finally { File.Delete(path!); }
    }

    [Fact]
    public void Hands_a_page_over_as_png_bytes()
    {
        // This is the crossing point into System.Drawing, and therefore into
        // the Windows print queue.
        string path = WritePng(200, 100);
        try
        {
            using var doc = DocumentRasterizer.Open(path, NullLogger.Instance);
            byte[] png = doc!.RenderPagePng(0);

            Assert.Equal(new byte[] { 0x89, 0x50, 0x4E, 0x47 }, png.Take(4).ToArray());
            using var decoded = SKBitmap.Decode(png);
            Assert.Equal(200, decoded.Width);
        }
        finally { File.Delete(path); }
    }

    /// <summary>
    /// The colour has to be gone from the bitmap, not merely unrequested.
    ///
    /// This is the fix for a shop that printed the same mono job on two
    /// printers and got black and white on one and full colour on the other.
    /// Asking Windows for mono sets dmColor in the DEVMODE and a driver is free
    /// to ignore it — many do. A grey bitmap has nothing left to ignore.
    /// </summary>
    [Fact]
    public void Prints_black_and_white_as_black_and_white()
    {
        string path = Fixture("colourful.png");

        using (var bitmap = new SKBitmap(120, 90))
        {
            using (var canvas = new SKCanvas(bitmap))
            {
                canvas.Clear(SKColors.White);
                using var red = new SKPaint { Color = new SKColor(220, 20, 20) };
                canvas.DrawRect(0, 0, 60, 90, red);
                using var blue = new SKPaint { Color = new SKColor(20, 20, 220) };
                canvas.DrawRect(60, 0, 60, 90, blue);
            }
            using var image = SKImage.FromBitmap(bitmap);
            using var data = image.Encode(SKEncodedImageFormat.Png, 100);
            File.WriteAllBytes(path, data.ToArray());
        }

        try
        {
            using var doc = DocumentRasterizer.Open(path, NullLogger.Instance);
            Assert.NotNull(doc);

            using var colour = SKBitmap.Decode(doc!.RenderPagePng(0, grayscale: false));
            using var grey = SKBitmap.Decode(doc.RenderPagePng(0, grayscale: true));

            // The colour rendering keeps the red and the blue.
            Assert.Contains(EveryTenthPixel(colour), c => c.Red > c.Blue + 40);
            Assert.Contains(EveryTenthPixel(colour), c => c.Blue > c.Red + 40);

            // The grey one has no channel difference left anywhere.
            foreach (SKColor pixel in EveryTenthPixel(grey))
            {
                Assert.Equal(pixel.Red, pixel.Green);
                Assert.Equal(pixel.Green, pixel.Blue);
            }

            // And it is still a rendering of the page rather than one flat
            // tone. The fixture is two solid halves, so it should come out as
            // exactly two greys — and they must differ, because weighting by
            // luminance is what keeps a red heading distinguishable from a blue
            // one. Averaging the channels would render both halves as the same
            // grey and lose the page's structure entirely.
            var shades = EveryTenthPixel(grey).Select(c => c.Red).Distinct().OrderBy(v => v).ToList();
            Assert.Equal(2, shades.Count);
            Assert.True(shades[1] - shades[0] > 20,
                $"the two halves came out as near-identical greys ({shades[0]} and {shades[1]}), "
                + "which is what averaging the channels would do");
        }
        finally { File.Delete(path); }
    }

    /// <summary>
    /// A page with nothing drawn on it must come out white, not black.
    ///
    /// A PDF page is transparent where nothing was drawn, and a premultiplied
    /// transparent pixel goes through a luminance matrix as black — which would
    /// turn every margin on every mono job into solid toner.
    /// </summary>
    [Fact]
    public void Leaves_the_empty_parts_of_a_grey_page_white()
    {
        string? path = SeparatorSheet.TryCreate("invoice", 3, NullLogger.Instance);
        Assert.NotNull(path);

        try
        {
            using var doc = DocumentRasterizer.Open(path!, NullLogger.Instance);
            using var grey = SKBitmap.Decode(doc!.RenderPagePng(0, grayscale: true));

            var pixels = EveryTenthPixel(grey).ToList();
            Assert.Contains(pixels, c => c.Red > 240);
            // A sheet of mostly-empty A4 must be mostly white.
            Assert.True(
                pixels.Count(c => c.Red > 240) > pixels.Count / 2,
                "an almost-empty page came out dark, which would empty a toner cartridge");
        }
        finally { File.Delete(path!); }
    }

    /// <summary>
    /// A document that declares more pages than the agent will print is
    /// refused before any of them are rendered.
    ///
    /// A PDF can carry thousands of page objects all referencing one shared
    /// content stream, so it stays tiny on disk while occupying the shop's only
    /// print agent for as long as it takes — sequentially, with every other
    /// customer's job waiting behind it, spending real paper the whole way.
    /// </summary>
    [Fact]
    public void Refuses_a_document_with_more_pages_than_it_will_print()
    {
        string path = Fixture("enormous.pdf");

        // A page tree far past the cap, built the cheap way: many page objects,
        // one shared (absent) content stream.
        int pages = DocumentRasterizer.MaxPages + 50;
        var kids = string.Join(" ", Enumerable.Range(0, pages).Select(i => $"{3 + i} 0 R"));
        var body = new System.Text.StringBuilder();
        body.Append("%PDF-1.4\n");
        body.Append("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
        body.Append($"2 0 obj\n<< /Type /Pages /Kids [{kids}] /Count {pages} >>\nendobj\n");
        for (int i = 0; i < pages; i++)
        {
            body.Append($"{3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n");
        }
        body.Append("trailer\n<< /Root 1 0 R >>\n%%EOF\n");
        File.WriteAllText(path, body.ToString());

        try
        {
            // Null, not an exception and not a rasterizer that would then be
            // asked for two thousand pages.
            Assert.Null(DocumentRasterizer.Open(path, NullLogger.Instance));
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void Prints_a_document_inside_the_page_cap()
    {
        // The cap must not refuse an ordinary job. A separator sheet is one page
        // and is the PDF this codebase writes itself.
        string? path = SeparatorSheet.TryCreate("invoice", 3, NullLogger.Instance);
        Assert.NotNull(path);

        try
        {
            using var doc = DocumentRasterizer.Open(path!, NullLogger.Instance);
            Assert.NotNull(doc);
            Assert.InRange(doc!.PageCount, 1, DocumentRasterizer.MaxPages);
        }
        finally { File.Delete(path!); }
    }

    private static IEnumerable<SKColor> EveryTenthPixel(SKBitmap bitmap)
    {
        for (int y = 0; y < bitmap.Height; y += 10)
            for (int x = 0; x < bitmap.Width; x += 10)
                yield return bitmap.GetPixel(x, y);
    }
}
