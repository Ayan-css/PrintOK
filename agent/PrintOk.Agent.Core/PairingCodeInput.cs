namespace PrintOk.WindowsPrintAgent.Services;

/// <summary>
/// Turns whatever a shop owner actually typed into a pairing code, or says
/// plainly that it is not one.
///
/// This exists because of a real pairing failure. The console agent prints a
/// usage line — <c>WindowsPrintAgent.exe --PairingCode=XXXX-XXXX</c> — and the
/// operator pasted that whole line into the "Pairing code:" prompt. The agent
/// sent all 46 characters of it to the server, the server found no such code,
/// and the agent then told them their code had expired and to generate a fresh
/// one. It had not expired. They generated another, pasted the same way, and
/// were told the same thing. Nothing in that loop could ever have succeeded.
///
/// So two jobs here. Pull the code out of a paste that carries a command line
/// around it, and refuse anything that is not a code <em>before</em> the network
/// is involved — a local "that is not a code" is the truth, where "the server
/// rejected it" was a lie that sent someone round the loop again.
/// </summary>
public static class PairingCodeInput
{
    /// <summary>
    /// The server's alphabet, verbatim from agentAuth.ts. It omits the
    /// characters people confuse by eye — I, L, O, 0, 1 — which is also what
    /// makes it a usable filter: a real code cannot contain them, so an input
    /// that does was misread rather than mistyped.
    /// </summary>
    private const string Alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

    private const int CodeLength = 8;

    /// <summary>What the operator got wrong, so the agent can say which.</summary>
    public enum Problem
    {
        None,
        Empty,
        /// <summary>Right characters, wrong number of them.</summary>
        WrongLength,
        /// <summary>Contains a character no pairing code ever has.</summary>
        ConfusableCharacter,
    }

    /// <summary>
    /// Parses <paramref name="raw"/> into the canonical <c>XXXX-XXXX</c> form.
    /// </summary>
    public static bool TryParse(string? raw, out string code, out Problem problem)
    {
        code = string.Empty;
        problem = Problem.None;

        if (string.IsNullOrWhiteSpace(raw))
        {
            problem = Problem.Empty;
            return false;
        }

        string candidate = ExtractArgumentValue(raw).Trim().Trim('"', '\'');

        // Report a misread character specifically, because "8 characters, and
        // that O should probably be a Q" is actionable where "invalid" is not.
        bool sawConfusable = false;
        var kept = new System.Text.StringBuilder(CodeLength);

        foreach (char raw1 in candidate)
        {
            char c = char.ToUpperInvariant(raw1);
            if (Alphabet.IndexOf(c) >= 0) { kept.Append(c); continue; }
            if (c is 'I' or 'L' or 'O' or '0' or '1') sawConfusable = true;
            // Anything else — spaces, hyphens, punctuation — is formatting the
            // operator added and is simply dropped.
        }

        if (kept.Length == 0)
        {
            problem = sawConfusable ? Problem.ConfusableCharacter : Problem.Empty;
            return false;
        }

        if (kept.Length != CodeLength)
        {
            // A confusable character is the better explanation when it is the
            // only thing standing between this and the right length.
            problem = sawConfusable && kept.Length + 1 == CodeLength
                ? Problem.ConfusableCharacter
                : Problem.WrongLength;
            return false;
        }

        if (sawConfusable)
        {
            // Eight good characters plus a stray I/O/1 is not a code with noise
            // in it — it is nine characters, one of them misread.
            problem = Problem.ConfusableCharacter;
            return false;
        }

        code = $"{kept.ToString(0, 4)}-{kept.ToString(4, 4)}";
        return true;
    }

    /// <summary>Convenience overload for callers that do not need the reason.</summary>
    public static bool TryParse(string? raw, out string code) => TryParse(raw, out code, out _);

    /// <summary>
    /// If the input carries a <c>--PairingCode=VALUE</c> switch, return VALUE.
    ///
    /// Matched without the leading dashes so that <c>/PairingCode=</c>,
    /// <c>-PairingCode=</c> and a bare <c>PairingCode=</c> all work — the
    /// operator is copying a usage line, not writing one.
    /// </summary>
    private static string ExtractArgumentValue(string raw)
    {
        const string Switch = "PairingCode=";

        int at = raw.IndexOf(Switch, StringComparison.OrdinalIgnoreCase);
        if (at < 0) return raw;

        int start = at + Switch.Length;
        int end = start;
        while (end < raw.Length && !char.IsWhiteSpace(raw[end])) end++;

        return raw.Substring(start, end - start);
    }
}
