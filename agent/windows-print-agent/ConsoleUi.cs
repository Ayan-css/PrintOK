using System.Runtime.InteropServices;

namespace PrintOk.WindowsPrintAgent.Services;

/// <summary>
/// The agent's console presentation, matched to the PrintOk web design.
///
/// The website is neo-brutalist: heavy borders, a hard rule, purple and yellow
/// on paper. A terminal gets the same language through the tools it actually
/// has — heavy box-drawing for the thick borders, the brand's own hex values as
/// truecolor, and the dashboard's job states rendered as the same badges a shop
/// owner sees in the browser.
///
/// The point is not decoration. A shop owner runs this on the counter PC and
/// glances at it between customers; it should be legible at arm's length and
/// recognisably the same product as the dashboard on the other screen.
///
/// Everything degrades. If colour is unavailable — redirected output, NO_COLOR,
/// a dumb terminal, an old Windows console that will not switch on VT — the same
/// text prints without escape codes rather than with them showing through as
/// garbage.
/// </summary>
public static class Ui
{
    // The web palette, verbatim from styles.css.
    private const string Esc    = "\u001b";
    private const string Purple = Esc + "[38;2;108;44;255m";  // --color-primary   #6c2cff
    private const string Yellow = Esc + "[38;2;245;196;0m";   // --color-secondary #f5c400
    private const string Green  = Esc + "[38;2;29;184;122m";  // --color-success   #1db87a
    private const string Red    = Esc + "[38;2;224;32;32m";   // --color-danger    #e02020
    private const string Amber  = Esc + "[38;2;245;166;35m";  // --color-warning   #f5a623
    private const string Muted  = Esc + "[38;2;136;136;128m"; // --color-text-muted
    private const string Bold   = Esc + "[1m";
    private const string Reset  = Esc + "[0m";

    private const int Width = 62;

    private static readonly bool ColorEnabled = DetectColorSupport();
    private static readonly bool UnicodeEnabled = TryEnableUnicode();

    /// <summary>
    /// Heavy box-drawing and check marks, or the ASCII that survives anywhere.
    ///
    /// A fresh Windows console starts on a legacy OEM codepage — 437 in most of
    /// the world, 850 in western Europe. Those have the light box-drawing
    /// characters, which is why a shop owner saw the rules under the section
    /// headings render correctly, and none of the heavy ones, which is why the
    /// banner around them came out as a row of question marks. Switching the
    /// console to UTF-8 fixes it where the console will accept the switch; where
    /// it will not, the same layout prints in ASCII rather than in "?".
    /// </summary>
    private static string G(string unicode, string ascii) => UnicodeEnabled ? unicode : ascii;

    private static bool TryEnableUnicode()
    {
        try
        {
            if (Console.IsOutputRedirected) return false;

            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                // Without the BOM: this is a console, and the encoding preamble
                // would print as stray characters on the first line.
                Console.OutputEncoding = new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
            }

            // Ask what actually took effect rather than trusting the assignment.
            // A console host that refuses the codepage leaves the old one in
            // place, and printing heavy box-drawing into that is the bug.
            return Console.OutputEncoding.CodePage == 65001;
        }
        catch
        {
            // Encoding is presentation. It never stops the agent starting.
            return false;
        }
    }

    private static string C(string code, string text) => ColorEnabled ? code + text + Reset : text;

    /// <summary>
    /// Colour is opt-out, but only where it will actually render.
    ///
    /// NO_COLOR is honoured because it is the convention, and redirected output
    /// is excluded because escape codes in a log file are noise a support
    /// request then has to read through — this agent's log is often the only
    /// evidence of what went wrong.
    /// </summary>
    private static bool DetectColorSupport()
    {
        try
        {
            if (Environment.GetEnvironmentVariable("NO_COLOR") is not null) return false;
            if (Console.IsOutputRedirected) return false;

            var term = Environment.GetEnvironmentVariable("TERM");
            if (string.Equals(term, "dumb", StringComparison.OrdinalIgnoreCase)) return false;

            // Windows consoles need virtual terminal processing switched on
            // before they interpret escapes; without it they print them.
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                return TryEnableWindowsVirtualTerminal();
            }

            return true;
        }
        catch
        {
            // Never let presentation stop the agent starting.
            return false;
        }
    }

    private const int StdOutputHandle = -11;
    private const uint EnableVirtualTerminalProcessing = 0x0004;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);

    private static bool TryEnableWindowsVirtualTerminal()
    {
        try
        {
            var handle = GetStdHandle(StdOutputHandle);
            if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return false;
            if (!GetConsoleMode(handle, out uint mode)) return false;
            if ((mode & EnableVirtualTerminalProcessing) != 0) return true;
            return SetConsoleMode(handle, mode | EnableVirtualTerminalProcessing);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>The masthead. Heavy rule, brand mark, version, platform.</summary>
    public static void Banner(string version, string platform)
    {
        Console.WriteLine();
        Console.WriteLine(C(Purple, "  " + G("┏", "+") + new string(G("━", "-")[0], Width - 2) + G("┓", "+")));
        Row(C(Bold, "PrintOk") + C(Muted, " · print agent"), "PrintOk · print agent",
            C(Yellow, version), version);
        Row(C(Muted, platform), platform, "", "");
        Console.WriteLine(C(Purple, "  " + G("┗", "+") + new string(G("━", "-")[0], Width - 2) + G("┛", "+")));
        Console.WriteLine();
    }

    /// <summary>
    /// One line inside the banner box.
    ///
    /// Colour codes occupy no columns but do occupy characters, so padding is
    /// measured from the plain text passed alongside each coloured fragment
    /// rather than from the fragment itself. Getting that wrong is what makes a
    /// boxed banner's right edge wander.
    /// </summary>
    private static void Row(string left, string leftPlain, string right, string rightPlain)
    {
        int fill = (Width - 4) - leftPlain.Length - rightPlain.Length;
        if (fill < 1) fill = 1;

        Console.WriteLine(C(Purple, "  " + G("┃", "|") + " ") + left + new string(' ', fill) + right + C(Purple, " " + G("┃", "|")));
    }

    /// <summary>A section heading, mirroring the dashboard's card titles.</summary>
    public static void Section(string title)
    {
        Console.WriteLine();
        Console.WriteLine("  " + C(Bold, title.ToUpperInvariant()));
        Console.WriteLine("  " + C(Muted, new string(G("─", "-")[0], Math.Min(Width, title.Length + 6))));
    }

    /// <summary>A label and value pair, aligned like the dashboard's meta rows.</summary>
    public static void Field(string label, string value)
        => Console.WriteLine("  " + C(Muted, label.PadRight(16)) + value);

    public static void Ok(string message)   => Console.WriteLine("  " + C(Green,  G("✔", "[OK]") + " ") + message);
    public static void Warn(string message) => Console.WriteLine("  " + C(Amber,  G("▲", "[!]")  + " ") + message);
    public static void Fail(string message) => Console.WriteLine("  " + C(Red,    G("✖", "[X]")  + " ") + message);
    public static void Info(string message) => Console.WriteLine("  " + C(Purple, G("›", ">")    + " ") + message);
    public static void Note(string message) => Console.WriteLine("  " + C(Muted, message));
    public static void Blank()              => Console.WriteLine();
    public static void Rule()               => Console.WriteLine("  " + C(Muted, new string(G("─", "-")[0], Width)));

    /// <summary>
    /// A job state, coloured to match the badge the same job shows in the
    /// merchant dashboard. The mapping is deliberately the one in styles.css, so
    /// the two screens never disagree about what "Queued" looks like.
    /// </summary>
    public static string Badge(string state) => state switch
    {
        "Queued"    => C(Purple, "[ QUEUED ]"),
        "Printing"  => C(Amber,  "[ PRINTING ]"),
        "Printed"   => C(Green,  "[ PRINTED ]"),
        "Completed" => C(Green,  "[ COMPLETED ]"),
        "Failed"    => C(Red,    "[ FAILED ]"),
        "Cancelled" => C(Red,    "[ CANCELLED ]"),
        _           => C(Muted,  "[ " + state.ToUpperInvariant() + " ]"),
    };

    /// <summary>The prompt used when asking for a pairing code.</summary>
    public static string? Prompt(string question)
    {
        Console.Write("  " + C(Yellow, "? ") + question + " ");
        return Console.ReadLine()?.Trim();
    }
}
