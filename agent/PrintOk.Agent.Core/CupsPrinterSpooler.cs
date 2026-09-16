using System.Diagnostics;
using Microsoft.Extensions.Logging;
using PrintOk.WindowsPrintAgent.Models;

namespace PrintOk.WindowsPrintAgent.Services;

/// <summary>
/// Printing on Linux and macOS, through CUPS.
///
/// The Windows spooler shells out to the shell's print verbs, which do not
/// exist here. CUPS does the same job through <c>lp</c>, and does it better:
/// copies, colour mode and the target printer are all flags on one invocation,
/// so a three-copy job is one spool entry rather than three.
///
/// This exists so the agent can be developed and tested on a Linux machine
/// without a Windows PC in the loop. It is a peer of the Windows implementation
/// rather than a replacement — <see cref="WindowsPrinterSpooler"/> is untouched,
/// and which one runs is decided once at startup by the host OS.
/// </summary>
public class CupsPrinterSpooler : IPrinterSpooler
{
    private readonly ILogger<CupsPrinterSpooler> _logger;
    private readonly AgentSettings _settings;

    public CupsPrinterSpooler(ILogger<CupsPrinterSpooler> logger, AgentSettings settings)
    {
        _logger = logger;
        _settings = settings;
    }

    public async Task<bool> PrintDocumentAsync(
        string tempFilePath, PrintOptions options, CancellationToken cancellationToken)
    {
        string fileName = options.FileName;
        int copyCount = Math.Max(1, options.Copies);

        _logger.LogInformation(
            "Spooling '{FileName}' to CUPS printer '{Printer}': {Copies} copy/copies, {Colour}, {Sides}, {Paper}.",
            fileName, _settings.PrinterName ?? "(system default)", copyCount,
            options.IsColor ? "colour" : "black and white",
            options.IsDuplex ? "double-sided" : "single-sided",
            options.PaperSize ?? "printer default");

        var args = new List<string>();

        // Without -d, lp uses the system default printer, which is the right
        // behaviour when a shop has only one.
        if (!string.IsNullOrWhiteSpace(_settings.PrinterName))
        {
            args.Add("-d");
            args.Add(_settings.PrinterName!);
        }

        // CUPS handles copies itself, so unlike Windows this is one job.
        args.Add("-n");
        args.Add(copyCount.ToString());

        // The IPP standard option. A mono-only printer simply ignores the
        // colour request rather than failing, which is what we want — the
        // customer has already been charged at the rate they chose.
        args.Add("-o");
        args.Add(options.IsColor ? "print-color-mode=color" : "print-color-mode=monochrome");

        // Duplex and paper were never sent, so a customer who chose and paid for
        // A4 double-sided got whatever the queue's defaults were.
        args.Add("-o");
        args.Add(options.IsDuplex ? "sides=two-sided-long-edge" : "sides=one-sided");

        if (!string.IsNullOrWhiteSpace(options.PaperSize))
        {
            // A printer with no such tray ignores this rather than refusing the
            // job: wrong paper is fixable at the counter, a job that never
            // printed is not.
            args.Add("-o");
            args.Add($"media={options.PaperSize}");
        }

        // Names the job in the CUPS queue, so `lpstat` shows something a shop
        // owner recognises instead of the temp file's random name.
        args.Add("-t");
        args.Add(fileName);

        args.Add(tempFilePath);

        try
        {
            var psi = new ProcessStartInfo("lp")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);

            using var process = Process.Start(psi);
            if (process is null)
            {
                _logger.LogError("Could not start 'lp'. Is CUPS installed?");
                return false;
            }

            string stdout = await process.StandardOutput.ReadToEndAsync(cancellationToken);
            string stderr = await process.StandardError.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken);

            if (process.ExitCode != 0)
            {
                _logger.LogError(
                    "lp refused the job for '{FileName}' (exit {Exit}): {Error}",
                    fileName, process.ExitCode, string.IsNullOrWhiteSpace(stderr) ? "(no output)" : stderr.Trim());
                return false;
            }

            // lp prints "request id is Printer-123 (1 file(s))" — worth keeping,
            // because that id is what `lpstat` and `cancel` take.
            _logger.LogInformation(
                "CUPS accepted '{FileName}': {Response}", fileName, stdout.Trim());
            return true;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // The usual cause on a fresh machine, and worth naming precisely
            // rather than reporting as a generic print failure.
            _logger.LogError(
                "'lp' was not found. Install CUPS (Arch: sudo pacman -S cups, then " +
                "sudo systemctl enable --now cups) and check 'lpstat -p' lists a printer.");
            return false;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to spool '{FileName}' through CUPS.", fileName);
            return false;
        }
    }

    /// <summary>
    /// Whether anything is actually printable here.
    ///
    /// Reported at startup rather than discovered on the first real job, so a
    /// machine with no configured printer says so before a customer has paid.
    /// </summary>
    public static async Task<string?> DescribeDefaultPrinterAsync(CancellationToken cancellationToken)
    {
        try
        {
            var psi = new ProcessStartInfo("lpstat")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add("-p");
            psi.ArgumentList.Add("-d");

            using var process = Process.Start(psi);
            if (process is null) return null;

            string stdout = await process.StandardOutput.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken);

            if (process.ExitCode != 0 || string.IsNullOrWhiteSpace(stdout)) return null;

            var lines = stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            return lines.Length == 0 ? null : string.Join("; ", lines.Take(3));
        }
        catch
        {
            return null;
        }
    }
}
