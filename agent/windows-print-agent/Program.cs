using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using PrintOk.WindowsPrintAgent.Services;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddSingleton<IPrinterSpooler, WindowsPrinterSpooler>();

string apiBaseUrl = builder.Configuration["PrintOk:ApiBaseUrl"] ?? "http://localhost:4000";

builder.Services.AddHttpClient("PrintOkApi", client =>
{
    client.BaseAddress = new Uri(apiBaseUrl);
    client.Timeout = TimeSpan.FromSeconds(30);
});

builder.Services.AddHostedService<PrintAgentWorker>();

var host = builder.Build();
host.Run();
