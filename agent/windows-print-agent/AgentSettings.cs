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

    public bool IsConfigured => !string.IsNullOrWhiteSpace(ApiKey) && ApiKey != PlaceholderApiKey;

    public const string PlaceholderApiKey = "PASTE_YOUR_AGENT_API_KEY_HERE";

    public static AgentSettings FromConfiguration(IConfiguration config)
    {
        int heartbeatSeconds = ReadInt(config, 30, "HeartbeatIntervalSeconds", "PrintOk:HeartbeatIntervalSeconds");

        return new AgentSettings
        {
            ApiBaseUrl = Normalize(
                ReadString(config, "PrintOkApiUrl", "PrintOk:ApiBaseUrl", "ApiBaseUrl")
                ?? "http://localhost:4000"),
            ApiKey = ReadString(config, "AgentApiKey", "PrintOk:ApiKey", "ApiKey") ?? PlaceholderApiKey,
            ShopId = ReadString(config, "ShopId", "PrintOk:ShopId"),
            PrinterId = ReadString(config, "PrinterId", "PrintOk:PrinterId"),
            PrinterName = ReadString(config, "PrinterName", "PrintOk:PrinterName"),
            PollIntervalMs = ReadInt(config, 3000, "PollIntervalMs", "PrintOk:PollIntervalMs"),
            HeartbeatIntervalMs = heartbeatSeconds * 1000
        };
    }

    /// <summary>Derives the WebSocket push endpoint from the HTTP base address.</summary>
    public Uri BuildWebSocketUri()
    {
        var builder = new UriBuilder(ApiBaseUrl)
        {
            Scheme = ApiBaseUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? "wss" : "ws",
            Path = "/ws/agent",
            Query = $"apiKey={Uri.EscapeDataString(ApiKey)}"
        };

        // UriBuilder re-adds the default HTTP port when swapping to ws/wss; drop it.
        if ((builder.Port == 80 || builder.Port == 443) && !ApiBaseUrl.Contains($":{builder.Port}"))
        {
            builder.Port = -1;
        }

        return builder.Uri;
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
