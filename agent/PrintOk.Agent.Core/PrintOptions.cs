namespace PrintOk.WindowsPrintAgent.Models;

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
public sealed record PrintOptions(
    string FileName,
    int Copies = 1,
    bool IsColor = false,
    bool IsDuplex = false,
    string? PaperSize = null);
