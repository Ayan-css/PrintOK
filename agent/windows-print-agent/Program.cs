using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PrintOk.WindowsPrintAgent.Models;
using PrintOk.WindowsPrintAgent.Services;
using System.Runtime.InteropServices;

// ---------------------------------------------------------------------------
// Interactive-console helpers.
//
// A shop owner double-clicks this executable from Explorer. When the process
// exits, Windows closes the window immediately — so anything printed on the way
// out is never seen. Previously an unconfigured agent "opened and closed with
// nothing displayed", which is precisely this. Every exit path below therefore
// holds the window open when a person is watching.
// ---------------------------------------------------------------------------

static bool IsInteractive()
{
    try
    {
        return Environment.UserInteractive && !Console.IsInputRedirected && !Console.IsOutputRedirected;
    }
    catch
    {
        return false;
    }
}

static void HoldWindowOpen()
{
    if (!IsInteractive()) return;

    Ui.Blank();
    Ui.Note("Press any key to close this window...");
    try
    {
        Console.ReadKey(intercept: true);
    }
    catch (InvalidOperationException)
    {
        // No usable console (redirected or detached); nothing to wait for.
    }
}

static string PlatformLabel()
{
    string os =
        RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "Windows" :
        RuntimeInformation.IsOSPlatform(OSPlatform.Linux)   ? "Linux"   :
        RuntimeInformation.IsOSPlatform(OSPlatform.OSX)     ? "macOS"   : "Unknown";

    return $"{os} · {RuntimeInformation.OSArchitecture}";
}

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

// Log to a file as well as the console, so a closed window does not lose the
// evidence needed to diagnose a failure.
string logPath = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolderOption.Create),
    "PrintOk", "agent.log");

builder.Logging.AddProvider(new FileLoggerProvider(logPath));

using var startupLoggerFactory = LoggerFactory.Create(b =>
{
    b.AddConsole();
    b.AddProvider(new FileLoggerProvider(logPath));
});
var startupLogger = startupLoggerFactory.CreateLogger("PrintOk.Startup");

Ui.Banner(AgentVersion.Current, PlatformLabel());
Ui.Field("Log file", logPath);

var credentialStore = new CredentialStore(startupLoggerFactory.CreateLogger<CredentialStore>());

// ---------------------------------------------------------------------------
// Credentials (PRD 7.1, 7.2)
//
// Preference order:
//   1. a pairing code supplied on this run  -> pair, then store the device token
//   2. a device token already stored on this machine
//   3. the shared printer API key from appsettings.json (legacy installs)
//   4. nothing -> ask for a pairing code interactively, rather than exiting
//      with an error nobody can read
// ---------------------------------------------------------------------------

var existing = await credentialStore.LoadAsync();
string? pairingCode = settings.PairingCode;

// Nothing configured at all: walk the operator through pairing instead of
// failing. This is the first-run path for a freshly downloaded executable.
if (existing is null && string.IsNullOrWhiteSpace(pairingCode) && !settings.IsConfigured && IsInteractive())
{
    Ui.Section("Not connected yet");
    Ui.Note("This machine is not linked to a PrintOk shop.");
    Ui.Blank();
    Ui.Info("Open your merchant dashboard in a browser");
    Ui.Info("Go to the 'QR Poster & Agent' tab");
    Ui.Info("Click 'Pair New PC' and copy the code it shows");
    Ui.Blank();

    pairingCode = Ui.Prompt("Pairing code (e.g. K7MP-3QRT), or Enter to quit:");

    if (string.IsNullOrWhiteSpace(pairingCode))
    {
        Ui.Blank();
        Ui.Warn("No pairing code entered, so nothing was connected.");
        Ui.Note("Run this again once you have a code from the dashboard.");
        HoldWindowOpen();
        return 1;
    }
}

if (!string.IsNullOrWhiteSpace(pairingCode))
{
    using var pairingHttp = new HttpClient { BaseAddress = new Uri(settings.ApiBaseUrl) };
    var pairingClient = new PairingClient(startupLoggerFactory.CreateLogger<PairingClient>(), pairingHttp);

    Console.WriteLine();
    var paired = await pairingClient.PairAsync(pairingCode!, settings.ApiBaseUrl);
    if (paired is null)
    {
        Ui.Blank();
        Ui.Fail("Pairing failed.");
        Ui.Note("Codes are single use and expire after 15 minutes, so generate a");
        Ui.Note("fresh one from the dashboard and try again.");
        Ui.Field("Details in", logPath);
        HoldWindowOpen();
        return 1;
    }

    await credentialStore.SaveAsync(paired);
    existing = paired;

    Ui.Blank();
    Ui.Ok($"Paired. This machine is connected to printer {paired.PrinterId}.");
    Ui.Note("The code is not needed again — just run this to start printing.");
    Ui.Blank();
}

if (existing is not null)
{
    settings.DeviceToken = existing.DeviceToken;
    settings.DeviceId = existing.DeviceId;

    if (existing.TokenExpiresAt is { } expiry && expiry < DateTimeOffset.UtcNow)
    {
        startupLogger.LogError(
            "The stored credential for this PC expired on {Expiry:u}. Pair again with a fresh code from the dashboard.",
            expiry);
        HoldWindowOpen();
        return 1;
    }
}

if (!settings.IsConfigured)
{
    startupLogger.LogError(
        "This agent is not connected to a shop. Run it again and enter a pairing code from your " +
        "dashboard, or start it with: WindowsPrintAgent.exe --PairingCode=XXXX-XXXX");
    HoldWindowOpen();
    return 1;
}

Ui.Section("Connected");
Ui.Field("Cloud API", settings.ApiBaseUrl);
Ui.Field("Printer", existing?.PrinterId ?? settings.PrinterId ?? "(unset)");
Ui.Field("Auth", settings.HasDeviceToken
    ? $"device token ({settings.DeviceId})"
    : "shared printer key (legacy)");
if (!string.IsNullOrWhiteSpace(settings.PrinterName)) Ui.Field("Target", settings.PrinterName!);

// The same detail still reaches the log file, which is what a support request
// actually reads.
startupLogger.LogInformation(
    "Cloud API: {ApiBaseUrl} | Printer: {PrinterId} | Auth: {AuthMethod}",
    settings.ApiBaseUrl,
    existing?.PrinterId ?? settings.PrinterId ?? "(unset)",
    settings.HasDeviceToken ? $"device token ({settings.DeviceId})" : "shared printer key (legacy)");

if (!settings.HasDeviceToken)
{
    startupLogger.LogWarning(
        "Using the printer's shared API key. Pair this machine to give it its own revocable " +
        "credential: WindowsPrintAgent.exe --PairingCode=XXXX-XXXX");
}

builder.Services.AddSingleton(settings);
// Which spooler runs is decided once, here, by the host OS. The Windows path is
// untouched by the addition of the CUPS one: on Windows this resolves exactly as
// it always did, and a Linux or macOS machine now prints for real instead of
// falling into WindowsPrinterSpooler's simulation branch.
if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
{
    builder.Services.AddSingleton<IPrinterSpooler, WindowsPrinterSpooler>();
}
else
{
    builder.Services.AddSingleton<IPrinterSpooler, CupsPrinterSpooler>();

    // Say now whether anything is printable, rather than discovering it on the
    // first job a customer has already paid for.
    var printers = await CupsPrinterSpooler.DescribeDefaultPrinterAsync(CancellationToken.None);
    if (printers is null)
    {
        Ui.Warn("No CUPS printer found. Jobs will be collected but cannot print.");
        Ui.Note("Check with: lpstat -p -d");
    }
    else
    {
        Ui.Field("CUPS", printers);
    }
}

builder.Services.AddHttpClient("PrintOkApi", client =>
{
    client.BaseAddress = new Uri(settings.ApiBaseUrl);
    client.Timeout = TimeSpan.FromSeconds(30);
});

builder.Services.AddHostedService<PrintAgentWorker>();

Ui.Blank();
Ui.Ok("Ready. Keep this window open — closing it stops printing.");
Ui.Blank();

try
{
    var host = builder.Build();
    host.Run();
    return 0;
}
catch (Exception ex)
{
    // Never let the window vanish on an unhandled startup failure.
    startupLogger.LogError(ex, "The print agent stopped unexpectedly.");
    HoldWindowOpen();
    return 1;
}
