# PrintOk Windows Print Agent — Setup

The agent connects your shop PC to PrintOk and prints customer jobs automatically.
It is self-contained: you do **not** need to install .NET first.

## 1. Extract

Unzip `PrintAgent-win-x64.zip` somewhere permanent, e.g. `C:\PrintOk\`.
You should have `WindowsPrintAgent.exe` and `appsettings.json` side by side.

## 2. Get your settings file

1. Open your PrintOk dashboard and go to the **QR Poster & Agent** tab.
2. Click **Download appsettings.json**.
3. Replace the `appsettings.json` from the zip with the downloaded one, keeping it
   in the same folder as `WindowsPrintAgent.exe`.

The downloaded file already contains your shop's API key, printer ID and cloud URL.

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
Cloud API: https://prinok-api.onrender.com | Printer: prn_xxxxxxxx
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

**"No agent API key configured" and the agent exits**
`appsettings.json` is missing, is not in the same folder as the `.exe`, or still
contains the placeholder key. Re-download it from the dashboard.

**"Cloud API rejected the agent API key"**
The key no longer matches this printer. Re-download `appsettings.json`.

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
