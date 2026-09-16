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

    private static IEnumerable<SKColor> EveryTenthPixel(SKBitmap bitmap)
    {
        for (int y = 0; y < bitmap.Height; y += 10)
            for (int x = 0; x < bitmap.Width; x += 10)
                yield return bitmap.GetPixel(x, y);
    }
}
