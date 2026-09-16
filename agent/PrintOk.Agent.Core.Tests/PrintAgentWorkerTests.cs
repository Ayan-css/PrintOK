using Microsoft.Extensions.Logging.Abstractions;
using PrintOk.WindowsPrintAgent.Models;
using PrintOk.WindowsPrintAgent.Services;
using Xunit;

namespace PrintOk.Agent.Core.Tests;

/// <summary>
/// The worker's contract with its host: it waits for a credential, and it
/// starts the moment one arrives.
///
/// This is the shape of a real failure. The desktop agent registered the worker
/// only when the PC was already paired, so a fresh install started with no
/// worker at all. Pairing from the agent's own window then succeeded — the
/// window said "This PC is paired and will start printing" — and nothing ever
/// printed, because there was no loop for the new credential to reach. The log
/// went silent at startup and the dashboard reported the agent offline forever.
/// </summary>
public class PrintAgentWorkerTests
{
    /// <summary>Counts what the worker actually sends, and answers nothing useful.</summary>
    private sealed class RecordingHandler : HttpMessageHandler
    {
        private int _calls;
        public int Calls => Volatile.Read(ref _calls);
        public readonly List<string> Paths = new();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _calls);
            lock (Paths) Paths.Add(request.RequestUri?.AbsolutePath ?? "");
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.ServiceUnavailable));
        }
    }

    private sealed class StubFactory : IHttpClientFactory
    {
        private readonly HttpMessageHandler _handler;
        public StubFactory(HttpMessageHandler handler) => _handler = handler;

        public HttpClient CreateClient(string name) =>
            // Port 9 (discard): the WebSocket loop dials a real socket and must
            // fail fast rather than reach anything.
            new(_handler, disposeHandler: false) { BaseAddress = new Uri("http://127.0.0.1:9") };
    }

    private sealed class NoPrinter : IPrinterSpooler
    {
        public Task<bool> PrintDocumentAsync(
            string tempFilePath, string fileName, int copies, bool isColor, CancellationToken ct)
            => Task.FromResult(true);
    }

    private static AgentSettings Unpaired() => new()
    {
        ApiBaseUrl = "http://127.0.0.1:9",
        ApiKey = AgentSettings.PlaceholderApiKey,
        PollIntervalMs = 200,
        HeartbeatIntervalMs = 200,
    };

    [Fact]
    public async Task Sends_nothing_until_this_PC_has_a_credential()
    {
        var handler = new RecordingHandler();
        var settings = Unpaired();
        var status = new AgentStatus();

        var worker = new PrintAgentWorker(
            NullLogger<PrintAgentWorker>.Instance, new StubFactory(handler), new NoPrinter(), settings, status);

        using var cts = new CancellationTokenSource();
        await worker.StartAsync(cts.Token);

        await Task.Delay(1500);

        Assert.Equal(0, handler.Calls);
        Assert.Equal(ConnectionState.NotPaired, status.State);

        await cts.CancelAsync();
        await worker.StopAsync(CancellationToken.None);
    }

    /// <summary>
    /// The fix, stated as the behaviour a shop owner expects: pair from the
    /// window and printing begins, without being told to restart anything.
    /// </summary>
    [Fact]
    public async Task Starts_polling_when_pairing_hands_it_a_credential_mid_run()
    {
        var handler = new RecordingHandler();
        var settings = Unpaired();
        var status = new AgentStatus();

        var worker = new PrintAgentWorker(
            NullLogger<PrintAgentWorker>.Instance, new StubFactory(handler), new NoPrinter(), settings, status);

        using var cts = new CancellationTokenSource();
        await worker.StartAsync(cts.Token);
        await Task.Delay(500);
        Assert.Equal(0, handler.Calls);

        // Exactly what the window's pairing flow does on success.
        settings.DeviceToken = "dev-token";
        settings.DeviceId = "dev_test";

        // The gate re-checks once a second.
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (handler.Calls == 0 && DateTime.UtcNow < deadline) await Task.Delay(100);

        Assert.True(handler.Calls > 0, "the worker never started polling after the credential arrived");
        lock (handler.Paths)
        {
            Assert.Contains(handler.Paths, p => p.Contains("/api/agent/"));
        }

        await cts.CancelAsync();
        await worker.StopAsync(CancellationToken.None);
    }

    /// <summary>
    /// A heartbeat refused with anything other than 401 used to return no log
    /// line and no state change at all, which is why the window could sit on
    /// "Connecting…" while the log file said nothing had happened since startup.
    /// </summary>
    [Fact]
    public async Task Reports_a_refused_heartbeat_rather_than_swallowing_it()
    {
        var handler = new RecordingHandler();   // answers 503 to everything
        var settings = Unpaired();
        settings.DeviceToken = "dev-token";
        var status = new AgentStatus();

        var worker = new PrintAgentWorker(
            NullLogger<PrintAgentWorker>.Instance, new StubFactory(handler), new NoPrinter(), settings, status);

        using var cts = new CancellationTokenSource();
        await worker.StartAsync(cts.Token);

        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (status.State == ConnectionState.Starting && DateTime.UtcNow < deadline) await Task.Delay(100);

        Assert.Equal(ConnectionState.Offline, status.State);
        Assert.Contains("503", status.LastError ?? "");

        await cts.CancelAsync();
        await worker.StopAsync(CancellationToken.None);
    }
}
