using System.Diagnostics;
using Microsoft.Win32;

namespace PrintOk.Agent.Tray.Startup;

/// <summary>
/// Makes the agent come back by itself after a restart.
///
/// A shop PC is switched off at closing time and on again in the morning, and
/// nobody is going to remember to start a print agent before the first customer
/// walks in. Two mechanisms, tried in order:
///
///   1. A Scheduled Task that runs at logon and restarts the agent if it dies.
///      This is the one that matters: it survives a crash, not just a reboot.
///   2. The HKCU Run key, as a fallback. It runs at logon too but does nothing
///      about a crash.
///
/// Both run as the logged-in shop user, deliberately. The Windows spooler path
/// shells out to the shell's print verbs, which need a real user session — a
/// true Session 0 service would start earlier and then fail to print, which is
/// a worse failure than starting a few seconds later.
///
/// Neither needs administrator rights, so the agent can repair its own startup
/// entry without a UAC prompt the shop owner would have to approve.
/// </summary>
public static class AutoStart
{
    public const string TaskName = "PrintOk Print Agent";
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValue = "PrintOkAgent";

    public enum Method { None, ScheduledTask, RunKey }

    /// <summary>Where the agent's executable actually lives.</summary>
    public static string ExecutablePath =>
        Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName ?? "";

    /// <summary>What is currently arranged, so the settings tab can tell the truth.</summary>
    public static Method Current()
    {
        if (ScheduledTaskExists()) return Method.ScheduledTask;

        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey);
            if (key?.GetValue(RunValue) is string v && v.Contains("PrintOk", StringComparison.OrdinalIgnoreCase))
            {
                return Method.RunKey;
            }
        }
        catch
        {
            // A locked-down or roaming profile can refuse; report nothing rather
            // than claiming a state we could not read.
        }

        return Method.None;
    }

    public static bool IsEnabled() => Current() != Method.None;

    /// <summary>
    /// Turns startup on, preferring the scheduled task.
    ///
    /// Returns which mechanism ended up in place, so the UI can say "restarts
    /// if it stops" rather than promising something the fallback cannot do.
    /// </summary>
    public static Method Enable()
    {
        string exe = ExecutablePath;
        if (string.IsNullOrWhiteSpace(exe)) return Method.None;

        if (TryCreateScheduledTask(exe)) return Method.ScheduledTask;
        return TryWriteRunKey(exe) ? Method.RunKey : Method.None;
    }

    public static void Disable()
    {
        RunSchtasks($"/Delete /TN \"{TaskName}\" /F");

        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
            key?.DeleteValue(RunValue, throwOnMissingValue: false);
        }
        catch
        {
            // Nothing actionable: the toggle re-reads state afterwards and will
            // show that it is still on.
        }
    }

    // ------------------------------------------------------------ scheduled task ---

    private static bool ScheduledTaskExists() =>
        RunSchtasks($"/Query /TN \"{TaskName}\"") == 0;

    /// <summary>
    /// Registers the logon task.
    ///
    /// Written as XML rather than the /Create shorthand because the two settings
    /// that make this worth doing — restart on failure, and no execution time
    /// limit — cannot be expressed on the command line.
    /// </summary>
    private static bool TryCreateScheduledTask(string exe)
    {
        string xmlPath = Path.Combine(Path.GetTempPath(), $"printok-agent-task-{Guid.NewGuid():N}.xml");

        string xml = $"""
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Keeps the PrintOk print agent running so the shop can accept print jobs.</Description>
    <URI>\{TaskName}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{SecurityElementEscape(Environment.UserDomainName + "\\" + Environment.UserName)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{SecurityElementEscape(Environment.UserDomainName + "\\" + Environment.UserName)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <!-- Zero means no limit. The default is three days, after which Windows
         would kill a perfectly healthy agent mid-shift. -->
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{SecurityElementEscape(exe)}</Command>
      <Arguments>--background</Arguments>
      <WorkingDirectory>{SecurityElementEscape(Path.GetDirectoryName(exe) ?? "")}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
""";

        try
        {
            // schtasks /XML insists on UTF-16, and silently misreads UTF-8.
            File.WriteAllText(xmlPath, xml, System.Text.Encoding.Unicode);
            return RunSchtasks($"/Create /TN \"{TaskName}\" /XML \"{xmlPath}\" /F") == 0;
        }
        catch
        {
            return false;
        }
        finally
        {
            try { File.Delete(xmlPath); } catch { /* temp file; not worth reporting */ }
        }
    }

    private static string SecurityElementEscape(string value) =>
        System.Security.SecurityElement.Escape(value) ?? value;

    private static int RunSchtasks(string arguments)
    {
        try
        {
            var psi = new ProcessStartInfo("schtasks.exe", arguments)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };

            using var p = Process.Start(psi);
            if (p is null) return -1;
            p.WaitForExit(15000);
            return p.HasExited ? p.ExitCode : -1;
        }
        catch
        {
            return -1;
        }
    }

    // ------------------------------------------------------------------ run key ---

    private static bool TryWriteRunKey(string exe)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
            if (key is null) return false;
            key.SetValue(RunValue, $"\"{exe}\" --background");
            return true;
        }
        catch
        {
            return false;
        }
    }
}
