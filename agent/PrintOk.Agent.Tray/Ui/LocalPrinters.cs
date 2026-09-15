using System.Drawing.Printing;

namespace PrintOk.Agent.Tray.Ui;

/// <summary>
/// The printers Windows knows about on this PC.
///
/// The shop owner picks one of these in settings, and the printers tab shows
/// them so "the agent cannot see my printer" becomes a question they can answer
/// themselves instead of a support call.
/// </summary>
public static class LocalPrinters
{
    public sealed record Entry(string Name, bool IsDefault, bool SupportsColour, bool SupportsDuplex);

    public static IReadOnlyList<Entry> All()
    {
        var results = new List<Entry>();

        string defaultName = "";
        try
        {
            defaultName = new PrinterSettings().PrinterName ?? "";
        }
        catch
        {
            // No print subsystem at all (rare, but a locked-down PC can do this).
        }

        foreach (string? name in PrinterSettings.InstalledPrinters)
        {
            if (string.IsNullOrWhiteSpace(name)) continue;

            bool colour = false, duplex = false;
            try
            {
                var ps = new PrinterSettings { PrinterName = name };
                // IsValid guards against a stale queue left behind by an
                // uninstalled driver, which throws on every other property.
                if (ps.IsValid)
                {
                    colour = ps.SupportsColor;
                    duplex = ps.CanDuplex;
                }
            }
            catch
            {
                // Report the printer anyway; unknown capabilities are better
                // than omitting a printer the owner can plainly see in Windows.
            }

            results.Add(new Entry(
                name,
                string.Equals(name, defaultName, StringComparison.OrdinalIgnoreCase),
                colour,
                duplex));
        }

        return results;
    }
}
