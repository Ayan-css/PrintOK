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

static string? ReadPairingCode()
{
    // Up to three goes, because a typo should not mean re-launching the agent,
    // and because the operator may be reading the code off a second screen.
    for (int attempt = 0; attempt < 3; attempt++)
    {
        string? typed = Ui.Prompt("Pairing code (e.g. K7MP-3QRT), or Enter to quit:");
        if (string.IsNullOrWhiteSpace(typed)) return null;

        if (PairingCodeInput.TryParse(typed, out string code, out var problem)) return code;

        // Said here rather than by the server. A local complaint is the honest
        // one: nothing was sent, so nothing expired, and telling someone to
        // generate a fresh code would start a loop that cannot end.
        Ui.Blank();
        switch (problem)
        {
            case PairingCodeInput.Problem.ConfusableCharacter:
                Ui.Warn("That contains a character no pairing code has.");
                Ui.Note("Codes never use I, L, O, 0 or 1 — check for a misread letter.");
                break;
            default:
                Ui.Warn("That does not look like a pairing code.");
                Ui.Note("A code is eight characters, shown as XXXX-XXXX. Paste just the code,");
                Ui.Note("not the whole command line.");
                break;
        }
        Ui.Blank();
    }

    return null;
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

    pairingCode = ReadPairingCode();

    if (string.IsNullOrWhiteSpace(pairingCode))
    {
        Ui.Blank();
        Ui.Warn("No pairing code entered, so nothing was connected.");
        Ui.Note("Run this again once you have a code from the dashboard.");
        HoldWindowOpen();
        return 1;
    }
}
else if (!string.IsNullOrWhiteSpace(pairingCode))
{
    // A code given on the command line gets the same treatment. Quoting a
    // switch wrongly is easy, and sending the mess to the server would produce
    // the same misleading "expired code" as typing it wrongly did.
    if (!PairingCodeInput.TryParse(pairingCode, out string parsed, out _))
    {
        Ui.Blank();
        Ui.Fail("That is not a pairing code.");
        Ui.Note("--PairingCode takes eight characters, shown as XXXX-XXXX on the dashboard.");
        HoldWindowOpen();
        return 1;
    }
    pairingCode = parsed;
}

if (!string.IsNullOrWhiteSpace(pairingCode))
{
    using var pairingHttp = new HttpClient { BaseAddress = new Uri(settings.ApiBaseUrl) };
    var pairingClient = new PairingClient(startupLoggerFactory.CreateLogger<PairingClient>(), pairingHttp);

    // Named before the attempt, not only after it succeeds. When pairing fails
    // because the agent is pointed at the wrong server, this one line is the
    // whole diagnosis — and it is the line that was missing when a shop PC tried
    // to pair against http://localhost:4000.
    Ui.Blank();
    Ui.Field("Pairing with", settings.ApiBaseUrl);

    var result = await pairingClient.PairAsync(pairingCode!, settings.ApiBaseUrl);
    if (result.Credentials is null)
    {
        Ui.Blank();
        Ui.Fail("Pairing failed.");

        if (result.Failure == PairFailure.Unreachable)
        {
            // The code was never sent, so it is still good. Sending the operator
            // to generate a fresh one would be a loop that cannot succeed.
            Ui.Note($"Nothing answered at {settings.ApiBaseUrl}, so the code was never used —");
            Ui.Note("it is still valid. This is a connection problem, not a code problem.");
            Ui.Blank();
            Ui.Info("Check this PC is online and that a firewall is not blocking the agent");
            Ui.Info("If your PrintOk server is elsewhere, point the agent at it:");
            Ui.Note("    WindowsPrintAgent.exe --PrintOkApiUrl=https://your-api --PairingCode=XXXX-XXXX");
        }
        else
        {
            Ui.Note("The server rejected this code. Codes are single use and expire after");
            Ui.Note("15 minutes, so generate a fresh one from the dashboard and try again.");
        }

        Ui.Field("Details in", logPath);
        HoldWindowOpen();
        return 1;
    }

    var paired = result.Credentials;
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
    // See the desktop host: a cloud instance waking from idle answers in ~33s,
    // so 30 was short enough to fail every first request after a quiet period.
    client.Timeout = TimeSpan.FromSeconds(90);
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
