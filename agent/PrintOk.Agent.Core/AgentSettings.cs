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

    /// <summary>
    /// How often to poll while the WebSocket push channel is connected.
    ///
    /// The agent polled every 3 seconds unconditionally, while ALSO holding a
    /// push channel that already triggers an immediate fetch the moment a job
    /// is queued. That is ~864,000 requests a month per agent, each one a
    /// database query, for information push had already delivered — enough to
    /// consume roughly a sixth of a Supabase free tier's monthly egress with no
    /// customers at all, and to exhaust it entirely at six shops.
    ///
    /// With push up, polling is only a safety net for a notification that was
    /// missed, so it runs slowly. When push drops the agent reverts to the fast
    /// interval immediately rather than waiting out the long delay — see the
    /// wake signal in PrintAgentWorker.
    /// </summary>
    public int IdlePollIntervalMs { get; init; }
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

    /// <summary>
    /// The only hosts this agent will talk to.
    ///
    /// The Server field in the tray window was free text, saved straight to the
    /// settings file and used as the base address for everything the agent
    /// does. So anyone who reached an unlocked counter PC could point it at
    /// their own server and every future print job — customers' documents —
    /// would be fetched from, and reported to, them instead. It needs no
    /// credential and leaves no trace beyond one line in a JSON file.
    ///
    /// An allowlist rather than a format check: "is this a valid URL" was never
    /// the question. Loopback stays permitted because the agent is developed
    /// against a local API, and a loopback address is not somewhere a remote
    /// attacker can receive anything.
    /// </summary>
    private static readonly string[] BuiltInAllowedHosts =
    {
        "prinok-api.onrender.com",
        "localhost",
        "127.0.0.1",
        "::1",
    };

    /// <summary>
    /// A machine-level environment variable naming further hosts this agent may
    /// use, comma separated.
    ///
    /// The API host was a compiled-in constant, which made it unchangeable
    /// without rebuilding and reinstalling the agent on every shop PC. Moving
    /// PrintOk to a different domain would have stopped every installed agent
    /// printing, because each one would refuse the new address by design.
    ///
    /// Deliberately an environment variable and NOT the agent's settings file.
    /// The threat this allowlist exists for is someone at an unlocked counter
    /// retyping the Server box in the tray window — no admin rights, no trace.
    /// Reading extra hosts from the same file that box writes to would hand
    /// that person the bypass. A machine-level environment variable needs
    /// administrator access to set, which is the installer's job and not a
    /// passer-by's.
    ///
    /// It only ever ADDS to the built-in list. There is no way to configure the
    /// allowlist away entirely.
    /// </summary>
    public const string AllowedHostsVariable = "PRINTOK_ALLOWED_API_HOSTS";

    /// <summary>
    /// Every host this agent will talk to: the built-in set plus anything an
    /// administrator has added.
    ///
    /// Read on each call rather than cached, so a host added by an installer is
    /// picked up without restarting the service.
    /// </summary>
    public static IReadOnlyList<string> AllowedHosts()
    {
        string? configured = Environment.GetEnvironmentVariable(AllowedHostsVariable);
        if (string.IsNullOrWhiteSpace(configured))
        {
            return BuiltInAllowedHosts;
        }

        var hosts = new List<string>(BuiltInAllowedHosts);

        foreach (string entry in configured.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            // Accept a bare host or a whole URL, because whoever sets this will
            // have the base URL to hand and pasting it is the obvious mistake.
            string host = Uri.TryCreate(entry, UriKind.Absolute, out Uri? parsed) ? parsed.Host : entry;

            // A wildcard would let one careless entry admit an attacker's
            // subdomain, so each host is named in full.
            if (host.Contains('*') || host.Contains('/') || host.Length == 0)
            {
                continue;
            }

            hosts.Add(host);
        }

        return hosts;
    }

    /// <summary>
    /// Whether the agent may be pointed at this address, and why not.
    ///
    /// Returns null when the address is acceptable, otherwise a sentence the
    /// tray window can show to whoever typed it.
    /// </summary>
    public static string? DescribeApiBaseUrlProblem(string? candidate)
    {
        if (string.IsNullOrWhiteSpace(candidate))
        {
            // Empty means "use the built-in address", which is the right
            // recovery for a shop that has pasted something wrong in.
            return null;
        }

        if (!Uri.TryCreate(candidate.Trim(), UriKind.Absolute, out Uri? uri))
        {
            return "That is not a complete web address. It should look like https://prinok-api.onrender.com.";
        }

        if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
        {
            return "The address must start with https://.";
        }

        bool loopback = uri.IsLoopback;

        if (uri.Scheme == Uri.UriSchemeHttp && !loopback)
        {
            return "Only https:// addresses are allowed, so print jobs cannot be read in transit.";
        }

        if (!AllowedHosts().Contains(uri.Host, StringComparer.OrdinalIgnoreCase))
        {
            return
                $"This agent will not connect to '{uri.Host}'. Customers' documents pass through "
                + "this address, so it is restricted to PrintOk's own servers. Leave it blank to use "
                + "the built-in address.";
        }

        return null;
    }

    public static AgentSettings FromConfiguration(IConfiguration config)
    {
        int heartbeatSeconds = ReadInt(config, 30, "HeartbeatIntervalSeconds", "PrintOk:HeartbeatIntervalSeconds");

        return new AgentSettings
        {
            // Checked on read as well as on write: editing the settings file by
            // hand is the same redirection without going through the window.
            ApiBaseUrl = Normalize(SafeApiBaseUrl(
                ReadString(config, "PrintOkApiUrl", "PrintOk:ApiBaseUrl", "ApiBaseUrl"))),
            ApiKey = ReadString(config, "AgentApiKey", "PrintOk:ApiKey", "ApiKey") ?? PlaceholderApiKey,
            ShopId = ReadString(config, "ShopId", "PrintOk:ShopId"),
            PrinterId = ReadString(config, "PrinterId", "PrintOk:PrinterId"),
            PrinterName = ReadString(config, "PrinterName", "PrintOk:PrinterName"),
            PollIntervalMs = ReadInt(config, 3000, "PollIntervalMs", "PrintOk:PollIntervalMs"),
            IdlePollIntervalMs = ReadInt(config, 60000, "IdlePollIntervalMs", "PrintOk:IdlePollIntervalMs"),
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

    /// <summary>
    /// The configured address, or the built-in one if it is not allowed.
    ///
    /// Falls back rather than throwing: an agent that refuses to start because
    /// somebody pasted a bad address into a file is an agent a shop cannot
    /// recover without a support call. Falling back to the real server keeps
    /// the shop printing and makes the redirection useless.
    /// </summary>
    private static string SafeApiBaseUrl(string? configured)
    {
        if (string.IsNullOrWhiteSpace(configured)) return DefaultApiBaseUrl;

        string? problem = DescribeApiBaseUrlProblem(configured);
        if (problem is null) return configured;

        Console.Error.WriteLine(
            $"[PrintOk] Ignoring the configured server address: {problem} "
            + $"Using {DefaultApiBaseUrl} instead.");
        return DefaultApiBaseUrl;
    }

    private static string Normalize(string url) => url.TrimEnd('/');
}
