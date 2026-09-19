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

    /// <summary>
    /// Runs an assertion with the allowlist environment variable set, and puts
    /// it back afterwards whatever happens. Tests share a process, and a leaked
    /// value here would silently widen the allowlist for every test after it.
    /// </summary>
    private static void WithAllowedHosts(string? value, Action assert)
    {
        string? saved = Environment.GetEnvironmentVariable(AgentSettings.AllowedHostsVariable);
        Environment.SetEnvironmentVariable(AgentSettings.AllowedHostsVariable, value);
        try
        {
            assert();
        }
        finally
        {
            Environment.SetEnvironmentVariable(AgentSettings.AllowedHostsVariable, saved);
        }
    }

    [Fact]
    public void An_administrator_can_add_a_host_without_rebuilding_the_agent()
    {
        // The API host was compiled in, so moving PrintOk to another domain
        // would have stopped every installed agent printing until each shop PC
        // was visited and reinstalled.
        WithAllowedHosts(null, () =>
            Assert.NotNull(AgentSettings.DescribeApiBaseUrlProblem("https://api.printok.app")));

        WithAllowedHosts("api.printok.app", () =>
            Assert.Null(AgentSettings.DescribeApiBaseUrlProblem("https://api.printok.app")));

        // Whoever sets this has the base URL to hand, so pasting the whole
        // thing is the obvious mistake and is accepted.
        WithAllowedHosts("https://api.printok.app/", () =>
            Assert.Null(AgentSettings.DescribeApiBaseUrlProblem("https://api.printok.app")));

        WithAllowedHosts("api.printok.app, api2.printok.app", () =>
        {
            Assert.Null(AgentSettings.DescribeApiBaseUrlProblem("https://api.printok.app"));
            Assert.Null(AgentSettings.DescribeApiBaseUrlProblem("https://api2.printok.app"));
        });
    }

    [Fact]
    public void The_allowlist_can_be_added_to_but_never_taken_away()
    {
        // The point of the allowlist is that someone at an unlocked counter
        // cannot retype the Server box and have every future print job — real
        // customers' documents — fetched from their own machine instead. A
        // setting that could shrink or replace the list would hand that person
        // the bypass, so this one only ever adds.
        WithAllowedHosts("evil.example.com", () =>
        {
            Assert.Null(AgentSettings.DescribeApiBaseUrlProblem("https://prinok-api.onrender.com"));
            Assert.Null(AgentSettings.DescribeApiBaseUrlProblem("http://localhost:4000"));
        });

        // Nothing in the value can remove the built-in entries.
        WithAllowedHosts("", () =>
            Assert.Null(AgentSettings.DescribeApiBaseUrlProblem("https://prinok-api.onrender.com")));
        WithAllowedHosts("   ", () =>
            Assert.Null(AgentSettings.DescribeApiBaseUrlProblem("https://prinok-api.onrender.com")));
    }

    [Theory]
    [InlineData("*.evil.example.com")]      // one careless wildcard admits every subdomain
    [InlineData("*")]
    [InlineData("evil.example.com/path")]
    public void A_wildcard_entry_admits_nothing(string entry)
    {
        WithAllowedHosts(entry, () =>
        {
            Assert.NotNull(AgentSettings.DescribeApiBaseUrlProblem("https://evil.example.com"));
            Assert.NotNull(AgentSettings.DescribeApiBaseUrlProblem("https://anything.evil.example.com"));

            // And the built-in hosts still work, so a bad entry degrades to the
            // previous behaviour rather than bricking the agent.
            Assert.Null(AgentSettings.DescribeApiBaseUrlProblem("https://prinok-api.onrender.com"));
        });
    }

    [Fact]
    public void An_added_host_is_still_held_to_https()
    {
        // Adding a host must not also relax transport: documents travelling in
        // clear text are readable by anything between the shop and the server.
        WithAllowedHosts("api.printok.app", () =>
        {
            string? problem = AgentSettings.DescribeApiBaseUrlProblem("http://api.printok.app");
            Assert.NotNull(problem);
            Assert.Contains("https", problem);
        });
    }
}
