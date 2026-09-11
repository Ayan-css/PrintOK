# PrintOk — Infrastructure & Deployment

This directory contains configuration files and deployment scripts for infrastructure components.

## Local Infrastructure

* `docker-compose.yml` (located at root): Provisions local PostgreSQL database (`5432`) and MinIO S3 object storage (`9000` API, `9001` Console).

## Windows Print Agent Deployment

The Windows Print Agent is published as a self-contained single-file executable, so shop
PCs do not need the .NET runtime installed:

```cmd
dotnet publish agent/windows-print-agent/WindowsPrintAgent.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o bin\publish
```

Keep `appsettings.json` beside `WindowsPrintAgent.exe`; the agent resolves its configuration
relative to the executable's own folder. For autostart, place a shortcut to the executable in
the user's Startup folder (`Win+R` → `shell:startup`).

See `agent/windows-print-agent/INSTALL.md` for the full shop-side setup guide.
