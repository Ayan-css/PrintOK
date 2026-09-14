using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PrintOk.WindowsPrintAgent.Models;

namespace PrintOk.WindowsPrintAgent.Services;

public class PrintAgentWorker : BackgroundService
{
    private readonly ILogger<PrintAgentWorker> _logger;
    private readonly HttpClient _httpClient;
    private readonly IPrinterSpooler _spooler;
    private readonly AgentSettings _settings;
    private readonly string _apiKey;
    private readonly int _pollIntervalMs;

    /// <summary>
    /// Shared status, so a host with a window can show what this loop is doing.
    /// Optional: the console host passes none and the worker behaves as before.
    /// </summary>
    private readonly AgentStatus? _status;

    public PrintAgentWorker(
        ILogger<PrintAgentWorker> logger,
        IHttpClientFactory httpClientFactory,
        IPrinterSpooler spooler,
        AgentSettings settings,
        AgentStatus? status = null)
    {
        _logger = logger;
        _httpClient = httpClientFactory.CreateClient("PrintOkApi");
        _spooler = spooler;
        _settings = settings;
        _apiKey = settings.ApiKey;
        _pollIntervalMs = settings.PollIntervalMs;
        _status = status;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("PrintOk Windows Print Agent started. Polling interval: {Interval}ms", _pollIntervalMs);

        // Start background WebSocket push listener with auto-reconnect
        _ = Task.Run(() => ConnectAndListenWebSocketAsync(stoppingToken), stoppingToken);

        // Start periodic background telemetry heartbeat (every 30s)
        _ = Task.Run(() => StartHeartbeatLoopAsync(stoppingToken), stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await PollAndProcessJobsAsync(stoppingToken);
            }
            catch (HttpRequestException ex)
            {
                _status?.SetState(ConnectionState.Offline, ex.Message);
                _logger.LogWarning("Network interruption while contacting Cloud API: {Message}. Reconnecting in {Interval}ms...", ex.Message, _pollIntervalMs);
            }
            catch (Exception ex)
            {
                _status?.SetState(ConnectionState.Offline, ex.Message);
                _logger.LogError(ex, "Unexpected error in Print Agent loop.");
            }

            await Task.Delay(_pollIntervalMs, stoppingToken);
        }
    }

    private async Task StartHeartbeatLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, "/api/agent/heartbeat")
                {
                    Content = JsonContent.Create(new { paperStatus = "OK" })
                };
                ApplyAuthHeaders(request);

                using var response = await _httpClient.SendAsync(request, cancellationToken);
                if (response.IsSuccessStatusCode)
                {
                    _status?.RecordHeartbeat();
                    _status?.SetState(ConnectionState.Connected);
                    _logger.LogDebug("Heartbeat telemetry successfully sent to Cloud API.");
                }
                else if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                {
                    _status?.SetState(ConnectionState.NotPaired,
                        _settings.HasDeviceToken
                            ? "This PC's credential was rejected. It may have been revoked from the dashboard."
                            : "The agent API key was rejected.");
                    _logger.LogError(
                        _settings.HasDeviceToken
                            ? "Cloud API rejected this device's token. It may have been revoked from the dashboard. Re-pair with a new pairing code."
                            : "Cloud API rejected the agent API key. Re-download appsettings.json from the PrintOk dashboard.");
                }
            }
            catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
            {
                _status?.SetState(ConnectionState.Offline, ex.Message);
                _logger.LogWarning("Heartbeat send failed: {Message}", ex.Message);
            }

            await Task.Delay(_settings.HeartbeatIntervalMs, cancellationToken);
        }
    }


    private async Task ConnectAndListenWebSocketAsync(CancellationToken cancellationToken)
    {
        int backoffMs = 1000;
        var wsUri = _settings.BuildWebSocketUri();

        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                using var ws = new System.Net.WebSockets.ClientWebSocket();

                // The credential goes in a header, never the URL, so the line
                // logged below cannot carry it into a support request.
                foreach (var header in _settings.WebSocketAuthHeaders())
                {
                    ws.Options.SetRequestHeader(header.Key, header.Value);
                }

                _logger.LogInformation("Connecting WebSocket push channel to {Uri}...", wsUri);
                await ws.ConnectAsync(wsUri, cancellationToken);
                _logger.LogInformation("WebSocket push channel connected.");
                _status?.RecordPush(true);
                backoffMs = 1000; // Reset backoff on successful connection

                var buffer = new byte[4096];
                while (ws.State == System.Net.WebSockets.WebSocketState.Open && !cancellationToken.IsCancellationRequested)
                {
                    var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);
                    if (result.MessageType == System.Net.WebSockets.WebSocketMessageType.Close)
                    {
                        await ws.CloseAsync(System.Net.WebSockets.WebSocketCloseStatus.NormalClosure, "Closing", cancellationToken);
                        break;
                    }

                    string messageJson = System.Text.Encoding.UTF8.GetString(buffer, 0, result.Count);
                    if (messageJson.Contains("JOB_QUEUED"))
                    {
                        _logger.LogInformation("Received real-time JOB_QUEUED push notification! Triggering immediate job processing...");
                        try
                        {
                            await PollAndProcessJobsAsync(cancellationToken);
                        }
                        catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
                        {
                            _logger.LogError(ex, "Push-triggered job processing failed; the polling loop will retry.");
                        }
                    }
                }
            }
            catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
            {
                _status?.RecordPush(false);
                _logger.LogWarning("WebSocket push connection lost ({Message}). Reconnecting in {Backoff}ms...", ex.Message, backoffMs);
                await Task.Delay(backoffMs, cancellationToken);
                backoffMs = Math.Min(backoffMs * 2, 30000); // Max backoff 30 seconds
            }
        }
    }

    public async Task PollAndProcessJobsAsync(CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/agent/jobs/pending");
        ApplyAuthHeaders(request);

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
            {
                _logger.LogError(
                    _settings.HasDeviceToken
                        ? "Cloud API rejected this device's token while polling. It may have been revoked; re-pair this agent."
                        : "Cloud API rejected the agent API key while polling for jobs. Re-download appsettings.json from the PrintOk dashboard.");
            }
            else
            {
                _logger.LogWarning("Poll request returned non-success status code: {Code}", response.StatusCode);
            }
            return;
        }

        var pollResult = await response.Content.ReadFromJsonAsync<AgentPollResponse>(cancellationToken: cancellationToken);
        if (pollResult == null || pollResult.Jobs.Count == 0)
        {
            return;
        }

        _logger.LogInformation("Received {Count} pending print job(s).", pollResult.Jobs.Count);

        foreach (var job in pollResult.Jobs)
        {
            await ProcessSingleJobAsync(job, cancellationToken);
        }
    }

    private async Task ProcessSingleJobAsync(PrintJob job, CancellationToken cancellationToken)
    {
        _logger.LogInformation("Processing job '{JobId}' ({FileName})...", job.Id, job.FileName);

        // 1. Report Status: Downloading -> Printing
        await UpdateJobStatusAsync(job.Id, "Printing", cancellationToken: cancellationToken);

        string safeFileName = string.Concat(job.FileName.Split(Path.GetInvalidFileNameChars()));
        string tempFilePath = Path.Combine(Path.GetTempPath(), $"printok_{job.Id}_{safeFileName}");
        try
        {
            // 2. Decode temporary payload (base64 data URI for MVP)
            byte[] fileBytes = await LoadJobPayloadAsync(job, cancellationToken);

            // 3. Verify SHA-256 Checksum
            string computedChecksum = ComputeSha256(fileBytes);
            if (!string.Equals(computedChecksum, job.FileChecksum, StringComparison.OrdinalIgnoreCase))
            {
                _logger.LogError("Checksum mismatch for job '{JobId}'. Expected: {Expected}, Computed: {Computed}", job.Id, job.FileChecksum, computedChecksum);
                await UpdateJobStatusAsync(job.Id, "Failed", "File checksum verification failed.", cancellationToken);
                return;
            }

            // 4. Save payload to temporary file
            await File.WriteAllBytesAsync(tempFilePath, fileBytes, cancellationToken);

            // 5. Spool to Printer
            bool printSuccess = await _spooler.PrintDocumentAsync(tempFilePath, job.FileName, job.Copies, job.IsColor, cancellationToken);

            if (printSuccess)
            {
                _logger.LogInformation("Job '{JobId}' printed successfully.", job.Id);
                _status?.RecordJob(printed: true);
                await UpdateJobStatusAsync(job.Id, "Completed", cancellationToken: cancellationToken);
            }
            else
            {
                _status?.RecordJob(printed: false);
                await UpdateJobStatusAsync(job.Id, "Failed", "Spooler failed to print document.", cancellationToken);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to process job '{JobId}'.", job.Id);
            await UpdateJobStatusAsync(job.Id, "Failed", ex.Message, cancellationToken);
        }
        finally
        {
            // 6. Mandatory Privacy Cleanup: Immediately delete temporary document file
            if (File.Exists(tempFilePath))
            {
                try
                {
                    File.Delete(tempFilePath);
                    _logger.LogInformation("Temporary file '{FilePath}' deleted successfully.", tempFilePath);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to delete temporary file '{FilePath}'.", tempFilePath);
                }
            }
        }
    }

    /// <summary>
    /// Job payloads arrive either inline as a base64 data URI (local storage mode) or as
    /// a presigned object-storage URL (S3 mode). The media type varies by document, so
    /// match the data URI shape generically rather than assuming application/pdf.
    /// </summary>
    private async Task<byte[]> LoadJobPayloadAsync(PrintJob job, CancellationToken cancellationToken)
    {
        if (job.FileUrl.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            int separator = job.FileUrl.IndexOf("base64,", StringComparison.OrdinalIgnoreCase);
            if (separator < 0)
            {
                throw new InvalidOperationException("Job payload is a data URI but is not base64 encoded.");
            }

            return Convert.FromBase64String(job.FileUrl[(separator + "base64,".Length)..]);
        }

        return await _httpClient.GetByteArrayAsync(job.FileUrl, cancellationToken);
    }

    private async Task UpdateJobStatusAsync(string jobId, string printState, string? errorMessage = null, CancellationToken cancellationToken = default)
    {
        var dto = new AgentUpdateStatusDto(jobId, printState, errorMessage);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/agent/jobs/{jobId}/status")
        {
            Content = JsonContent.Create(dto)
        };
        ApplyAuthHeaders(request);

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            _logger.LogWarning("Failed to update status for job '{JobId}' to {State}. Status Code: {Code}", jobId, printState, response.StatusCode);
        }
    }

    /// <summary>
    /// Presents the device-scoped token when this machine is paired, falling back
    /// to the printer's shared key for installs that predate pairing (PRD 7.2).
    /// </summary>
    private void ApplyAuthHeaders(HttpRequestMessage request)
    {
        if (_settings.HasDeviceToken)
        {
            request.Headers.Add("x-agent-device-token", _settings.DeviceToken);
        }
        else
        {
            request.Headers.Add("x-agent-api-key", _apiKey);
        }

        request.Headers.Add("x-agent-version", AgentVersion.Current);

        if (!string.IsNullOrWhiteSpace(_settings.DeviceId))
        {
            request.Headers.Add("x-agent-device-id", _settings.DeviceId);
        }
    }

    private static string ComputeSha256(byte[] data)
    {
        byte[] hashBytes = SHA256.HashData(data);
        return Convert.ToHexString(hashBytes).ToLowerInvariant();
    }
}
