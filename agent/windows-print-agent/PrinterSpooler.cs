using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;
using PrintOk.WindowsPrintAgent.Models;

namespace PrintOk.WindowsPrintAgent.Services;

public interface IPrinterSpooler
{
    Task<bool> PrintDocumentAsync(string tempFilePath, string fileName, int copies, bool isColor, CancellationToken cancellationToken);
}

public class WindowsPrinterSpooler : IPrinterSpooler
{
    private readonly ILogger<WindowsPrinterSpooler> _logger;
    private readonly AgentSettings _settings;

    public WindowsPrinterSpooler(ILogger<WindowsPrinterSpooler> logger, AgentSettings settings)
    {
        _logger = logger;
        _settings = settings;
    }

    public async Task<bool> PrintDocumentAsync(string tempFilePath, string fileName, int copies, bool isColor, CancellationToken cancellationToken)
    {
        int copyCount = Math.Max(1, copies);

        _logger.LogInformation(
            "Spooling '{FileName}' ({Copies} copies, Color: {IsColor}) to printer '{Printer}'...",
            fileName, copyCount, isColor, _settings.PrinterName ?? "(system default)");

        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            _logger.LogInformation("[Cross-Platform Simulation Mode] Simulating print of '{FileName}'.", fileName);
            await Task.Delay(500, cancellationToken);
            return true;
        }

        // The Windows shell print verbs spool a single copy per invocation, so issue
        // one job per requested copy rather than silently printing just one.
        for (int copy = 1; copy <= copyCount; copy++)
        {
            if (!await SpoolSingleCopyAsync(tempFilePath, fileName, copy, copyCount, cancellationToken))
            {
                return false;
            }
        }

        _logger.LogInformation("All {Copies} copy/copies of '{FileName}' handed to the Windows spooler.", copyCount, fileName);
        return true;
    }

    private async Task<bool> SpoolSingleCopyAsync(string tempFilePath, string fileName, int copy, int copyCount, CancellationToken cancellationToken)
    {
        // "printto" targets a named printer; "print" only ever reaches the machine
        // default, so it is a fallback for when no printer name is configured.
        bool hasNamedPrinter = !string.IsNullOrWhiteSpace(_settings.PrinterName);

        if (hasNamedPrinter && await TryRunPrintVerbAsync(tempFilePath, "printto", $"\"{_settings.PrinterName}\"", cancellationToken))
        {
            _logger.LogInformation("Copy {Copy}/{Total} of '{FileName}' spooled to '{Printer}'.", copy, copyCount, fileName, _settings.PrinterName);
            return true;
        }

        if (await TryRunPrintVerbAsync(tempFilePath, "print", null, cancellationToken))
        {
            _logger.LogInformation("Copy {Copy}/{Total} of '{FileName}' spooled to the default printer.", copy, copyCount, fileName);
            return true;
        }

        _logger.LogError(
            "Windows refused to print copy {Copy}/{Total} of '{FileName}'. No application is registered to print this file type, or the printer is unavailable.",
            copy, copyCount, fileName);
        return false;
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
