using Microsoft.Extensions.Configuration;

namespace PrintOk.WindowsPrintAgent.Models;

/// <summary>
/// Resolved agent configuration.
///
/// Settings are accepted in two shapes so that the appsettings.json a merchant
/// downloads from the dashboard works as-is:
///   * flat keys      - "PrintOkApiUrl", "AgentApiKey", ... (what /agent-config emits)
///   * nested section - "PrintOk": { "ApiBaseUrl": ..., "ApiKey": ... }
/// Command line (--AgentApiKey=...) and PRINTOK_-prefixed environment variables
/// override both, which lets the single-file executable run without any file.
/// </summary>
public sealed class AgentSettings
{
    public required string ApiBaseUrl { get; init; }
    public required string ApiKey { get; init; }
    public string? ShopId { get; init; }
    public string? PrinterId { get; init; }

    /// <summary>Windows printer to spool to. Empty means the machine default printer.</summary>
    public string? PrinterName { get; init; }

    public int PollIntervalMs { get; init; }
    public int HeartbeatIntervalMs { get; init; }

    /// <summary>One-time pairing code, supplied via --PairingCode=... on first run.</summary>
    public string? PairingCode { get; init; }

    /// <summary>Device-scoped token loaded from the credential store after pairing.</summary>
    public string? DeviceToken { get; set; }
    public string? DeviceId { get; set; }

    /// <summary>
    /// A device token is preferred; the shared printer key remains supported for
    /// installs that predate pairing.
    /// </summary>
    public bool HasDeviceToken => !string.IsNullOrWhiteSpace(DeviceToken);

    public bool IsConfigured =>
        HasDeviceToken || (!string.IsNullOrWhiteSpace(ApiKey) && ApiKey != PlaceholderApiKey);

    public const string PlaceholderApiKey = "PASTE_YOUR_AGENT_API_KEY_HERE";

    /// <summary>
    /// Where the agent looks when nothing else tells it otherwise.
    ///
    /// This was http://localhost:4000, which is only ever right on a developer's
    /// machine. The published .exe carries no appsettings.json - that file is
    /// deliberately left beside the executable so a merchant can drop in the one
    /// they download - so a shop that took the standalone executable had no
    /// source for this value at all and tried to pair against a server on its
    /// own PC, failing with "the target machine actively refused it".
    ///
    /// Shipping the production address as the compiled-in default makes the
    /// standalone download work unattended. Development still overrides it
    /// through appsettings.json, PRINTOK_PrintOkApiUrl, or --PrintOkApiUrl=.
    /// </summary>
    public const string DefaultApiBaseUrl = "https://prinok-api.onrender.com";

    public static AgentSettings FromConfiguration(IConfiguration config)
    {
        int heartbeatSeconds = ReadInt(config, 30, "HeartbeatIntervalSeconds", "PrintOk:HeartbeatIntervalSeconds");

        return new AgentSettings
        {
            ApiBaseUrl = Normalize(
                ReadString(config, "PrintOkApiUrl", "PrintOk:ApiBaseUrl", "ApiBaseUrl")
                ?? DefaultApiBaseUrl),
            ApiKey = ReadString(config, "AgentApiKey", "PrintOk:ApiKey", "ApiKey") ?? PlaceholderApiKey,
            ShopId = ReadString(config, "ShopId", "PrintOk:ShopId"),
            PrinterId = ReadString(config, "PrinterId", "PrintOk:PrinterId"),
            PrinterName = ReadString(config, "PrinterName", "PrintOk:PrinterName"),
            PollIntervalMs = ReadInt(config, 3000, "PollIntervalMs", "PrintOk:PollIntervalMs"),
            HeartbeatIntervalMs = heartbeatSeconds * 1000,
            PairingCode = ReadString(config, "PairingCode", "PrintOk:PairingCode")
        };
    }

    /// <summary>
    /// The WebSocket push endpoint, with no credential in it.
    ///
    /// The token used to be a query parameter, which put a live credential
    /// everywhere a URL goes: the agent's own log file (which INSTALL.md asks
    /// shop owners to send to support), proxy and gateway access logs, and any
    /// crash report quoting the endpoint. The server accepts the same
    /// credential as an x-agent-device-token / x-agent-api-key header, so the
    /// agent sends it that way instead — see <see cref="WebSocketAuthHeaders"/>.
    /// </summary>
    public Uri BuildWebSocketUri()
    {
        var builder = new UriBuilder(ApiBaseUrl)
        {
            Scheme = ApiBaseUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? "wss" : "ws",
            Path = "/ws/agent",
        };

        // UriBuilder re-adds the default HTTP port when swapping to ws/wss; drop it.
        if ((builder.Port == 80 || builder.Port == 443) && !ApiBaseUrl.Contains($":{builder.Port}"))
        {
            builder.Port = -1;
        }

        return builder.Uri;
    }

    /// <summary>
    /// Credential headers for the WebSocket handshake.
    ///
    /// A device token is preferred; the shared printer key remains supported
    /// for installs that predate pairing. Either way it travels in a header
    /// rather than the URL, so it does not end up in logs.
    /// </summary>
    public IEnumerable<KeyValuePair<string, string>> WebSocketAuthHeaders()
    {
        if (HasDeviceToken)
        {
            yield return new KeyValuePair<string, string>("x-agent-device-token", DeviceToken!);
        }
        else
        {
            yield return new KeyValuePair<string, string>("x-agent-api-key", ApiKey);
        }
    }

    private static string? ReadString(IConfiguration config, params string[] keys)
    {
        foreach (string key in keys)
        {
            string? value = config[key];
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value.Trim();
            }
        }

        return null;
    }

    private static int ReadInt(IConfiguration config, int fallback, params string[] keys)
    {
        string? raw = ReadString(config, keys);
        return int.TryParse(raw, out int parsed) && parsed > 0 ? parsed : fallback;
    }

    private static string Normalize(string url) => url.TrimEnd('/');
}
