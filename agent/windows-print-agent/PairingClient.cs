using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace PrintOk.WindowsPrintAgent.Services;

public record PairResponse(
    [property: JsonPropertyName("deviceId")] string DeviceId,
    [property: JsonPropertyName("deviceToken")] string DeviceToken,
    [property: JsonPropertyName("printerId")] string PrinterId,
    [property: JsonPropertyName("shopId")] string ShopId,
    [property: JsonPropertyName("apiBaseUrl")] string? ApiBaseUrl,
    [property: JsonPropertyName("tokenExpiresAt")] DateTimeOffset? TokenExpiresAt
);

/// <summary>
/// Exchanges a short-lived pairing code for this machine's own device token
/// (PRD 7.1).
///
/// Pairing replaces handing every shop PC the printer's shared API key: the
/// resulting token identifies one install and can be revoked on its own from the
/// dashboard without disturbing any other machine.
/// </summary>
public class PairingClient
{
    private readonly ILogger<PairingClient> _logger;
    private readonly HttpClient _httpClient;

    public PairingClient(ILogger<PairingClient> logger, HttpClient httpClient)
    {
        _logger = logger;
        _httpClient = httpClient;
    }

    public async Task<StoredCredentials?> PairAsync(
        string pairingCode,
        string apiBaseUrl,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Pairing this machine with PrintOk using the supplied code...");

        var payload = new
        {
            pairingCode,
            deviceName = Environment.MachineName,
            osVersion = Environment.OSVersion.VersionString,
            agentVersion = AgentVersion.Current,
        };

        try
        {
            using var response = await _httpClient.PostAsJsonAsync("/api/agent/pair", payload, cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                string body = await response.Content.ReadAsStringAsync(cancellationToken);
                _logger.LogError(
                    "Pairing was refused ({Status}). Pairing codes are single use and expire after 15 minutes; " +
                    "generate a fresh one from the dashboard. Server said: {Body}",
                    (int)response.StatusCode, body);
                return null;
            }

            var paired = await response.Content.ReadFromJsonAsync<PairResponse>(cancellationToken: cancellationToken);
            if (paired is null || string.IsNullOrWhiteSpace(paired.DeviceToken))
            {
                _logger.LogError("Pairing succeeded but the server returned no device token.");
                return null;
            }

            _logger.LogInformation(
                "Paired successfully. Device {DeviceId} is now bound to printer {PrinterId}.",
                paired.DeviceId, paired.PrinterId);

            return new StoredCredentials(
                paired.DeviceId,
                paired.DeviceToken,
                paired.PrinterId,
                paired.ShopId,
                // Trust the server's canonical URL when it supplies one.
                string.IsNullOrWhiteSpace(paired.ApiBaseUrl) ? apiBaseUrl : paired.ApiBaseUrl!,
                paired.TokenExpiresAt);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not reach the PrintOk API at {ApiBaseUrl} to pair.", apiBaseUrl);
            return null;
        }
    }
}

/// <summary>Agent version reported to the backend for fleet visibility (PRD 8).</summary>
public static class AgentVersion
{
    public static string Current =>
        typeof(AgentVersion).Assembly.GetName().Version?.ToString(3) ?? "unknown";
}
