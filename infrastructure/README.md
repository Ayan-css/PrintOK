# PrintOk — Infrastructure & Deployment

This directory contains configuration files and deployment scripts for infrastructure components.

## Local Infrastructure

* `docker-compose.yml` (located at root): Provisions local PostgreSQL database (`5432`) and MinIO S3 object storage (`9000` API, `9001` Console).

## Windows Print Agent Deployment

The Windows Print Agent can be published as a standalone executable or installed as a Windows Service using `sc.exe`:

```cmd
dotnet publish agent/windows-print-agent/PrintAgent.csproj -c Release -r win-x64 --self-contained
sc.exe create "PrintOkAgent" binPath= "C:\Path\To\PrintAgent.exe" start= auto
sc.exe start "PrintOkAgent"
```
