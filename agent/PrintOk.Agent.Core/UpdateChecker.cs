using System.Diagnostics;
using System.Security.Cryptography;
using PrintOk.WindowsPrintAgent.Services;

namespace PrintOk.Agent.Core;

/// <summary>
/// Learns whether a newer agent build has been published, and — when told to —
/// installs it.
///
/// This is the most dangerous class in the agent, and the design follows from
/// that. Whatever it runs, runs as a service on a shop's counter PC, beside the
/// documents customers have paid to print. Everything below assumes the server
/// might be lying, because the whole point of an update channel is that one
/// compromised response reaches every machine at once.
///
/// Three independent gates, each of which alone is sufficient to refuse:
///
///   1. <b>The download host is decided here, not by the server.</b> A manifest
///      naming any other host is discarded. A server that has been taken over
///      cannot point the fleet at an attacker's binary, because the agent will
///      not fetch from it whatever the manifest says.
///   2. <b>The bytes are hashed before anything executes.</b> The server states
///      a SHA-256 up front; the downloaded file must match it exactly. This is
///      what makes a tampered release fail closed rather than install.
///   3. <b>Only strictly newer versions install.</b> A downgrade is how a known
///      defect gets reintroduced deliberately, so it is refused.
///
/// What this is NOT: code signing. A signed installer verified against a
/// certificate would also prove the build came from PrintOk rather than merely
/// matching a hash the same server supplied. Until there is a certificate, gate
/// 1 is what carries that weight, which is why the host list is compiled in.
/// </summary>
public sealed class UpdateChecker
{
    /// <summary>
    /// Hosts an installer may be downloaded from, whatever the manifest says.
    ///
    /// Compiled in on purpose. Every other setting the agent has can be edited
    /// by whoever is sitting at the PC; this one decides what code runs, so it
    /// is the one thing that should require a new build to change.
    /// </summary>
    private static readonly string[] AllowedDownloadHosts =
    {
        "github.com",
        "objects.githubusercontent.com",
    };

    private readonly HttpClient _http;
    private readonly string _currentVersion;

    public UpdateChecker(HttpClient http, string? currentVersion = null)
    {
        _http = http;
        _currentVersion = currentVersion ?? AgentVersion.Current;
    }

    /// <summary>
    /// Whether a manifest describes an update this agent is willing to take,
    /// and if not, why. The reason is returned rather than logged so the tray
    /// can show it: an update silently not happening is how a fleet quietly
    /// stops being patched.
    /// </summary>
    public UpdateDecision Evaluate(UpdateManifest? manifest)
    {
        if (manifest is null || manifest.UpToDate)
        {
            return UpdateDecision.None("This agent is up to date.");
        }

        if (string.IsNullOrWhiteSpace(manifest.Version))
        {
            return UpdateDecision.Refused("The server offered an update without saying which version.");
        }

        if (CompareVersions(manifest.Version, _currentVersion) <= 0)
        {
            // Not an error: a manifest can race a just-completed update.
            return UpdateDecision.None($"Already on {_currentVersion}.");
        }

        if (string.IsNullOrWhiteSpace(manifest.Sha256) || !IsSha256(manifest.Sha256))
        {
            return UpdateDecision.Refused(
                "The published update has no usable checksum, so its contents cannot be verified. Nothing was downloaded.");
        }

        if (!IsAllowedDownload(manifest.DownloadUrl, out string? why))
        {
            return UpdateDecision.Refused(why!);
        }

        return UpdateDecision.Available(manifest);
    }

    /// <summary>
    /// Whether the agent may fetch an installer from this address.
    ///
    /// The mirror of AgentSettings' API host allowlist, and separate from it on
    /// purpose: being willing to talk to a server is a smaller decision than
    /// being willing to execute what it sends.
    /// </summary>
    public static bool IsAllowedDownload(string? url, out string? problem)
    {
        problem = null;

        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url, UriKind.Absolute, out Uri? uri))
        {
            problem = "The published update has no valid download address.";
            return false;
        }

        if (uri.Scheme != Uri.UriSchemeHttps)
        {
            problem = "An update may only be downloaded over https, so it cannot be replaced in transit.";
            return false;
        }

        if (!AllowedDownloadHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase))
        {
            problem =
                $"This agent will not download an update from '{uri.Host}'. Installers come only from "
                + "PrintOk's published releases, so a server that has been tampered with cannot make "
                + "this machine run something else.";
            return false;
        }

        return true;
    }

    /// <summary>
    /// Downloads the installer and returns its path once the bytes match the
    /// published checksum.
    ///
    /// Downloads to a fresh temporary file rather than over the existing one: a
    /// half-written installer that is never executed is harmless, whereas a
    /// half-overwritten one is a machine that cannot repair itself.
    /// </summary>
    public async Task<DownloadResult> DownloadVerifiedAsync(
        UpdateManifest manifest, CancellationToken cancellationToken = default)
    {
        if (!IsAllowedDownload(manifest.DownloadUrl, out string? why))
        {
            return DownloadResult.Failed(why!);
        }

        string directory = Path.Combine(Path.GetTempPath(), "PrintOkUpdate");
        Directory.CreateDirectory(directory);
        string target = Path.Combine(directory, $"PrintOkAgent-{manifest.Version}.exe");

        try
        {
            using (HttpResponseMessage response = await _http.GetAsync(
                manifest.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken))
            {
                if (!response.IsSuccessStatusCode)
                {
                    return DownloadResult.Failed(
                        $"The update could not be downloaded ({(int)response.StatusCode}). Nothing has changed.");
                }

                await using Stream incoming = await response.Content.ReadAsStreamAsync(cancellationToken);
                await using var file = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None);
                await incoming.CopyToAsync(file, cancellationToken);
            }

            string actual = await ComputeSha256Async(target, cancellationToken);
            if (!actual.Equals(manifest.Sha256!.Trim().ToLowerInvariant(), StringComparison.Ordinal))
            {
                // Deleted rather than kept for inspection: a file that does not
                // match what was published is either corrupt or hostile, and
                // neither is something to leave on a shop's PC.
                TryDelete(target);
                return DownloadResult.Failed(
                    "The downloaded update did not match its published checksum, so it was discarded "
                    + "without being run. This agent has not been changed.");
            }

            return DownloadResult.Verified(target);
        }
        catch (OperationCanceledException)
        {
            TryDelete(target);
            throw;
        }
        catch (Exception ex)
        {
            TryDelete(target);
            return DownloadResult.Failed($"The update could not be downloaded: {ex.Message}");
        }
    }

    /// <summary>
    /// Hands a verified installer to Windows and returns.
    ///
    /// A running executable cannot replace itself, so the installer does it:
    /// started detached, it stops the service, swaps the files and starts it
    /// again. Credentials live in %LOCALAPPDATA%\PrintOk and are untouched by
    /// that, so the shop does not re-pair.
    ///
    /// Untested against a real Windows install — see docs/agent-updates.md.
    /// </summary>
    public static LaunchResult LaunchInstaller(string installerPath)
    {
        if (!File.Exists(installerPath))
        {
            return LaunchResult.Failed("The verified installer is no longer on disk.");
        }

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = installerPath,
                // Silent, because nobody is watching a counter PC at 3am, and a
                // dialog waiting for OK is an update that never completes.
                Arguments = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART",
                UseShellExecute = true,
            };

            Process? process = Process.Start(startInfo);
            return process is null
                ? LaunchResult.Failed("Windows did not start the installer.")
                : LaunchResult.Started();
        }
        catch (Exception ex)
        {
            return LaunchResult.Failed($"The installer could not be started: {ex.Message}");
        }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { /* best effort */ }
    }

    public static async Task<string> ComputeSha256Async(
        string path, CancellationToken cancellationToken = default)
    {
        await using var stream = File.OpenRead(path);
        using var sha = SHA256.Create();
        byte[] hash = await sha.ComputeHashAsync(stream, cancellationToken);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    public static bool IsSha256(string? value)
    {
        string v = (value ?? string.Empty).Trim();
        return v.Length == 64 && v.All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'));
    }

    /// <summary>
    /// Compares dotted versions numerically.
    ///
    /// String comparison is the obvious implementation and it is wrong in a way
    /// that only shows up after ten releases: "1.10.0" sorts before "1.9.0".
    /// A fleet would stop upgrading at 1.9 and every device would report itself
    /// current. Mirrors compareAgentVersions in @printok/shared-types.
    /// </summary>
    public static int CompareVersions(string? a, string? b)
    {
        int[] Parts(string? v) => (v ?? string.Empty)
            .Trim()
            .Split('.')
            .Select(piece => int.TryParse(piece, out int n) && n >= 0 ? n : -1)
            .ToArray();

        int[] left = Parts(a);
        int[] right = Parts(b);

        for (int i = 0; i < Math.Max(left.Length, right.Length); i++)
        {
            int l = i < left.Length ? left[i] : 0;
            int r = i < right.Length ? right[i] : 0;
            if (l != r) return l - r;
        }

        return 0;
    }
}

/// <summary>What the server says about updates. Mirrors AgentUpdateManifest.</summary>
public sealed class UpdateManifest
{
    public bool UpToDate { get; set; }
    public string? Version { get; set; }
    public string? DownloadUrl { get; set; }
    public string? Sha256 { get; set; }
    /// <summary>"notify" or "auto". Anything else is treated as notify.</summary>
    public string? Mode { get; set; }
    public string? Notes { get; set; }

    public bool IsAutomatic => string.Equals(Mode, "auto", StringComparison.OrdinalIgnoreCase);
}

public enum UpdateOutcome { None, Available, Refused }

public sealed record UpdateDecision(UpdateOutcome Outcome, string Message, UpdateManifest? Manifest)
{
    public static UpdateDecision None(string message) => new(UpdateOutcome.None, message, null);
    public static UpdateDecision Refused(string message) => new(UpdateOutcome.Refused, message, null);
    public static UpdateDecision Available(UpdateManifest manifest) =>
        new(UpdateOutcome.Available, $"Version {manifest.Version} is available.", manifest);

    public bool ShouldInstall => Outcome == UpdateOutcome.Available && Manifest?.IsAutomatic == true;
}

public sealed record DownloadResult(bool Ok, string? Path, string? Error)
{
    public static DownloadResult Verified(string path) => new(true, path, null);
    public static DownloadResult Failed(string error) => new(false, null, error);
}

public sealed record LaunchResult(bool Ok, string? Error)
{
    public static LaunchResult Started() => new(true, null);
    public static LaunchResult Failed(string error) => new(false, error);
}
