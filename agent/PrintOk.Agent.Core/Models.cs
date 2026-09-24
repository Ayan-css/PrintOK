using System.Text.Json.Serialization;

namespace PrintOk.WindowsPrintAgent.Models;

public record PrintJob(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("printerId")] string PrinterId,
    [property: JsonPropertyName("fileName")] string FileName,
    [property: JsonPropertyName("fileUrl")] string FileUrl,
    [property: JsonPropertyName("fileChecksum")] string FileChecksum,
    [property: JsonPropertyName("pageCount")] int PageCount,
    [property: JsonPropertyName("copies")] int Copies,
    [property: JsonPropertyName("isColor")] bool IsColor,
    [property: JsonPropertyName("printState")] string PrintState,
    // Both of these have been in the server's response all along; the agent
    // simply never deserialised them, so every job printed single-sided on
    // whatever paper the driver defaulted to no matter what was paid for.
    // Defaulted so an older server, which omits them, changes nothing.
    [property: JsonPropertyName("isDuplex")] bool IsDuplex = false,
    [property: JsonPropertyName("paperSize")] string? PaperSize = null,
    /// <summary>
    /// "auto", "portrait" or "landscape". Defaults to auto, which is what every
    /// job did before the customer could choose, so an older server that omits
    /// it changes nothing.
    /// </summary>
    [property: JsonPropertyName("orientation")] string? Orientation = null,
    /// <summary>
    /// The customer's page selection, e.g. "1-3, 5". Null means the whole
    /// document. The server has already billed for exactly these pages.
    /// </summary>
    [property: JsonPropertyName("pageRange")] string? PageRange = null
);

public record AgentPollResponse(
    [property: JsonPropertyName("jobs")] List<PrintJob> Jobs,
    /// <summary>
    /// A sheet to print before this batch: "none", "blank" or "invoice".
    ///
    /// Sent per batch rather than per job, because the decision is about how
    /// busy the counter is. Defaults to "none" so a server that does not send
    /// it, or an older one, changes nothing.
    /// </summary>
    [property: JsonPropertyName("separator")] string? Separator = null
);

public record AgentUpdateStatusDto(
    [property: JsonPropertyName("jobId")] string JobId,
    [property: JsonPropertyName("printState")] string PrintState,
    [property: JsonPropertyName("errorMessage")] string? ErrorMessage = null
);

/// <summary>A cash order waiting for the counter to say whether money changed hands.</summary>
public record CashJob(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("tokenNumber")] string? TokenNumber,
    [property: JsonPropertyName("fileName")] string FileName,
    [property: JsonPropertyName("pageCount")] int PageCount,
    [property: JsonPropertyName("copies")] int Copies,
    [property: JsonPropertyName("totalPriceInCents")] int TotalPriceInCents,
    [property: JsonPropertyName("customerName")] string? CustomerName = null
);

public record CashJobsResponse([property: JsonPropertyName("jobs")] List<CashJob> Jobs);
