#!/usr/bin/env bash
#
# Build and run the PrintOk print agent on Linux.
#
# The agent is a .NET 8 worker, and .NET is cross-platform, so this is the same
# code the shops run on Windows — not a separate port. The only part that
# differs is which IPrinterSpooler is resolved at startup: Windows shells out to
# the shell's print verbs, Linux and macOS go through CUPS.
#
#   ./run-linux.sh                      # build and run, using appsettings.json
#   ./run-linux.sh --PairingCode=XXXX-XXXX
#   ./run-linux.sh --publish            # produce a standalone binary instead
#
# Requires the .NET SDK. On Arch/EndeavourOS:
#     sudo pacman -S dotnet-sdk
#
# To actually print rather than just collect jobs, CUPS needs to be running with
# at least one printer:
#     sudo pacman -S cups
#     sudo systemctl enable --now cups
#     lpstat -p -d          # should list a printer
#
# A machine with no printer still exercises everything except the final spool:
# pairing, polling, the WebSocket push channel, download, and status reporting.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v dotnet >/dev/null 2>&1; then
  echo "The .NET SDK is not installed."
  echo "  Arch / EndeavourOS:  sudo pacman -S dotnet-sdk"
  echo "  Others:              https://dotnet.microsoft.com/download"
  exit 1
fi

if [[ "${1:-}" == "--publish" ]]; then
  shift
  OUT="${PWD}/bin/linux-publish"
  echo "Publishing a self-contained linux-x64 binary to ${OUT} ..."
  dotnet publish WindowsPrintAgent.csproj \
    -c Release \
    -r linux-x64 \
    --self-contained true \
    -p:PublishSingleFile=true \
    -o "$OUT"
  echo
  echo "Built: ${OUT}/WindowsPrintAgent"
  echo "Run it with:  ${OUT}/WindowsPrintAgent --PairingCode=XXXX-XXXX"
  exit 0
fi

# Plain `dotnet run` on this project would pick up the Windows default RID from
# the csproj, so the RID is named explicitly here.
exec dotnet run \
  --project WindowsPrintAgent.csproj \
  -r linux-x64 \
  --self-contained false \
  -- "$@"
