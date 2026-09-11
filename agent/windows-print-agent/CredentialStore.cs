using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace PrintOk.WindowsPrintAgent.Services;

/// <summary>
/// Device credentials as stored on disk.
/// </summary>
public sealed record StoredCredentials(
    string DeviceId,
    string DeviceToken,
    string PrinterId,
    string ShopId,
    string ApiBaseUrl,
    DateTimeOffset? TokenExpiresAt
);

/// <summary>
/// Persists the agent's device token (PRD 7.2).
///
/// On Windows the token is encrypted with DPAPI under the current user account,
/// so the file is unreadable to other users on the shop PC and unusable if
/// copied to another machine. Plaintext fallback is used only on non-Windows
/// platforms, which exist here for development and cross-platform testing.
///
/// The token is written once at pairing. It is never logged, and never placed in
/// appsettings.json where a screenshot or support upload would expose it.
/// </summary>
public class CredentialStore
{
    private readonly ILogger<CredentialStore> _logger;
    private readonly string _credentialPath;

    /// <summary>Ties the ciphertext to this application, so another DPAPI caller cannot decrypt it.</summary>
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("PrintOk.WindowsPrintAgent.DeviceCredentials.v1");

    public CredentialStore(ILogger<CredentialStore> logger, string? overridePath = null)
    {
        _logger = logger;
        _credentialPath = overridePath ?? DefaultCredentialPath();
    }

    public string Path => _credentialPath;

    private static string DefaultCredentialPath()
    {
        // Per-user application data, not the install directory: the install
        // directory is often world-readable and may be synced or backed up.
        string baseDir = Environment.GetFolderPath(
            Environment.SpecialFolder.LocalApplicationData,
            Environment.SpecialFolderOption.Create);

        if (string.IsNullOrWhiteSpace(baseDir))
        {
            baseDir = AppContext.BaseDirectory;
        }

        return System.IO.Path.Combine(baseDir, "PrintOk", "credentials.dat");
    }

    public bool Exists() => File.Exists(_credentialPath);

    public async Task SaveAsync(StoredCredentials credentials, CancellationToken cancellationToken = default)
    {
        string? directory = System.IO.Path.GetDirectoryName(_credentialPath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        byte[] plaintext = JsonSerializer.SerializeToUtf8Bytes(credentials);

        if (OperatingSystem.IsWindows())
        {
            byte[] encrypted = ProtectedData.Protect(plaintext, Entropy, DataProtectionScope.CurrentUser);
            await File.WriteAllBytesAsync(_credentialPath, encrypted, cancellationToken);
            _logger.LogInformation("Device credentials saved (DPAPI, current user) to {Path}.", _credentialPath);
        }
        else
        {
            await File.WriteAllBytesAsync(_credentialPath, plaintext, cancellationToken);
            RestrictToOwner(_credentialPath);
            _logger.LogWarning(
                "Device credentials saved WITHOUT encryption to {Path}. DPAPI is Windows-only; " +
                "this path is intended for development.", _credentialPath);
        }
    }

    public async Task<StoredCredentials?> LoadAsync(CancellationToken cancellationToken = default)
    {
        if (!Exists())
        {
            return null;
        }

        try
        {
            byte[] stored = await File.ReadAllBytesAsync(_credentialPath, cancellationToken);

            byte[] plaintext = OperatingSystem.IsWindows()
                ? ProtectedData.Unprotect(stored, Entropy, DataProtectionScope.CurrentUser)
                : stored;

            return JsonSerializer.Deserialize<StoredCredentials>(plaintext);
        }
        catch (CryptographicException ex)
        {
            // DPAPI ciphertext is bound to the user account that wrote it, so this
            // usually means the agent is now running as a different user.
            _logger.LogError(
                ex,
                "Stored credentials could not be decrypted. They were saved by a different Windows " +
                "user account. Re-pair this agent with a fresh pairing code from the dashboard.");
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Stored credentials at {Path} are unreadable or corrupt.", _credentialPath);
            return null;
        }
    }

    public void Delete()
    {
        if (!Exists()) return;

        try
        {
            File.Delete(_credentialPath);
            _logger.LogInformation("Device credentials removed from {Path}.", _credentialPath);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to remove credentials at {Path}.", _credentialPath);
        }
    }

    /// <summary>Owner-only permissions for the non-Windows development path.</summary>
    private static void RestrictToOwner(string path)
    {
        if (OperatingSystem.IsWindows()) return;

        try
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        catch (PlatformNotSupportedException)
        {
            // Best effort only.
        }
    }
}
