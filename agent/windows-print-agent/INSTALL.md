# PrintOk Windows Print Agent — Setup

The agent connects your shop PC to PrintOk and prints customer jobs automatically.
It is self-contained: you do **not** need to install .NET first.

## 1. Extract

Unzip `PrintAgent-win-x64.zip` somewhere permanent, e.g. `C:\PrintOk\`.
You should have `WindowsPrintAgent.exe` and `appsettings.json` side by side.

## 2. Pair this PC (recommended)

Pairing gives this machine its own credential, so you can revoke one PC from the
dashboard without disturbing any of your other machines.

1. Open your PrintOk dashboard and go to the **QR Poster & Agent** tab.
2. Click **Pair New Agent** to get a code like `K7MP-3QRT`. It is single use and
   expires in 15 minutes.
3. Run the agent once with the code:

```
WindowsPrintAgent.exe --PairingCode=K7MP-3QRT
```

The agent stores its device token encrypted with Windows DPAPI under your user
account, in `%LOCALAPPDATA%\PrintOk\credentials.dat`. The token is never written
to `appsettings.json`, so sharing that file or a screenshot of it is harmless.

From then on, just run `WindowsPrintAgent.exe` with no arguments.

> The credential is tied to the Windows user account that paired. If you later run
> the agent as a different user, pair again.

### Alternative: settings file (legacy)

Installs that predate pairing can still use a shared key. Click **Download
appsettings.json** on the dashboard and place it next to `WindowsPrintAgent.exe`.
This key is shared by every agent on that printer and cannot be revoked
individually, so prefer pairing.

## 3. Choose the printer (optional)

By default the agent prints to this PC's **default Windows printer**. To target a
specific one, set `PrinterName` in `appsettings.json` to the exact name shown in
Windows Settings → Printers & scanners:

```json
"PrinterName": "Canon ImageRUNNER 2525"
```

## 4. Run

Double-click `WindowsPrintAgent.exe`. A console window opens and should log:

```
PrintOk Windows Print Agent 1.2.0
Cloud API: https://prinok-api.onrender.com | Printer: prn_xxxxxxxx | Auth: device token (dev_xxxxxxxx)
PrintOk Windows Print Agent started. Polling interval: 3000ms
WebSocket push channel connected.
```

Your dashboard's agent badge turns **online** within ~30 seconds.

Leave the window open. Closing it stops the agent and the shop goes offline.

## Running without a settings file

The agent also accepts command line arguments and `PRINTOK_`-prefixed environment
variables, which override `appsettings.json`:

```
WindowsPrintAgent.exe --AgentApiKey=prn_key_xxx --PrintOkApiUrl=https://prinok-api.onrender.com
```

## Start automatically on boot

Press `Win+R`, type `shell:startup`, and drop a shortcut to
`WindowsPrintAgent.exe` into the folder that opens.

## Troubleshooting

**"This agent is not paired and has no API key"**
Run it once with a pairing code: `WindowsPrintAgent.exe --PairingCode=XXXX-XXXX`.
If you are using the legacy settings file instead, check that `appsettings.json`
sits in the same folder as the `.exe` and no longer contains the placeholder key.

**"Cloud API rejected this device's token"**
The device was revoked from the dashboard, or the token expired. Generate a new
pairing code and pair again.

**"Stored credentials could not be decrypted"**
The agent is running as a different Windows user than the one that paired. Pair
again under the account that will run the agent.

**Dashboard shows the agent offline**
Check the console window is still open, and that the PC can reach the cloud URL
printed at startup. The agent retries automatically with backoff.

**Jobs fail with "Windows refused to print"**
Windows has no default application registered to print that file type. Install a
PDF reader (e.g. Adobe Acrobat Reader) and confirm you can right-click → Print the
file manually.

**Jobs stay queued and nothing happens**
Confirm the `PrinterId` in `appsettings.json` matches the printer shown on the
dashboard — one agent serves one printer.

---

## Running it on Linux or macOS (development)

The agent is a .NET 8 worker, and .NET is cross-platform, so the same code that
runs in shops also runs here. This is not a separate port — the only thing that
differs is which printing backend is resolved at startup:

| Host | Backend | How it prints |
|---|---|---|
| Windows | `WindowsPrinterSpooler` | The shell's `printto` / `print` verbs, one job per copy |
| Linux, macOS | `CupsPrinterSpooler` | CUPS `lp`, with copies and colour as flags on one job |

The choice is made once in `Program.cs` from the host OS. **Nothing about the
Windows path changed** when the CUPS one was added, and the release workflow
still publishes exactly the same `win-x64` executable.

### Prerequisites

```bash
# .NET SDK — Arch / EndeavourOS
sudo pacman -S dotnet-sdk

# CUPS, only if you want jobs to reach real paper
sudo pacman -S cups
sudo systemctl enable --now cups
lpstat -p -d          # should list at least one printer
```

Without a printer the agent still runs and still exercises pairing, polling, the
WebSocket push channel, downloading and status reporting — everything except the
final spool. Worth knowing: that covers most of what can go wrong.

### Run it

```bash
cd agent/windows-print-agent

./run-linux.sh --PairingCode=K7MP-3QRT     # first run, pairs this machine
./run-linux.sh                             # afterwards, uses the stored token
./run-linux.sh --publish                   # standalone binary in bin/linux-publish
```

Credentials are stored under `~/.local/share/PrintOk/`, and the log is at
`~/.local/share/PrintOk/agent.log`.

### Pointing it at a local API

```bash
PRINTOK_PrintOkApiUrl=http://localhost:4000 ./run-linux.sh --PairingCode=XXXX-XXXX
```

Any setting can be overridden by a `PRINTOK_`-prefixed environment variable,
which is usually easier than editing `appsettings.json` while testing.

### A note on colour

The console styling matches the dashboard's palette and job-state badges, and
switches itself off when it would not render — redirected output, `NO_COLOR`,
`TERM=dumb`, or a Windows console that will not enable virtual terminal
processing. The log file never contains escape codes.
