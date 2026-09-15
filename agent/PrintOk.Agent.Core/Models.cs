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
    [property: JsonPropertyName("printState")] string PrintState
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
