using System.Drawing;
using System.Drawing.Printing;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using PrintOk.WindowsPrintAgent.Models;

namespace PrintOk.WindowsPrintAgent.Services;

/// <summary>
/// Sends rendered pages straight to a Windows print queue.
///
/// No dialog, no other application, nothing for anyone at the counter to click.
/// This replaces ShellExecute's "print" verb, which does not print a file so
/// much as ask whichever program owns that file type to print it — and for an
/// image that program is the Windows Photo Printing Wizard, which opened on a
/// shop's counter PC, offered a paper type of "Labels", and sat there waiting
/// for the owner to press Print on every single customer job.
///
/// Printing here also means the agent can honour what the customer actually
/// paid for. The shell verb took no options at all, so colour, duplex and paper
/// size were whatever the printer driver happened to default to, regardless of
/// what was chosen and charged for at checkout.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class WindowsRasterPrinter
{
    public static bool Print(
        DocumentRasterizer document,
        PrintOptions options,
        string? printerName,
        ILogger logger)
    {
        var settings = new PrinterSettings();
        if (!string.IsNullOrWhiteSpace(printerName))
        {
            settings.PrinterName = printerName;
        }

        if (!settings.IsValid)
        {
            logger.LogError(
                "Windows has no printer called '{Printer}'. Choose one in the agent's Settings tab.",
                printerName);
            return false;
        }

        // The spooler collates copies itself, so this stays one job rather than
        // the one-job-per-copy the shell verb forced.
        settings.Copies = (short)Math.Clamp(options.Copies, 1, short.MaxValue);

        if (options.IsDuplex)
        {
            if (settings.CanDuplex)
            {
                settings.Duplex = Duplex.Vertical; // long edge, as a book opens
            }
            else
            {
                // Said out loud rather than silently printing single-sided: the
                // customer was charged a duplex rate for this.
                logger.LogWarning(
                    "'{Printer}' cannot print double-sided, so this job prints single-sided.",
                    settings.PrinterName);
            }
        }

        using var doc = new PrintDocument { PrinterSettings = settings, DocumentName = options.FileName };
        doc.DefaultPageSettings.Color = options.IsColor && settings.SupportsColor;
        doc.OriginAtMargins = false;

        ApplyPaperSize(doc, options.PaperSize, logger);

        int page = 0;
        Exception? failure = null;

        doc.PrintPage += (_, e) =>
        {
            try
            {
                // Rendered here, one page at a time: a fifty-page PDF at 300dpi
                // is about 35MB a page, and holding them all would be worse
                // than anything it saves.
                byte[] png = document.RenderPagePng(page);
                using var stream = new MemoryStream(png);
                using var image = Image.FromStream(stream);

                e.Graphics?.DrawImage(image, FitWithin(image, e.PageBounds));

                page++;
                e.HasMorePages = page < document.PageCount;
            }
            catch (Exception ex)
            {
                // Throwing out of PrintPage tears down the print controller in a
                // way that reports nothing useful, so it is captured and
                // rethrown once the job has been stopped cleanly.
                failure = ex;
                e.Cancel = true;
            }
        };

        try
        {
            doc.Print();
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Windows refused the print job for '{FileName}'.", options.FileName);
            return false;
        }

        if (failure is not null)
        {
            logger.LogError(failure, "Page {Page} of '{FileName}' could not be rendered.", page + 1, options.FileName);
            return false;
        }

        logger.LogInformation(
            "'{FileName}' sent to '{Printer}': {Pages} page(s), {Copies} copy/copies, {Colour}, {Sides}.",
            options.FileName, settings.PrinterName, document.PageCount, settings.Copies,
            doc.DefaultPageSettings.Color ? "colour" : "black and white",
            settings.Duplex == Duplex.Simplex ? "single-sided" : "double-sided");

        return true;
    }

    /// <summary>
    /// Asks the driver for the paper the customer chose and paid for.
    ///
    /// A printer that has no such tray keeps its own default rather than
    /// failing the job: a print on the wrong paper is recoverable at the
    /// counter, a job that never printed is not.
    /// </summary>
    private static void ApplyPaperSize(PrintDocument doc, string? requested, ILogger logger)
    {
        if (string.IsNullOrWhiteSpace(requested)) return;

        var wanted = requested.Trim().ToUpperInvariant() switch
        {
            "A4" => PaperKind.A4,
            "A3" => PaperKind.A3,
            "A5" => PaperKind.A5,
            "LETTER" => PaperKind.Letter,
            "LEGAL" => PaperKind.Legal,
            _ => PaperKind.Custom,
        };

        if (wanted == PaperKind.Custom)
        {
            logger.LogWarning("Unrecognised paper size '{Size}'; using the printer's default.", requested);
            return;
        }

        foreach (PaperSize size in doc.PrinterSettings.PaperSizes)
        {
            if (size.Kind != wanted) continue;
            doc.DefaultPageSettings.PaperSize = size;
            return;
        }

        logger.LogWarning(
            "'{Printer}' does not offer {Size} paper; using its default instead.",
            doc.PrinterSettings.PrinterName, requested);
    }

    /// <summary>
    /// The largest the page fits at without distorting it.
    ///
    /// Aspect ratio is preserved rather than stretched to the sheet: a customer
    /// who uploads a portrait photo and gets it squashed to fill A4 has been
    /// charged for a print they cannot use.
    /// </summary>
    private static Rectangle FitWithin(Image image, Rectangle bounds)
    {
        double scale = Math.Min(
            (double)bounds.Width / image.Width,
            (double)bounds.Height / image.Height);

        int width = Math.Max(1, (int)Math.Round(image.Width * scale));
        int height = Math.Max(1, (int)Math.Round(image.Height * scale));

        return new Rectangle(
            bounds.X + (bounds.Width - width) / 2,
            bounds.Y + (bounds.Height - height) / 2,
            width, height);
    }
}
