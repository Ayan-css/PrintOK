using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using PrintOk.WindowsPrintAgent.Models;

namespace PrintOk.WindowsPrintAgent.Services;

public interface IPrinterSpooler
{
    Task<bool> PrintDocumentAsync(string tempFilePath, PrintOptions options, CancellationToken cancellationToken);
}

public class WindowsPrinterSpooler : IPrinterSpooler
{
    /// <summary>
    /// Formats that need another application installed to print at all.
    ///
    /// Word and Excel do print silently through the "printto" verb, so these
    /// still go through the shell — but only these. Everything a customer can
    /// actually upload in bulk (PDFs and images) is rendered by the agent.
    /// </summary>
    private static readonly HashSet<string> ShellPrintable = new(StringComparer.OrdinalIgnoreCase)
    {
        ".doc", ".docx", ".xls", ".xlsx", ".csv", ".ppt", ".pptx", ".txt", ".rtf",
    };

    private readonly ILogger<WindowsPrinterSpooler> _logger;
    private readonly AgentSettings _settings;

    public WindowsPrinterSpooler(ILogger<WindowsPrinterSpooler> logger, AgentSettings settings)
    {
        _logger = logger;
        _settings = settings;
    }

    public async Task<bool> PrintDocumentAsync(
        string tempFilePath, PrintOptions options, CancellationToken cancellationToken)
    {
        _logger.LogInformation(
            "Printing '{FileName}': {Copies} copy/copies, {Colour}, {Sides}, {Paper}, to '{Printer}'.",
            options.FileName,
            Math.Max(1, options.Copies),
            options.IsColor ? "colour" : "black and white",
            options.IsDuplex ? "double-sided" : "single-sided",
            options.PaperSize ?? "printer default",
            _settings.PrinterName ?? "(system default)");

        // OperatingSystem.IsWindows rather than RuntimeInformation: they mean the
        // same thing, but only this one narrows the platform for the analyser,
        // which is what lets the Windows-only printing below be called at all.
        if (!OperatingSystem.IsWindows())
        {
            _logger.LogInformation("[Cross-Platform Simulation Mode] Simulating print of '{FileName}'.", options.FileName);
            await Task.Delay(500, cancellationToken);
            return true;
        }

        // Rendered by the agent, which is the only way this prints without a
        // person at the counter clicking through a dialog.
        if (DocumentRasterizer.CanRender(tempFilePath))
        {
            // The guard is repeated inside the lambda because the analyser does
            // not carry the one above across the closure boundary.
            return await Task.Run(
                () => OperatingSystem.IsWindows() && RenderAndPrint(tempFilePath, options, cancellationToken),
                cancellationToken);
        }

        string extension = Path.GetExtension(tempFilePath);
        if (!ShellPrintable.Contains(extension))
        {
            // Better to fail the job with a reason than to open something on the
            // counter PC and leave it sitting there.
            _logger.LogError(
                "The agent cannot print '{Extension}' files. '{FileName}' was not printed.",
                extension, options.FileName);
            return false;
        }

        return await PrintViaInstalledApplicationAsync(tempFilePath, options, cancellationToken);
    }

    /// <summary>
    /// Draws the document and sends it to the print queue.
    /// </summary>
    /// <remarks>
    /// A method of its own, and annotated, because the platform analyser does
    /// not carry an OperatingSystem.IsWindows() guard across a lambda boundary
    /// — and this runs inside a Task.Run so that rendering a long PDF does not
    /// block the polling loop.
    /// </remarks>
    [SupportedOSPlatform("windows")]
    private bool RenderAndPrint(
        string tempFilePath, PrintOptions options, CancellationToken cancellationToken)
    {
        using DocumentRasterizer? document = DocumentRasterizer.Open(tempFilePath, _logger);
        if (document is null)
        {
            _logger.LogError("'{FileName}' could not be read as a document or an image.", options.FileName);
            return false;
        }

        return WindowsRasterPrinter.Print(
            document, options, _settings.PrinterName, _logger, cancellationToken);
    }

    /// <summary>
    /// Office documents, handed to Word or Excel.
    ///
    /// The "printto" verb prints to a named printer without showing anything,
    /// which is why it is still used here — but only for formats the agent
    /// cannot render itself, and only when an application is actually
    /// registered for them.
    /// </summary>
    private async Task<bool> PrintViaInstalledApplicationAsync(
        string tempFilePath, PrintOptions options, CancellationToken cancellationToken)
    {
        int copyCount = Math.Max(1, options.Copies);

        // The "printto" verb carries a printer name and nothing else. Word
        // prints with its own saved settings, so colour, sides, paper,
        // orientation and page range are all whatever that installation happens
        // to default to — regardless of what the customer chose and paid for.
        //
        // Said out loud rather than failing the job: refusing to print a .docx
        // is worse for the shop than printing one whose options were not
        // honoured. A shop that sees this in its log knows to ask for PDFs,
        // which the agent renders itself and controls completely.
        if (!options.IsColor || options.IsDuplex || options.Orientation != PrintOrientation.Auto
            || options.Pages is { Count: > 0 } || !string.IsNullOrWhiteSpace(options.PaperSize))
        {
            _logger.LogWarning(
                "'{FileName}' is being printed by another application, which ignores the customer's "
                + "choices: black and white, sides, paper size, orientation and page selection are "
                + "left to that application's own defaults. Ask the customer for a PDF to have these honoured.",
                options.FileName);
        }

        // These applications spool one copy per invocation.
        for (int copy = 1; copy <= copyCount; copy++)
        {
            bool named = !string.IsNullOrWhiteSpace(_settings.PrinterName);

            if (named && await TryRunPrintVerbAsync(tempFilePath, "printto", $"\"{_settings.PrinterName}\"", cancellationToken))
            {
                continue;
            }

            if (await TryRunPrintVerbAsync(tempFilePath, "print", null, cancellationToken))
            {
                continue;
            }

            _logger.LogError(
                "Nothing on this PC is registered to print '{FileName}'. Install the application that opens "
                + "this file type, or ask the customer for a PDF.",
                options.FileName);
            return false;
        }

        _logger.LogInformation("All {Copies} copy/copies of '{FileName}' handed to the spooler.", copyCount, options.FileName);
        return true;
    }

    private async Task<bool> TryRunPrintVerbAsync(string tempFilePath, string verb, string? arguments, CancellationToken cancellationToken)
    {
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = tempFilePath,
                Verb = verb,
                UseShellExecute = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            if (arguments != null)
            {
                startInfo.Arguments = arguments;
            }

            using var process = Process.Start(startInfo);
            if (process == null)
            {
                _logger.LogWarning("Shell verb '{Verb}' did not start a handler process.", verb);
                return false;
            }

            // Some handlers (Acrobat, Word) linger after spooling; cap the wait rather
            // than blocking the whole job queue on a viewer that never exits.
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromMinutes(2));

            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                _logger.LogWarning("Print handler for verb '{Verb}' is still open after 2 minutes; assuming the document was spooled.", verb);
            }

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Shell verb '{Verb}' failed: {Message}", verb, ex.Message);
            return false;
        }
    }
}
