namespace PrintOk.WindowsPrintAgent.Models;

/// <summary>
/// Which way up the page prints.
/// </summary>
public enum PrintOrientation
{
    /// <summary>Whatever the document says. What every job did before this was a choice.</summary>
    Auto,
    Portrait,
    Landscape,
}

/// <summary>
/// What the customer chose at checkout, carried through to the printer.
///
/// The spooler interface used to take only a file name, a copy count and a
/// colour flag, so duplex and paper size were dropped on the floor between the
/// server and the print queue. The customer picked A4 double-sided, the rate
/// card charged them for A4 double-sided, and the job printed on whatever the
/// driver felt like.
/// </summary>
/// <param name="FileName">Shown in the Windows print queue, so a shop owner can find it.</param>
/// <param name="Copies">Always at least one.</param>
/// <param name="IsColor">False means print in black and white even on a colour printer.</param>
/// <param name="IsDuplex">Double-sided, long edge.</param>
/// <param name="PaperSize">"A4", "A3", "Letter"… Null leaves the printer's default alone.</param>
/// <param name="Orientation">Auto leaves the document's own orientation alone.</param>
/// <param name="Pages">
/// One-based pages to print, or null for the whole document. The server has
/// already resolved the customer's "1-3, 5" against the real page count and
/// billed for exactly this many sheets, so printing anything else is printing
/// something nobody paid for.
/// </param>
public sealed record PrintOptions(
    string FileName,
    int Copies = 1,
    bool IsColor = false,
    bool IsDuplex = false,
    string? PaperSize = null,
    PrintOrientation Orientation = PrintOrientation.Auto,
    IReadOnlyList<int>? Pages = null)
{
    /// <summary>
    /// Reads "1-3, 5, 8-10" into one-based page numbers, or null for everything.
    ///
    /// Deliberately the same rules as the server's parser, which is the one that
    /// decided what to charge: whitespace anywhere, a reversed span means the
    /// same as a forward one, and anything unparseable is skipped rather than
    /// failing the job.
    /// </summary>
    public static IReadOnlyList<int>? ParsePageRange(string? range)
    {
        if (string.IsNullOrWhiteSpace(range)) return null;

        var pages = new SortedSet<int>();
        foreach (string part in range.Split(','))
        {
            string piece = part.Trim();
            if (piece.Length == 0) continue;

            int dash = piece.IndexOf('-');
            if (dash > 0)
            {
                if (int.TryParse(piece[..dash].Trim(), out int from)
                    && int.TryParse(piece[(dash + 1)..].Trim(), out int to))
                {
                    for (int i = Math.Min(from, to); i <= Math.Max(from, to); i++)
                    {
                        if (i >= 1) pages.Add(i);
                    }
                }
            }
            else if (int.TryParse(piece, out int single) && single >= 1)
            {
                pages.Add(single);
            }
        }

        return pages.Count > 0 ? pages.ToList() : null;
    }

    /// <summary>Reads the orientation the server sent, tolerating anything unexpected.</summary>
    public static PrintOrientation ParseOrientation(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        "portrait" => PrintOrientation.Portrait,
        "landscape" => PrintOrientation.Landscape,
        _ => PrintOrientation.Auto,
    };

    /// <summary>
    /// The pages to print, resolved against what the document actually has.
    ///
    /// A selection that survives no filtering at all means the whole document:
    /// better to print everything than to hand back a blank job for a range the
    /// customer has already been charged for.
    /// </summary>
    public IReadOnlyList<int> PagesWithin(int pageCount)
    {
        if (Pages is null || Pages.Count == 0)
        {
            return Enumerable.Range(1, Math.Max(1, pageCount)).ToList();
        }

        var kept = Pages.Where(p => p >= 1 && p <= pageCount).Distinct().OrderBy(p => p).ToList();
        return kept.Count > 0 ? kept : Enumerable.Range(1, Math.Max(1, pageCount)).ToList();
    }
}
