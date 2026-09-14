using System.Runtime.InteropServices;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PrintOk.Agent.Tray.Ui;
using PrintOk.WindowsPrintAgent.Models;
using PrintOk.WindowsPrintAgent.Services;

namespace PrintOk.Agent.Tray;

/// <summary>
/// The Windows desktop agent.
///
/// One process, deliberately. The worker and the window live together, so the
/// window can read the worker's state directly and there is no local port or
/// pipe for anything else on the machine to connect to.
///
/// It starts hidden. The shop owner never has to open it, and the only sign it
/// is running is the tray icon — which is the point: the agent's job is to be
/// invisible until something is wrong.
/// </summary>
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        // Setup and uninstall call these and exit. They run before the mutex so
        // an installer repairing a running agent is not refused as a duplicate.
        if (args.Any(a => a.Equals("--install-autostart", StringComparison.OrdinalIgnoreCase)))
        {
            return Startup.AutoStart.Enable() == Startup.AutoStart.Method.None ? 1 : 0;
        }

        if (args.Any(a => a.Equals("--remove-autostart", StringComparison.OrdinalIgnoreCase)))
        {
            Startup.AutoStart.Disable();
            return 0;
        }

        // One agent per PC. A second copy would poll the same queue and print
        // every job twice, which costs the shop paper and the customer trust.
        using var single = new Mutex(initiallyOwned: true, "Global\\PrintOkPrintAgent", out bool isFirst);
        if (!isFirst)
        {
            MessageBox.Show(
                "PrintOk is already running. Look for its icon in the system tray, "
                + "near the clock.",
                "PrintOk", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }

        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);

        string logPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolderOption.Create),
            "PrintOk", "agent.log");

        var loggerFactory = LoggerFactory.Create(b => b.AddProvider(new FileLoggerProvider(logPath)));
        var log = loggerFactory.CreateLogger("PrintOk.Tray");

        // A crash in the UI thread must not take the window down silently; the
        // log is the only evidence a support request ever has.
        Application.ThreadException += (_, e) =>
        {
            log.LogError(e.Exception, "Unhandled UI exception.");
            MessageBox.Show(
                $"PrintOk hit an unexpected error.\n\n{e.Exception.Message}\n\nDetails are in:\n{logPath}",
                "PrintOk", MessageBoxButtons.OK, MessageBoxIcon.Error);
        };

        try
        {
            return Run(args, logPath, loggerFactory, log);
        }
        catch (Exception ex)
        {
            log.LogError(ex, "The agent could not start.");
            MessageBox.Show(
                $"PrintOk could not start.\n\n{ex.Message}\n\nDetails are in:\n{logPath}",
                "PrintOk", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static int Run(string[] args, string logPath, ILoggerFactory loggerFactory, ILogger log)
    {
        var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
        {
            Args = args,
            // Shortcut, scheduled-task and Run-key launches all inherit an
            // unrelated working directory, so appsettings.json is found next to
            // the executable rather than wherever Windows happened to start us.
            ContentRootPath = AppContext.BaseDirectory,
        });
        builder.Configuration.AddEnvironmentVariables("PRINTOK_");

        var settings = AgentSettings.FromConfiguration(builder.Configuration);
        var status = new AgentStatus { ApiBaseUrl = settings.ApiBaseUrl };

        var credentials = new CredentialStore(loggerFactory.CreateLogger<CredentialStore>());
        var existing = credentials.LoadAsync().GetAwaiter().GetResult();

        if (existing is not null)
        {
            settings.DeviceToken = existing.DeviceToken;
            settings.DeviceId = existing.DeviceId;
            status.DeviceId = existing.DeviceId;
            status.PrinterId = existing.PrinterId;
            status.ShopId = existing.ShopId;
            status.TokenExpiresAt = existing.TokenExpiresAt;
            status.AuthMethod = "Device credential";
        }
        else if (settings.IsConfigured)
        {
            status.AuthMethod = "Shared printer key (legacy)";
            status.PrinterId = settings.PrinterId;
            status.ShopId = settings.ShopId;
        }

        if (!settings.IsConfigured)
        {
            // Not an error: a freshly installed agent has no credential, and the
            // window exists precisely so the owner can pair without a terminal.
            status.SetState(ConnectionState.NotPaired, "This PC has not been paired yet.");
        }

        builder.Services.AddSingleton(settings);
        builder.Services.AddSingleton(status);
        builder.Services.AddSingleton<IPrinterSpooler, WindowsPrinterSpooler>();
        builder.Services.AddHttpClient("PrintOkApi", client =>
        {
            client.BaseAddress = new Uri(settings.ApiBaseUrl);
            client.Timeout = TimeSpan.FromSeconds(30);
        });
        builder.Logging.ClearProviders();
        builder.Logging.AddProvider(new FileLoggerProvider(logPath));

        // The worker only starts once there is something to authenticate with.
        // Starting it unpaired would fill the log with 401s and tell the shop
        // owner nothing they can act on.
        if (settings.IsConfigured)
        {
            builder.Services.AddHostedService<PrintAgentWorker>();
        }

        var host = builder.Build();
        host.Start();

        log.LogInformation(
            "Desktop agent started. Server: {Url} | Printer: {Printer} | Auth: {Auth}",
            settings.ApiBaseUrl,
            status.PrinterId ?? "(unpaired)",
            status.AuthMethod ?? "none");

        // Pairing from the window needs to reach the same API and, on success,
        // persist the credential — handed in as a function so the form knows
        // nothing about HTTP.
        async Task<bool> PairAsync(string code, CancellationToken ct)
        {
            using var http = new HttpClient { BaseAddress = new Uri(settings.ApiBaseUrl) };
            var client = new PairingClient(loggerFactory.CreateLogger<PairingClient>(), http);

            var result = await client.PairAsync(code, settings.ApiBaseUrl, ct);
            if (result.Credentials is null)
            {
                status.SetState(
                    result.Failure == PairFailure.Unreachable ? ConnectionState.Offline : ConnectionState.NotPaired,
                    result.Failure == PairFailure.Unreachable
                        ? $"Could not reach {settings.ApiBaseUrl}. The code was not used and is still valid."
                        : "The server rejected that code. Generate a new one from your dashboard.");
                return false;
            }

            await credentials.SaveAsync(result.Credentials);

            status.DeviceId = result.Credentials.DeviceId;
            status.PrinterId = result.Credentials.PrinterId;
            status.ShopId = result.Credentials.ShopId;
            status.TokenExpiresAt = result.Credentials.TokenExpiresAt;
            status.AuthMethod = "Device credential";
            status.SetState(ConnectionState.Starting);

            log.LogInformation("Paired from the desktop agent. Restart required to begin printing.");
            return true;
        }

        MainForm MakeWindow() => new(status, settings, credentials, logPath, PairAsync);

        using var tray = new TrayContext(status, MakeWindow, () =>
        {
            try { host.StopAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult(); }
            catch { /* shutting down anyway */ }
        });

        // --background is what the scheduled task and Run key pass. Without it —
        // a shop owner double-clicking the icon — show the window, because they
        // opened it expecting something to happen.
        bool background = args.Any(a => a.Equals("--background", StringComparison.OrdinalIgnoreCase));
        if (!background || !settings.IsConfigured)
        {
            MakeWindowVisible(tray);
        }

        Application.Run(tray);
        host.Dispose();
        return 0;
    }

    private static void MakeWindowVisible(TrayContext tray)
    {
        // Deferred to the message loop: showing a form before Application.Run
        // leaves it without a message pump and it paints as a white rectangle.
        var starter = new System.Windows.Forms.Timer { Interval = 1 };
        starter.Tick += (s, _) =>
        {
            starter.Stop();
            starter.Dispose();
            tray.OpenWindow();
        };
        starter.Start();
    }
}
