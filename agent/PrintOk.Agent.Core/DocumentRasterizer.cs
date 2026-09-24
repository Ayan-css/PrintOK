using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using SkiaSharp;

namespace PrintOk.WindowsPrintAgent.Services;

/// <summary>
/// Turns a customer's file into printable pages.
///
/// The agent renders documents itself rather than asking Windows to open them,
/// because "ask the registered application to print this" puts a dialog on the
/// shop's counter PC — the Photo Printing Wizard for an image, a PDF reader for
/// a PDF — and waits for a human to click Print. That is fine for a person
/// printing their own holiday photos and useless for an agent whose entire job
/// is to print without anyone present.
///
/// Pages are rendered one at a time, on demand. A fifty-page PDF at 300dpi is
/// about 35MB per page in memory; rendering the lot up front would be a
/// gigabyte and a half for one customer's dissertation.
/// </summary>
// PDFium ships native binaries per platform. These three are the ones a print
// agent can ever run on, and naming them keeps the platform analyser honest
// rather than silencing it.
[SupportedOSPlatform("windows")]
[SupportedOSPlatform("linux")]
[SupportedOSPlatform("macos")]
public sealed class DocumentRasterizer : IDisposable
{
    /// <summary>What the agent can render itself, with no other software installed.</summary>
    private static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff",
    };

    /// <summary>
    /// The most pages the agent will render for one job.
    ///
    /// A PDF can declare an enormous page tree while staying small on disk —
    /// thousands of page objects all referencing one shared content stream —
    /// and nothing capped it. Rendering that occupies the shop's only print
    /// agent for as long as it takes, sequentially, so every other customer's
    /// job waits behind it, and it spends real paper and toner doing so.
    ///
    /// Two thousand is far above any real order — a shop printing a
    /// dissertation is in the low hundreds — and far below the point where a
    /// counter PC stops responding.
    /// </summary>
    public const int MaxPages = 2000;

    /// <summary>The DPI pages are rendered at.</summary>
    /// <remarks>
    /// 300 is what a shop's laser prints at and what a customer expects of a
    /// paid print. 600 quadruples the memory for a difference nobody can see on
    /// a stationery-shop MFP.
    /// </remarks>
    public const int Dpi = 300;

    private readonly byte[]? _pdf;
    private readonly string? _imagePath;

    public int PageCount { get; }

    private DocumentRasterizer(byte[]? pdf, string? imagePath, int pageCount)
    {
        _pdf = pdf;
        _imagePath = imagePath;
        PageCount = pageCount;
    }

    /// <summary>Whether this file can be rendered without any other software.</summary>
    public static bool CanRender(string path)
    {
        string ext = Path.GetExtension(path);
        return ImageExtensions.Contains(ext) || ext.Equals(".pdf", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Opens a file for rendering, or returns null if this is not something the
    /// agent can draw itself.
    /// </summary>
    public static DocumentRasterizer? Open(string path, ILogger logger)
    {
        string ext = Path.GetExtension(path);

        try
        {
            if (ext.Equals(".pdf", StringComparison.OrdinalIgnoreCase))
            {
                byte[] bytes = File.ReadAllBytes(path);
                int pages = PDFtoImage.Conversion.GetPageCount(bytes);

                // Refused before a single page is rendered, so an oversized
                // document costs the queue nothing rather than monopolising it.
                if (pages > MaxPages)
                {
                    logger.LogError(
                        "'{Path}' declares {Pages} pages, more than the {Max} this agent will print "
                        + "in one job. Split it, or ask the customer for a smaller file.",
                        Path.GetFileName(path), pages, MaxPages);
                    return null;
                }

                return new DocumentRasterizer(bytes, null, pages);
            }

            if (ImageExtensions.Contains(ext))
            {
                // Decoded once here so a corrupt upload fails before the job is
                // reported as printing, rather than halfway through the spool.
                using var probe = SKBitmap.Decode(path);
                if (probe is null)
                {
                    logger.LogError("'{Path}' could not be decoded as an image.", Path.GetFileName(path));
                    return null;
                }
                return new DocumentRasterizer(null, path, 1);
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Could not open '{Path}' for rendering.", Path.GetFileName(path));
            return null;
        }

        return null;
    }

    /// <summary>
    /// Whether a page is wider than it is tall, read from the document without
    /// rendering it, so the printer can turn the sheet before the page is drawn.
    /// </summary>
    public bool IsLandscape(int index)
    {
        if (_pdf is not null)
        {
            var size = PDFtoImage.Conversion.GetPageSize(_pdf, page: (Index)index);
            return size.Width > size.Height;
        }

        using var codec = SKCodec.Create(_imagePath);
        return codec is not null && codec.Info.Width > codec.Info.Height;
    }

    /// <summary>Renders one page. The caller owns the bitmap and must dispose it.</summary>
    public SKBitmap RenderPage(int index)
    {
        if (index < 0 || index >= PageCount)
        {
            throw new ArgumentOutOfRangeException(nameof(index));
        }

        if (_pdf is not null)
        {
            return PDFtoImage.Conversion.ToImage(_pdf, page: (Index)index, options: new(Dpi: Dpi));
        }

        return SKBitmap.Decode(_imagePath)
            ?? throw new InvalidOperationException($"'{_imagePath}' could not be decoded.");
    }

    /// <summary>A page as PNG bytes, which is how it crosses into System.Drawing.</summary>
    /// <param name="index">Zero-based page index.</param>
    /// <param name="grayscale">
    /// Whether to discard colour here, in the bitmap, rather than asking the
    /// printer to. See <see cref="ToGrayscale"/> for why that is not the same
    /// thing.
    /// </param>
    public byte[] RenderPagePng(int index, bool grayscale = false)
    {
        using SKBitmap rendered = RenderPage(index);
        // Held separately so the colour path does not dispose the same bitmap
        // twice through two `using` declarations.
        using SKBitmap? grey = grayscale ? ToGrayscale(rendered) : null;

        using SKImage image = SKImage.FromBitmap(grey ?? rendered);
        using SKData data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    /// <summary>
    /// Drains the colour out of a page before it ever reaches the driver.
    ///
    /// This is the difference between a customer getting the black and white
    /// print they paid for and getting a colour one. Asking Windows for mono
    /// sets <c>dmColor</c> in the DEVMODE, and a driver is free to ignore it —
    /// plenty do, because colour mode is a private driver setting on many PCL
    /// and PostScript models, and on some it only applies when the job is
    /// submitted through that vendor's own UI. The same job then prints mono on
    /// one printer in a shop and full colour on the next one along, which is
    /// exactly what it did.
    ///
    /// A grey bitmap has no colour left to ignore. The DEVMODE request is still
    /// made as well, because a printer that does honour it also saves its
    /// colour toner.
    ///
    /// Weighted by luminance (Rec. 601) rather than averaged, so a red heading
    /// and a blue one do not come out as the same flat grey.
    /// </summary>
    private static SKBitmap ToGrayscale(SKBitmap source)
    {
        var gray = new SKBitmap(source.Width, source.Height, source.ColorType, SKAlphaType.Premul);

        using var canvas = new SKCanvas(gray);
        using var paint = new SKPaint
        {
            ColorFilter = SKColorFilter.CreateColorMatrix(new[]
            {
                0.299f, 0.587f, 0.114f, 0f, 0f,
                0.299f, 0.587f, 0.114f, 0f, 0f,
                0.299f, 0.587f, 0.114f, 0f, 0f,
                0f,     0f,     0f,     1f, 0f,
            }),
        };

        // White first: a PDF page is transparent where nothing was drawn, and
        // premultiplied transparent pixels go through the matrix as black.
        canvas.Clear(SKColors.White);
        canvas.DrawBitmap(source, 0, 0, paint);
        canvas.Flush();

        return gray;
    }

    public void Dispose() { /* nothing unmanaged is held between pages */ }
}
