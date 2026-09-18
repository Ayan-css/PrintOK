using PrintOk.WindowsPrintAgent.Models;
using Xunit;

namespace PrintOk.Agent.Core.Tests;

/// <summary>
/// Where the agent is allowed to send a shop's print jobs.
///
/// The Server field in the tray window was free text, written straight to the
/// settings file and used as the base address for everything the agent does. So
/// anyone who reached an unlocked counter PC could point it at their own server,
/// and every future job — customers' documents — would be fetched from and
/// reported to them. No credential needed, and nothing to see afterwards beyond
/// one line in a JSON file.
/// </summary>
public class AgentSettingsTests
{
    [Fact]
    public void Accepts_the_production_server()
    {
        Assert.Null(AgentSettings.DescribeApiBaseUrlProblem("https://prinok-api.onrender.com"));
        Assert.Null(AgentSettings.DescribeApiBaseUrlProblem("https://prinok-api.onrender.com/"));
    }

    [Fact]
    public void Accepts_loopback_so_the_agent_can_be_developed_against_a_local_api()
    {
        // Not somewhere a remote attacker can receive anything, so http is fine.
        Assert.Null(AgentSettings.DescribeApiBaseUrlProblem("http://localhost:4000"));
        Assert.Null(AgentSettings.DescribeApiBaseUrlProblem("http://127.0.0.1:4000"));
    }

    [Fact]
    public void Treats_blank_as_use_the_built_in_address()
    {
        // The recovery path for a shop that has pasted something wrong in.
        Assert.Null(AgentSettings.DescribeApiBaseUrlProblem(null));
        Assert.Null(AgentSettings.DescribeApiBaseUrlProblem(""));
        Assert.Null(AgentSettings.DescribeApiBaseUrlProblem("   "));
    }

    [Theory]
    [InlineData("https://evil.example.com")]
    [InlineData("https://prinok-api.onrender.com.evil.example.com")] // prefix trick
    [InlineData("https://attacker.test/prinok-api.onrender.com")]    // path trick
    public void Refuses_a_server_that_is_not_ours(string candidate)
    {
        string? problem = AgentSettings.DescribeApiBaseUrlProblem(candidate);
        Assert.NotNull(problem);
        // The message has to say why, because whoever typed it is usually the
        // shop owner and usually not an attacker.
        Assert.Contains("will not connect", problem);
    }

    [Fact]
    public void Refuses_plain_http_to_anywhere_but_loopback()
    {
        string? problem = AgentSettings.DescribeApiBaseUrlProblem("http://prinok-api.onrender.com");
        Assert.NotNull(problem);
        Assert.Contains("https", problem);
    }

    [Theory]
    [InlineData("not a url at all")]
    [InlineData("prinok-api.onrender.com")] // no scheme
    [InlineData("ftp://prinok-api.onrender.com")]
    [InlineData("file:///etc/passwd")]
    public void Refuses_anything_that_is_not_an_http_address(string candidate)
    {
        Assert.NotNull(AgentSettings.DescribeApiBaseUrlProblem(candidate));
    }
}
