using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PrintOk.WindowsPrintAgent.Models;

namespace PrintOk.WindowsPrintAgent.Services;

public class PrintAgentWorker : BackgroundService
{
    private readonly ILogger<PrintAgentWorker> _logger;
    private readonly HttpClient _httpClient;
    private readonly IPrinterSpooler _spooler;
    private readonly string _apiKey;
    private readonly int _pollIntervalMs;

    public PrintAgentWorker(
        ILogger<PrintAgentWorker> logger,
        IHttpClientFactory httpClientFactory,
        IPrinterSpooler spooler,
        IConfiguration configuration)
    {
        _logger = logger;
        _httpClient = httpClientFactory.CreateClient("PrintOkApi");
        _spooler = spooler;
        _apiKey = configuration["PrintOk:ApiKey"] ?? "prn_key_demo";
        _pollIntervalMs = configuration.GetValue<int>("PrintOk:PollIntervalMs", 3000);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("PrintOk Windows Print Agent started. Polling interval: {Interval}ms", _pollIntervalMs);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await PollAndProcessJobsAsync(stoppingToken);
            }
            catch (HttpRequestException ex)
            {
                _logger.LogWarning("Network interruption while contacting Cloud API: {Message}. Reconnecting in {Interval}ms...", ex.Message, _pollIntervalMs);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Unexpected error in Print Agent loop.");
            }

            await Task.Delay(_pollIntervalMs, stoppingToken);
        }
    }

    public async Task PollAndProcessJobsAsync(CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/agent/jobs/pending");
        request.Headers.Add("x-agent-api-key", _apiKey);

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            _logger.LogWarning("Poll request returned non-success status code: {Code}", response.StatusCode);
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

        string tempFilePath = Path.Combine(Path.GetTempPath(), $"printok_{job.Id}_{job.FileName}");
        try
        {
            // 2. Decode temporary payload (base64 data URI for MVP)
            byte[] fileBytes;
            if (job.FileUrl.StartsWith("data:application/pdf;base64,"))
            {
                string base64Data = job.FileUrl["data:application/pdf;base64,".Length..];
                fileBytes = Convert.FromBase64String(base64Data);
            }
            else
            {
                fileBytes = await _httpClient.GetByteArrayAsync(job.FileUrl, cancellationToken);
            }

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
                await UpdateJobStatusAsync(job.Id, "Completed", cancellationToken: cancellationToken);
            }
            else
            {
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

    private async Task UpdateJobStatusAsync(string jobId, string printState, string? errorMessage = null, CancellationToken cancellationToken = default)
    {
        var dto = new AgentUpdateStatusDto(jobId, printState, errorMessage);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/agent/jobs/{jobId}/status")
        {
            Content = JsonContent.Create(dto)
        };
        request.Headers.Add("x-agent-api-key", _apiKey);

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            _logger.LogWarning("Failed to update status for job '{JobId}' to {State}. Status Code: {Code}", jobId, printState, response.StatusCode);
        }
    }

    private static string ComputeSha256(byte[] data)
    {
        byte[] hashBytes = SHA256.HashData(data);
        return Convert.ToHexString(hashBytes).ToLowerInvariant();
    }
}
