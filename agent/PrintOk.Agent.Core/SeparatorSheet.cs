using Microsoft.Extensions.Logging;

namespace PrintOk.WindowsPrintAgent.Services;

/// <summary>
/// The sheet printed between batches on a busy counter.
///
/// Its whole job is to be obvious in a stack of paper, so a shop owner picking
/// up a pile can see where one customer's order ends and the next begins. That
/// makes a truly blank sheet a poor separator — it looks like a printer error
/// or a wasted page — so even "blank" carries a thick rule and a line of text.
///
/// Written as a PDF because that is what the rest of the pipeline already
/// prints: the same spooler, the same driver path, no second thing to go wrong
/// on a shop PC.
/// </summary>
public static class SeparatorSheet
{
    /// <summary>
    /// Writes a separator to a temp file and returns its path, or null if this
    /// batch does not want one.
    /// </summary>
    public static string? TryCreate(string? mode, int jobCount, ILogger logger)
    {
        if (string.IsNullOrWhiteSpace(mode) || mode == "none") return null;

        try
        {
            string heading = mode == "invoice"
                ? $"NEXT ORDER  -  {jobCount} job(s)"
                : "NEXT ORDER";

            string path = Path.Combine(Path.GetTempPath(), $"printok-separator-{Guid.NewGuid():N}.pdf");
            File.WriteAllBytes(path, BuildPdf(heading, DateTime.Now.ToString("HH:mm  d MMM yyyy")));
            return path;
        }
        catch (Exception ex)
        {
            // Never let a separator stop real work. A missing divider sheet is a
            // tidiness problem; a batch that did not print is a shop's morning.
            logger.LogWarning("Could not prepare a separator sheet: {Message}. Printing without one.", ex.Message);
            return null;
        }
    }

    /// <summary>
    /// A single-page A4 PDF, written by hand.
    ///
    /// No PDF library: the agent ships as a self-contained binary that a shop
    /// downloads over a phone connection, and adding a dependency to draw two
    /// lines of text is not a trade worth making.
    /// </summary>
    private static byte[] BuildPdf(string heading, string subheading)
    {
        string Escape(string s) => s.Replace("\\", "\\\\").Replace("(", "\\(").Replace(")", "\\)");

        // A4 at 72dpi is 595x842 points, origin bottom-left.
        string content = $$"""
            0 0 0 rg
            40 500 515 8 re f
            BT /F1 28 Tf 40 540 Td ({{Escape(heading)}}) Tj ET
            BT /F1 12 Tf 40 470 Td ({{Escape(subheading)}}) Tj ET
            40 440 515 3 re f
            """;

        var objects = new List<string>
        {
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
                + "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
            $"<< /Length {content.Length} >>\nstream\n{content}\nendstream",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        };

        var pdf = new System.Text.StringBuilder("%PDF-1.4\n");
        var offsets = new List<int>();

        for (int i = 0; i < objects.Count; i++)
        {
            offsets.Add(pdf.Length);
            pdf.Append($"{i + 1} 0 obj\n{objects[i]}\nendobj\n");
        }

        int xref = pdf.Length;
        pdf.Append($"xref\n0 {objects.Count + 1}\n0000000000 65535 f \n");
        foreach (int offset in offsets) pdf.Append($"{offset:D10} 00000 n \n");
        pdf.Append($"trailer\n<< /Size {objects.Count + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF");

        return System.Text.Encoding.ASCII.GetBytes(pdf.ToString());
    }
}
