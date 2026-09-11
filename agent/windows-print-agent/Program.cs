using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PrintOk.WindowsPrintAgent.Models;
using PrintOk.WindowsPrintAgent.Services;

var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
{
    Args = args,
    // Shortcut, scheduled-task and service launches inherit an unrelated working
    // directory, so anchor appsettings.json discovery to the folder the executable
    // actually sits in rather than Directory.GetCurrentDirectory().
    ContentRootPath = AppContext.BaseDirectory
});

builder.Configuration.AddEnvironmentVariables("PRINTOK_");

var settings = AgentSettings.FromConfiguration(builder.Configuration);

using var startupLoggerFactory = LoggerFactory.Create(b => b.AddConsole());
var startupLogger = startupLoggerFactory.CreateLogger("PrintOk.Startup");

startupLogger.LogInformation("PrintOk Windows Print Agent {Version}", AgentVersion.Current);
startupLogger.LogInformation("Configuration root: {ContentRoot}", AppContext.BaseDirectory);

var credentialStore = new CredentialStore(startupLoggerFactory.CreateLogger<CredentialStore>());

// ---------------------------------------------------------------------------
// Credentials (PRD 7.1, 7.2)
//
// Preference order:
//   1. a pairing code supplied on this run  -> pair, then store the device token
//   2. a device token already stored on this machine
//   3. the shared printer API key from appsettings.json (legacy installs)
// ---------------------------------------------------------------------------

var existing = await credentialStore.LoadAsync();

if (!string.IsNullOrWhiteSpace(settings.PairingCode))
{
    using var pairingHttp = new HttpClient { BaseAddress = new Uri(settings.ApiBaseUrl) };
    var pairingClient = new PairingClient(startupLoggerFactory.CreateLogger<PairingClient>(), pairingHttp);

    var paired = await pairingClient.PairAsync(settings.PairingCode!, settings.ApiBaseUrl);
    if (paired is null)
    {
        startupLogger.LogError("Pairing failed. The agent cannot start.");
        return 1;
    }

    await credentialStore.SaveAsync(paired);
    existing = paired;

    startupLogger.LogInformation(
        "Pairing complete. Remove PairingCode from appsettings.json (or the command line); " +
        "it is single use and this machine is now paired.");
}

if (existing is not null)
{
    settings.DeviceToken = existing.DeviceToken;
    settings.DeviceId = existing.DeviceId;

    if (existing.TokenExpiresAt is { } expiry && expiry < DateTimeOffset.UtcNow)
    {
        startupLogger.LogError(
            "The stored device token expired on {Expiry:u}. Re-pair with a fresh code from the dashboard.",
            expiry);
        return 1;
    }
}

if (!settings.IsConfigured)
{
    startupLogger.LogError(
        "This agent is not paired and has no API key. Generate a pairing code in your PrintOk " +
        "dashboard (QR Poster & Agent tab) and run:\n" +
        "    WindowsPrintAgent.exe --PairingCode=XXXX-XXXX\n" +
        "Alternatively place the appsettings.json downloaded from the dashboard next to the executable.");
    return 1;
}

startupLogger.LogInformation(
    "Cloud API: {ApiBaseUrl} | Printer: {PrinterId} | Auth: {AuthMethod}",
    settings.ApiBaseUrl,
    existing?.PrinterId ?? settings.PrinterId ?? "(unset)",
    settings.HasDeviceToken ? $"device token ({settings.DeviceId})" : "shared printer key (legacy)");

if (!settings.HasDeviceToken)
{
    startupLogger.LogWarning(
        "Using the printer's shared API key. Pair this machine to get its own revocable " +
        "credential: WindowsPrintAgent.exe --PairingCode=XXXX-XXXX");
}

builder.Services.AddSingleton(settings);
builder.Services.AddSingleton<IPrinterSpooler, WindowsPrinterSpooler>();

builder.Services.AddHttpClient("PrintOkApi", client =>
{
    client.BaseAddress = new Uri(settings.ApiBaseUrl);
    client.Timeout = TimeSpan.FromSeconds(30);
});

builder.Services.AddHostedService<PrintAgentWorker>();

var host = builder.Build();
host.Run();
return 0;
