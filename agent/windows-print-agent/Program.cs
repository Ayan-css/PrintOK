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
builder.Services.AddSingleton(settings);

builder.Services.AddSingleton<IPrinterSpooler, WindowsPrinterSpooler>();

builder.Services.AddHttpClient("PrintOkApi", client =>
{
    client.BaseAddress = new Uri(settings.ApiBaseUrl);
    client.Timeout = TimeSpan.FromSeconds(30);
});

builder.Services.AddHostedService<PrintAgentWorker>();

var host = builder.Build();

var startupLogger = host.Services.GetRequiredService<ILoggerFactory>().CreateLogger("PrintOk.Startup");
startupLogger.LogInformation("PrintOk Agent configuration root: {ContentRoot}", AppContext.BaseDirectory);
startupLogger.LogInformation("Cloud API: {ApiBaseUrl} | Printer: {PrinterId}", settings.ApiBaseUrl, settings.PrinterId ?? "(unset)");

if (!settings.IsConfigured)
{
    startupLogger.LogError(
        "No agent API key configured. Download appsettings.json from your PrintOk dashboard " +
        "(QR Poster & Agent tab) and place it next to WindowsPrintAgent.exe, or pass " +
        "--AgentApiKey=<key> --PrintOkApiUrl=<url> on the command line. Exiting.");
    return 1;
}

host.Run();
return 0;
