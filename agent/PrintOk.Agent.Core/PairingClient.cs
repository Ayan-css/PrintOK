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

/// <summary>Why a pairing attempt did not produce a credential.</summary>
public enum PairFailure
{
    None,
    /// <summary>The API could not be reached at all — DNS, firewall, wrong URL, no internet.</summary>
    Unreachable,
    /// <summary>The API answered and said no — expired, already used, or unknown code.</summary>
    Refused,
    /// <summary>The API answered 2xx but the body was not a usable credential.</summary>
    MalformedResponse,
}

/// <summary>
/// The outcome of one pairing attempt.
///
/// The distinction matters to the person standing at the counter: "could not
/// reach the server" and "the server rejected your code" need opposite
/// remedies, and telling someone to generate a fresh code when the request
/// never left their PC sends them round a loop that cannot succeed.
/// </summary>
public sealed record PairResult(StoredCredentials? Credentials, PairFailure Failure)
{
    public static PairResult Ok(StoredCredentials credentials) => new(credentials, PairFailure.None);
    public static PairResult Failed(PairFailure failure) => new(null, failure);
}

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

    public async Task<PairResult> PairAsync(
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
                return PairResult.Failed(PairFailure.Refused);
            }

            var paired = await response.Content.ReadFromJsonAsync<PairResponse>(cancellationToken: cancellationToken);
            if (paired is null || string.IsNullOrWhiteSpace(paired.DeviceToken))
            {
                _logger.LogError("Pairing succeeded but the server returned no device token.");
                return PairResult.Failed(PairFailure.MalformedResponse);
            }

            _logger.LogInformation(
                "Paired successfully. Device {DeviceId} is now bound to printer {PrinterId}.",
                paired.DeviceId, paired.PrinterId);

            return PairResult.Ok(new StoredCredentials(
                paired.DeviceId,
                paired.DeviceToken,
                paired.PrinterId,
                paired.ShopId,
                // Trust the server's canonical URL when it supplies one.
                string.IsNullOrWhiteSpace(paired.ApiBaseUrl) ? apiBaseUrl : paired.ApiBaseUrl!,
                paired.TokenExpiresAt));
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            // The request never got an answer, so nothing was spent: the pairing
            // code is still valid and re-issuing one will not help.
            _logger.LogError(ex, "Could not reach the PrintOk API at {ApiBaseUrl} to pair.", apiBaseUrl);
            return PairResult.Failed(PairFailure.Unreachable);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Pairing against {ApiBaseUrl} failed unexpectedly.", apiBaseUrl);
            return PairResult.Failed(PairFailure.MalformedResponse);
        }
    }
}

/// <summary>Agent version reported to the backend for fleet visibility (PRD 8).</summary>
public static class AgentVersion
{
    public static string Current =>
        typeof(AgentVersion).Assembly.GetName().Version?.ToString(3) ?? "unknown";
}
