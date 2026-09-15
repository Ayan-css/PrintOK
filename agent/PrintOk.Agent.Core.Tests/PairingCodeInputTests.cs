using PrintOk.WindowsPrintAgent.Services;
using Xunit;

namespace PrintOk.Agent.Core.Tests;

public class PairingCodeInputTests
{
    [Fact]
    public void Accepts_the_code_exactly_as_the_dashboard_prints_it()
    {
        Assert.True(PairingCodeInput.TryParse("DRC2-DWTK", out var code));
        Assert.Equal("DRC2-DWTK", code);
    }

    /// <summary>
    /// The failure this class was written for: the operator pasted the usage
    /// line from the agent's own error message into the pairing prompt, and the
    /// whole line was sent to the server as if it were the code.
    /// </summary>
    [Theory]
    [InlineData("WindowsPrintAgent.exe --PairingCode=DRC2-DWTK")]
    [InlineData("--PairingCode=DRC2-DWTK")]
    [InlineData("--PairingCode=drc2-dwtk")]
    [InlineData("/PairingCode=DRC2-DWTK")]
    [InlineData("PairingCode=DRC2DWTK")]
    [InlineData("WindowsPrintAgent.exe --PrintOkApiUrl=https://api.example --PairingCode=DRC2-DWTK")]
    [InlineData("WindowsPrintAgent.exe --PairingCode=\"DRC2-DWTK\"")]
    public void Finds_the_code_inside_a_pasted_command_line(string pasted)
    {
        Assert.True(PairingCodeInput.TryParse(pasted, out var code));
        Assert.Equal("DRC2-DWTK", code);
    }

    [Theory]
    [InlineData("drc2-dwtk")]
    [InlineData("DRC2DWTK")]
    [InlineData("  DRC2 - DWTK  ")]
    [InlineData("DRC2 DWTK")]
    [InlineData("drc2 dwtk\r\n")]
    public void Forgives_case_spacing_and_a_missing_hyphen(string typed)
    {
        Assert.True(PairingCodeInput.TryParse(typed, out var code));
        Assert.Equal("DRC2-DWTK", code);
    }

    [Theory]
    [InlineData("", PairingCodeInput.Problem.Empty)]
    [InlineData("   ", PairingCodeInput.Problem.Empty)]
    [InlineData(null, PairingCodeInput.Problem.Empty)]
    [InlineData("DRC2-DWT", PairingCodeInput.Problem.WrongLength)]
    [InlineData("DRC2-DWTKQ", PairingCodeInput.Problem.WrongLength)]
    [InlineData("WindowsPrintAgent.exe", PairingCodeInput.Problem.WrongLength)]
    public void Refuses_what_is_not_a_code_and_says_why(string? input, PairingCodeInput.Problem expected)
    {
        Assert.False(PairingCodeInput.TryParse(input, out var code, out var problem));
        Assert.Equal(string.Empty, code);
        Assert.Equal(expected, problem);
    }

    /// <summary>
    /// The alphabet has no I, L, O, 0 or 1 precisely so these cannot be
    /// ambiguous — which means an input carrying one was misread off the
    /// screen, and saying so is more use than "invalid".
    /// </summary>
    [Theory]
    [InlineData("DRC2-DWT0")]   // zero for Q
    [InlineData("DRCI-DWTK")]   // capital i
    [InlineData("DRC2-DWTKO")]
    public void Names_a_confusable_character_rather_than_calling_it_invalid(string misread)
    {
        Assert.False(PairingCodeInput.TryParse(misread, out _, out var problem));
        Assert.Equal(PairingCodeInput.Problem.ConfusableCharacter, problem);
    }

    /// <summary>
    /// Whatever comes out of here is sent to the server, so it has to be in the
    /// shape the server's own normaliser produces: four, hyphen, four.
    /// </summary>
    [Fact]
    public void Always_emits_the_canonical_shape()
    {
        foreach (var input in new[] { "ABCD-EFGH", "abcdefgh", "a b c d e f g h", "--PairingCode=ABCDEFGH" })
        {
            Assert.True(PairingCodeInput.TryParse(input, out var code), input);
            Assert.Matches("^[A-Z2-9]{4}-[A-Z2-9]{4}$", code);
        }
    }
}
