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
    public byte[] RenderPagePng(int index)
    {
        using SKBitmap bitmap = RenderPage(index);
        using SKImage image = SKImage.FromBitmap(bitmap);
        using SKData data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    public void Dispose() { /* nothing unmanaged is held between pages */ }
}
