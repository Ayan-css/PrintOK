; PrintOk Print Agent — Windows installer (Inno Setup 6)
;
; Build with:  iscc PrintOkAgent.iss
; Expects PrintOkAgent.exe (the published single-file desktop agent) in ..\dist\
;
; Deliberately a per-user install into LocalAppData rather than Program Files:
;
;   * no UAC prompt, so a shop owner can install it themselves without ringing
;     whoever set the PC up;
;   * the agent writes appsettings.json beside itself when settings are saved
;     from the window, which a Program Files install would refuse;
;   * the startup entry and the DPAPI-encrypted credential are per-user anyway,
;     so a machine-wide install would spread one agent's state across two places.
;
; The trade is that each Windows user account installs their own copy. A shop
; counter PC has one account, so that costs nothing here.

#define AppName        "PrintOk Print Agent"
#define AppShortName   "PrintOk"
#define AppVersion     "1.3.0"
#define AppPublisher   "PrintOk"
#define AppExe         "PrintOkAgent.exe"
#define AppUrl         "https://print-ok-customer-web.vercel.app"

[Setup]
AppId={{8F3C5A21-6B4D-4E7A-9C12-PRINTOK00001}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}
DefaultDirName={localappdata}\{#AppShortName}\Agent
DefaultGroupName={#AppShortName}
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=PrintOkAgentSetup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\PrintOk.Agent.Tray\printok.ico
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
; Windows 10 1809 and later. Older builds are below the .NET 8 floor anyway.
MinVersion=10.0.17763

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; \
  Description: "Start PrintOk automatically when this PC starts"; \
  GroupDescription: "Keep the shop online:"

Name: "launch"; \
  Description: "Open PrintOk when setup finishes"; \
  GroupDescription: "Keep the shop online:"

[Files]
Source: "..\dist\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion
; appsettings.json is optional. The agent knows the production address without
; it, so a shop that downloads only the installer still works; the file is only
; needed to point at a different server or name a specific printer.
Source: "..\windows-print-agent\appsettings.json"; DestDir: "{app}"; \
  Flags: ignoreversion onlyifdoesntexist

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{userdesktop}\{#AppShortName}"; Filename: "{app}\{#AppExe}"; Tasks: launch

[Run]
; Registers the logon task that restarts the agent if it stops. Run by the agent
; itself rather than by schtasks here, so one code path owns it and the settings
; toggle can turn it off again.
Filename: "{app}\{#AppExe}"; Parameters: "--install-autostart"; \
  Flags: runhidden waituntilterminated; Tasks: autostart

Filename: "{app}\{#AppExe}"; Description: "Open {#AppShortName}"; \
  Flags: nowait postinstall skipifsilent; Tasks: launch

[UninstallRun]
; Remove the scheduled task before the executable goes, or Windows is left with
; a task pointing at a file that no longer exists.
Filename: "{app}\{#AppExe}"; Parameters: "--remove-autostart"; \
  Flags: runhidden waituntilterminated; RunOnceId: "RemoveAutoStart"

[UninstallDelete]
Type: files; Name: "{app}\appsettings.json"

[Code]
{ Stops a running agent before overwriting its executable, otherwise Windows
  holds the file open and the install fails halfway with a confusing error. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec('taskkill.exe', '/IM {#AppExe} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    Exec('taskkill.exe', '/IM {#AppExe} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;
