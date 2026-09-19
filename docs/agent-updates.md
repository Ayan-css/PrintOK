# Pushing an agent build to the fleet

Fixing anything in the Windows agent used to mean every shop downloading an
installer and running it by hand. In practice that means a fleet stays on
whatever it was first given, and a defect found on one counter is never fixed on
the others.

This is the channel that fixes that. **It is also a remote code execution
channel** — whatever is published here runs, as a service, on every shop's
counter PC, beside the documents customers have paid to print. The design below
assumes the server might one day be lying.

## What is already true

- **Credentials survive an update.** They live in
  `%LOCALAPPDATA%\PrintOk\credentials.dat`, outside the install directory, so a
  shop never re-pairs. "Reinstall" was never the painful part; "get the
  installer onto the machine" was.
- **Every agent already reports its version** on every request
  (`x-agent-version`), and the server stores it per device. The fleet view is
  reading data that was already being collected.

## The three gates

An update has to pass all three. Each alone is enough to refuse.

| # | Gate | Where it lives | What it stops |
|---|---|---|---|
| 1 | **Download host allowlist** | Compiled into the agent | A compromised API pointing the fleet at an attacker's binary. The agent decides where it will fetch from; the manifest only proposes |
| 2 | **SHA-256 of the bytes** | Verified by the agent after download | A tampered or corrupted installer. Mismatch is deleted unrun |
| 3 | **Strictly newer only** | Both server and agent | A fleet being rolled backwards onto a build with a known defect |

Gate 1 is compiled in deliberately. Every other agent setting can be edited by
whoever is sitting at the PC; this one decides what code runs, so changing it
should require a new build.

**What this is not: code signing.** A signed installer verified against a
certificate would prove the build came from PrintOk, not merely that it matches
a hash the same server supplied. Until there is a certificate (~₹15–30k/year),
gate 1 carries that weight alone. Worth buying before the fleet is large.

## Publishing a build

1. Build and upload the installer to a **GitHub release** on the agent repo.
2. Take its checksum — on the machine that produced it, not after uploading:

   ```
   certutil -hashfile PrintOkAgentSetup.exe SHA256     # Windows
   sha256sum PrintOkAgentSetup.exe                     # Linux/macOS
   ```

3. `/admin` → **Print Agent Fleet** → *Publish a build*. Version, URL, checksum.
4. Leave rollout on **Notify only** for the first publication.
5. Watch the fleet panel: devices report their version as they check in.

### notify vs auto

**`notify`** — agents report the update and install nothing. This is the
default, because the install path has never run against a real Windows machine.

**`auto`** — agents download, verify and install it themselves.

**Test `auto` on one machine you can physically reach before using it on a
fleet.** The refusal paths are covered by tests; the part that is not is
Windows actually executing the installer, stopping the service, swapping the
files and starting it again.

### If a build turns out to be bad

**Pause it.** The fleet panel's paused flag stops it being offered to anyone
who has not already taken it, without publishing anything else.

To move machines that already took it, publish the previous version with
`force: true` — the API refuses a backwards publish otherwise, because rolling a
fleet backwards by mistyping a version is an accident worth catching.

Every publication is a row, never an update in place, with who published it and
when. A rollback is therefore visible rather than an erasure.

## What is NOT verified

Stated plainly, because the tests passing is not the same as this working:

- **No update has ever been installed on a real Windows machine.** The decision
  logic, the refusals, the version comparison and the checksum verification are
  covered by 93 agent tests. `Process.Start` on an installer, the service
  stopping and restarting, and the agent reconnecting afterwards are **not**.
- **The installer's silent-install flags are assumed.**
  `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART` is Inno Setup's syntax. If the
  installer is built with something else, they are wrong and the update will
  hang waiting for a dialog nobody is watching.
- **No rollback has been exercised.**
- **There is no code signing.**

## The first real test

On one machine you can walk up to:

1. Note the version in the fleet panel.
2. Publish a build one patch version higher, mode `auto`.
3. Watch that device's reported version change.
4. Confirm the shop did **not** have to re-pair, and that a print job still works.

Until that has happened, treat `auto` as untested and leave releases on
`notify`.
