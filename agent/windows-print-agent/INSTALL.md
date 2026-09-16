# PrintOk Print Agent — Setup

The agent connects your shop PC to PrintOk and prints customer jobs
automatically. It is self-contained: you do **not** need to install .NET first.

There are two ways to run it. **Almost every shop wants the first.**

| | Desktop agent | Console agent |
|---|---|---|
| Download | `PrintOkAgentSetup-x.y.z.exe` | `PrintAgent-win-x64.zip` |
| Looks like | A tray icon near the clock | A black terminal window |
| Starts with Windows | Yes, automatically | Only if you arrange it |
| If it stops | Restarts itself | Stays stopped |
| Closing the window | Keeps printing | **Stops printing** |
| Pairing | A dialog in the window | A command line argument |
| Best for | A shop counter | Servers, scripted installs |

---

# The desktop agent (recommended)

## 1. Install

Run `PrintOkAgentSetup-x.y.z.exe`. It installs for your Windows user only, so
there is no administrator prompt.

Leave **Start PrintOk automatically when this PC starts** ticked. That registers
a Windows task which starts the agent when you sign in and restarts it if it
ever stops.

> Windows may warn that the publisher is unknown. That is because the installer
> is not yet code-signed; see *Signing* at the bottom of this file.

## 2. Pair this PC

The window opens by itself the first time, because a new install has no
credential yet.

1. Open your PrintOk dashboard and go to the **QR Poster & Agent** tab.
2. Click **Pair New Agent** to get a code like `K7MP-3QRT`. It is single use and
   expires in 15 minutes.
3. In the agent window, open **This PC** and click **Pair this PC…**, then type
   the code.

The dialog shows the server it is about to contact. If pairing fails it tells
you which of two things happened — the server rejected the code, or it could not
be reached at all. Those need opposite fixes, so it never tells you to fetch a
fresh code when the code was never sent.

Pairing gives this machine its own credential, so you can revoke one PC from the
dashboard without disturbing any others. The token is encrypted with Windows
DPAPI under your user account in `%LOCALAPPDATA%\PrintOk\credentials.dat`, and
is never written to `appsettings.json` — so that file stays safe to screenshot
for support.

> The credential is tied to the Windows user account that paired. If you later
> sign in as a different user, pair again.

## 3. Day to day

Once paired, **you never need to open it**. It starts with Windows, sits in the
tray, and prints.

The tray icon carries a coloured dot:

| Dot | Meaning |
|---|---|
| Green | Connected and printing |
| Amber | Connected, but live updates are down — jobs still arrive, slightly slower |
| Amber, "Not paired" | No credential; open the window and pair |
| Red | Cannot reach PrintOk. **Nothing will print.** |

Windows shows a notification when it goes offline and again when it recovers, so
a shop finds out from the machine rather than from a customer.

**Double-click the icon** to open the window:

- **Status** — connection, last contact, and jobs printed this session
- **Printers** — every printer Windows can see, which is the default, and
  whether each supports colour and double-sided
- **This PC** — device, printer, shop and credential expiry; pair or re-pair
- **Settings** — start-with-Windows, which printer to print to, server address
- **Logs** — the recent log, with a button to copy it for a support request

**Closing the window does not stop the agent.** It returns to the tray and keeps
printing. To actually stop it, use **Quit** on the tray menu — it asks first,
because quitting takes the shop offline.

---

# The console agent

The original headless build. Use it for a server, an unattended install, or when
you want the agent under your own process supervision.

## 1. Extract

Unzip `PrintAgent-win-x64.zip` somewhere permanent, e.g. `C:\PrintOk\`.
You should have `WindowsPrintAgent.exe` and `appsettings.json` side by side.

If you downloaded only `WindowsPrintAgent.exe`, that is fine — it knows the
PrintOk cloud address on its own. `appsettings.json` is only needed to point the
agent somewhere else, or to name a specific printer.

## 2. Pair this PC

```
WindowsPrintAgent.exe --PairingCode=K7MP-3QRT
```

From then on, run `WindowsPrintAgent.exe` with no arguments.

**The window must stay open.** Closing it stops the agent and the shop goes
offline — which is the main reason the desktop agent exists.

### Alternative: settings file (legacy)

Installs that predate pairing can still use a shared key. Click **Download
appsettings.json** on the dashboard and place it next to `WindowsPrintAgent.exe`.
This key is shared by every agent on that printer and cannot be revoked
individually, so prefer pairing. Treat the downloaded file as a credential:
anyone holding it can act as this printer's agent until the key is changed.

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
  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
  ┃ PrintOk · print agent                                1.3.0 ┃
  ┃ Windows · X64                                              ┃
  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

  CONNECTED
  ───────────────
  Cloud API       https://prinok-api.onrender.com
  Printer         prn_xxxxxxxx
  Auth            device token (dev_xxxxxxxx)

  ✔ Ready. Keep this window open — closing it stops printing.
```

Your dashboard's agent badge turns **online** within ~30 seconds.

Leave the window open. Closing it stops the agent and the shop goes offline.

## Where the server address comes from

The agent already knows the PrintOk cloud address, so a bare
`WindowsPrintAgent.exe` works with no configuration at all. When more than one
source supplies it, the last one here wins:

| Priority | Source | Example |
|---|---|---|
| 1 (lowest) | Compiled-in default | `https://prinok-api.onrender.com` |
| 2 | `appsettings.json` beside the `.exe` | `"PrintOkApiUrl": "https://..."` |
| 3 | Environment variable | `PRINTOK_PrintOkApiUrl=https://...` |
| 4 (highest) | Command line | `--PrintOkApiUrl=https://...` |

So a development machine can still point at a local API:

```
WindowsPrintAgent.exe --PrintOkApiUrl=http://localhost:4000 --PairingCode=XXXX-XXXX
```

and a shop PC needs none of this. The agent prints the address it is about to
use as **Pairing with**, before it tries — if that line is wrong, nothing else
will work.

### Downloading appsettings.json

The download button in **QR Poster & Agent** authorises each download through
your dashboard session and hands the browser a link that is valid for two
minutes and works once. There is no permanent URL for this file: it contains
your printer's agent key, and printer ids appear on your QR poster, so a
standing link would let anyone who scanned the poster fetch your credentials.
If a download link fails, click the button again rather than reusing the old
link.

## Start automatically on boot

The desktop agent does this for you. For the console agent, press `Win+R`, type
`shell:startup`, and drop a shortcut to `WindowsPrintAgent.exe` into the folder
that opens. Note that this only starts it at sign-in; nothing restarts it if it
crashes.

## What it can print

The agent renders PDFs and images itself and sends the pages straight to the
Windows print queue. Nothing opens, nothing asks to be clicked, and the copies,
colour, double-sided and paper size the customer chose and paid for are applied
to the job.

| Format | How it prints |
| --- | --- |
| `.pdf` | Rendered by the agent at 300dpi |
| `.png` `.jpg` `.jpeg` `.webp` `.bmp` `.gif` `.tif` | Rendered by the agent |
| `.doc` `.docx` `.xls` `.xlsx` `.csv` `.ppt` `.pptx` | Handed to Word/Excel/PowerPoint, which print without showing a window |

Office formats are the one case that still needs other software on the PC. If
a shop has no Office installed, those jobs fail with a message saying so rather
than opening anything on the counter screen.

This used to work differently, and badly. The agent asked Windows to print the
file, which really means asking whichever application owns that file type to
print it — and for an image that application is the Windows Photo Printing
Wizard. It opened a dialog on the shop's counter PC, defaulted the paper type
to "Labels", and waited for the owner to press Print on every single customer
job. It also took no options at all, so colour, duplex and paper size were
whatever the printer driver happened to default to.

## Troubleshooting

**"This agent is not paired and has no API key"**
Run it once with a pairing code: `WindowsPrintAgent.exe --PairingCode=XXXX-XXXX`.
If you are using the legacy settings file instead, check that `appsettings.json`
sits in the same folder as the `.exe` and no longer contains the placeholder key.

**"Could not reach the PrintOk API at ... to pair"** / "the target machine
actively refused it"
The request never left this PC, so your pairing code has not been spent — it is
still valid. Either this PC is offline or blocked by a firewall, or the agent is
pointed at the wrong server. Check the address the agent prints as **Pairing
with** just above the error. If it says `localhost` you are running a build that
predates v1.2.1, or an `appsettings.json` beside the `.exe` is overriding the
address; either delete that file or correct its `PrintOkApiUrl`, or pass the
address directly:

```
WindowsPrintAgent.exe --PrintOkApiUrl=https://prinok-api.onrender.com --PairingCode=XXXX-XXXX
```

**The pairing code is rejected straight away**
Codes are single use and expire 15 minutes after they are generated, so a code
that has already paired a machine — or one left on screen over a lunch break —
will be refused. Generate a fresh one from **QR Poster & Agent**. The agent says
which of the two problems it hit: a rejection names the server's answer, an
unreachable API says the code was never used.

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

---

## Signing

The installer and both executables are currently unsigned, so Windows
SmartScreen shows *"Windows protected your PC"* and the publisher reads as
unknown. A shop owner has to click **More info → Run anyway**, which is exactly
the habit security training tells them not to form.

Before this is handed to shops at any scale it needs an authenticode
certificate, and the CI publish steps need a signing step added after each
`dotnet publish` and after Inno Setup produces the installer.
