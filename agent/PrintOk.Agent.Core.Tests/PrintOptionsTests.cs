using PrintOk.WindowsPrintAgent.Models;
using Xunit;

namespace PrintOk.Agent.Core.Tests;

/// <summary>
/// What the customer chose, as it arrives from the server.
///
/// These are the last hop before the print queue. Everything here has been paid
/// for at a rate that assumed it, so a value dropped or misread at this point is
/// a customer charged for one thing and handed another — which is exactly what
/// happened when duplex and paper size were not deserialised at all.
/// </summary>
public class PrintOptionsTests
{
    [Theory]
    [InlineData("portrait", PrintOrientation.Portrait)]
    [InlineData("PORTRAIT", PrintOrientation.Portrait)]
    [InlineData(" landscape ", PrintOrientation.Landscape)]
    [InlineData("auto", PrintOrientation.Auto)]
    // An older server sends nothing, and a newer one could send something this
    // build has never heard of. Both mean "the way the document was written",
    // which is what every job did before this was a choice.
    [InlineData(null, PrintOrientation.Auto)]
    [InlineData("", PrintOrientation.Auto)]
    [InlineData("sideways-ish", PrintOrientation.Auto)]
    public void Reads_the_orientation_the_server_sent(string? sent, PrintOrientation expected)
    {
        Assert.Equal(expected, PrintOptions.ParseOrientation(sent));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("nonsense")]
    public void Treats_no_usable_selection_as_the_whole_document(string? range)
    {
        Assert.Null(PrintOptions.ParsePageRange(range));
    }

    [Fact]
    public void Reads_a_page_selection_the_way_the_server_priced_it()
    {
        Assert.Equal(new[] { 1, 2, 3 }, PrintOptions.ParsePageRange("1-3"));
        Assert.Equal(new[] { 1, 2, 3, 5, 8, 9, 10 }, PrintOptions.ParsePageRange("1-3, 5, 8-10"));

        // Whitespace anywhere, because nobody types a range the same way twice.
        Assert.Equal(new[] { 2, 3, 4 }, PrintOptions.ParsePageRange(" 2 - 4 "));

        // A reversed span is the same span. Refusing it would fail a paid job
        // over the order two numbers were typed in.
        Assert.Equal(new[] { 4, 5, 6 }, PrintOptions.ParsePageRange("6-4"));

        // Overlaps collapse rather than printing a page twice.
        Assert.Equal(new[] { 1, 2, 3, 4 }, PrintOptions.ParsePageRange("1-3, 2-4"));

        // Page zero is not a page.
        Assert.Equal(new[] { 1, 2 }, PrintOptions.ParsePageRange("0, 1, 2"));
    }

    [Fact]
    public void Prints_every_page_when_nothing_was_selected()
    {
        var options = new PrintOptions("whole.pdf");
        Assert.Equal(new[] { 1, 2, 3, 4 }, options.PagesWithin(4));
    }

    [Fact]
    public void Prints_only_the_selected_pages()
    {
        var options = new PrintOptions("part.pdf", Pages: new[] { 1, 3 });
        Assert.Equal(new[] { 1, 3 }, options.PagesWithin(10));
    }

    [Fact]
    public void Drops_selected_pages_the_document_does_not_have()
    {
        // "1-3, 90" on a five-page file means the first three. Clamping 90 to 5
        // would print page five twice.
        var options = new PrintOptions("short.pdf", Pages: new[] { 1, 2, 3, 90 });
        Assert.Equal(new[] { 1, 2, 3 }, options.PagesWithin(5));
    }

    [Fact]
    public void Prints_the_whole_document_rather_than_nothing()
    {
        // A selection that survives no filtering at all has already been paid
        // for. Handing back a blank job is worse than printing everything.
        var options = new PrintOptions("odd.pdf", Pages: new[] { 40, 41 });
        Assert.Equal(new[] { 1, 2, 3 }, options.PagesWithin(3));
    }

    [Fact]
    public void Defaults_to_what_every_job_did_before_these_choices_existed()
    {
        var options = new PrintOptions("plain.pdf");

        Assert.Equal(1, options.Copies);
        Assert.False(options.IsColor);
        Assert.False(options.IsDuplex);
        Assert.Null(options.PaperSize);
        Assert.Equal(PrintOrientation.Auto, options.Orientation);
        Assert.Null(options.Pages);
    }
}
