using System.Security.Cryptography;
using PrintOk.Agent.Core;
using Xunit;

namespace PrintOk.Agent.Core.Tests;

/// <summary>
/// An update channel is a remote code execution channel: whatever it accepts is
/// what runs as a service on a shop's counter PC. So almost everything here
/// tests a refusal — the happy path is one case, and the ways this must say no
/// are the rest.
/// </summary>
public class UpdateCheckerTests
{
    private static UpdateManifest Manifest(
        string version = "2.0.0",
        string url = "https://github.com/Ayan-css/PrintOK/releases/download/v2.0.0/setup.exe",
        string? sha = Unset,
        string mode = "auto") => new()
        {
            UpToDate = false,
            Version = version,
            DownloadUrl = url,
            // ReferenceEquals, not ??: passing null explicitly must stay null.
            // Coalescing here turned the "no checksum at all" case into a valid
            // one, so that test was asserting the opposite of its name.
            Sha256 = ReferenceEquals(sha, Unset) ? new string('a', 64) : sha,
            Mode = mode,
        };

    /// <summary>Distinguishes "caller said null" from "caller said nothing".</summary>
    private const string Unset = "\u0000unset";

    private static UpdateChecker CheckerAt(string version) =>
        new(new HttpClient(), version);

    [Fact]
    public void Offers_an_update_when_the_published_build_is_newer()
    {
        UpdateDecision decision = CheckerAt("1.0.0").Evaluate(Manifest("2.0.0"));

        Assert.Equal(UpdateOutcome.Available, decision.Outcome);
        Assert.True(decision.ShouldInstall, "mode 'auto' means install it");
    }

    [Fact]
    public void Notify_mode_offers_the_update_but_does_not_install_it()
    {
        // The install path cannot be exercised without a Windows machine, so a
        // release defaults to notify and only becomes automatic deliberately.
        UpdateDecision decision = CheckerAt("1.0.0").Evaluate(Manifest(mode: "notify"));

        Assert.Equal(UpdateOutcome.Available, decision.Outcome);
        Assert.False(decision.ShouldInstall);
    }

    [Theory]
    [InlineData("1.0.0", "1.0.0")]  // same build
    [InlineData("2.0.0", "1.0.0")]  // server is behind, e.g. a manifest racing an update
    public void Never_installs_a_build_that_is_not_newer(string current, string offered)
    {
        UpdateDecision decision = CheckerAt(current).Evaluate(Manifest(offered));
        Assert.Equal(UpdateOutcome.None, decision.Outcome);
    }

    [Fact]
    public void Versions_compare_numerically_not_as_text()
    {
        // The bug this exists for only appears after ten releases: "1.10.0"
        // sorts before "1.9.0" as text, so a fleet would stop upgrading at 1.9
        // and every device would report itself current.
        Assert.True(UpdateChecker.CompareVersions("1.10.0", "1.9.0") > 0);
        Assert.True(UpdateChecker.CompareVersions("1.9.0", "1.10.0") < 0);
        Assert.Equal(0, UpdateChecker.CompareVersions("1.4", "1.4.0"));
        Assert.True(UpdateChecker.CompareVersions("2.0.0", "1.99.99") > 0);

        // A device that cannot say what it runs is offered the update.
        Assert.True(UpdateChecker.CompareVersions("1.0.0", "unknown") > 0);

        Assert.Equal(UpdateOutcome.Available, CheckerAt("1.9.0").Evaluate(Manifest("1.10.0")).Outcome);
    }

    [Theory]
    [InlineData("https://evil.example.com/setup.exe")]
    [InlineData("https://github.com.evil.example.com/setup.exe")]  // suffix trick
    [InlineData("http://github.com/setup.exe")]                    // replaceable in transit
    [InlineData("file:///C:/Windows/System32/calc.exe")]
    [InlineData("")]
    public void Refuses_to_download_from_anywhere_it_does_not_choose(string url)
    {
        // The agent decides where it will fetch from, not the server. A server
        // that has been taken over can say anything; it still cannot make this
        // machine run a binary from somewhere else.
        Assert.False(UpdateChecker.IsAllowedDownload(url, out string? problem));
        Assert.NotNull(problem);

        UpdateDecision decision = CheckerAt("1.0.0").Evaluate(Manifest(url: url));
        Assert.Equal(UpdateOutcome.Refused, decision.Outcome);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("deadbeef")]                 // too short
    [InlineData("not-hex-at-all-but-64-characters-long-xxxxxxxxxxxxxxxxxxxxxxxxxxx")]
    public void Refuses_an_update_it_cannot_verify(string? sha)
    {
        // Without a usable checksum there is no way to tell the published build
        // from a substituted one, so nothing is downloaded at all.
        UpdateDecision decision = CheckerAt("1.0.0").Evaluate(Manifest(sha: sha!));
        Assert.Equal(UpdateOutcome.Refused, decision.Outcome);
        Assert.Contains("verif", decision.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void An_up_to_date_answer_and_a_missing_one_both_mean_do_nothing()
    {
        Assert.Equal(UpdateOutcome.None, CheckerAt("1.0.0").Evaluate(null).Outcome);
        Assert.Equal(UpdateOutcome.None,
            CheckerAt("1.0.0").Evaluate(new UpdateManifest { UpToDate = true }).Outcome);
    }

    [Fact]
    public void An_update_offered_without_a_version_is_refused()
    {
        UpdateDecision decision = CheckerAt("1.0.0").Evaluate(Manifest(version: ""));
        Assert.Equal(UpdateOutcome.Refused, decision.Outcome);
    }

    [Fact]
    public async Task A_file_is_only_accepted_when_its_bytes_match_what_was_published()
    {
        // The gate that makes a tampered release fail closed. Hashing a real
        // file rather than asserting on the comparison, because the thing worth
        // pinning is that the digest is computed over the bytes on disk.
        string path = Path.Combine(Path.GetTempPath(), $"printok-update-test-{Guid.NewGuid():N}.bin");
        await File.WriteAllTextAsync(path, "pretend installer");

        try
        {
            string actual = await UpdateChecker.ComputeSha256Async(path);
            Assert.True(UpdateChecker.IsSha256(actual));

            using var sha = SHA256.Create();
            string expected = Convert.ToHexString(
                sha.ComputeHash(await File.ReadAllBytesAsync(path))).ToLowerInvariant();
            Assert.Equal(expected, actual);

            // One changed byte is a different file.
            await File.WriteAllTextAsync(path, "pretend installer.");
            Assert.NotEqual(actual, await UpdateChecker.ComputeSha256Async(path));
        }
        finally
        {
            if (File.Exists(path)) File.Delete(path);
        }
    }

    [Fact]
    public void Will_not_launch_an_installer_that_is_not_there()
    {
        LaunchResult result = UpdateChecker.LaunchInstaller(
            Path.Combine(Path.GetTempPath(), $"missing-{Guid.NewGuid():N}.exe"));

        Assert.False(result.Ok);
        Assert.NotNull(result.Error);
    }
}
