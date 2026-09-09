# PrintOk — Architecture & Setup Guide

## Overview

PrintOk is a hardware-free stationery printing platform. Customers scan a shop's QR code on their smartphone, upload a document (PDF, Word, Image), configure print settings (copies, color/bw), and pay online. The shop's existing Windows PC runs a background service (.NET 8) that pulls pending print jobs and streams them directly to the local printer spooler without requiring manual operator intervention.

---

## Prerequisites

* **Node.js**: v18.0.0 or higher
* **npm**: v9.0.0 or higher
* **.NET SDK**: 8.0 or higher (for Windows Print Agent)
* **Docker & Docker Compose**: (Optional, for running local PostgreSQL & MinIO object storage)

---

## Quick Start

1. **Clone & Run Setup Script**:
   ```bash
   git clone <repo-url> printok
   cd printok
   ./scripts/setup.sh
   ```

2. **Start Infrastructure Services (PostgreSQL + MinIO)**:
   ```bash
   docker compose up -d
   ```

3. **Run Database Migrations**:
   ```bash
   cd services/api
   npx prisma migrate dev --name init
   ```

4. **Start the API Server (HTTP + WebSocket)**:
   ```bash
   cd services/api
   npm run dev
   ```

5. **Start Customer Mobile Web App**:
   ```bash
   cd apps/customer-web
   npm start
   ```

6. **Run the Windows Print Agent (Development Mode)**:
   ```bash
   dotnet run --project agent/windows-print-agent
   ```

---

## System Architecture

```
[ Customer Mobile Web ] ──(REST/HTTPS)──► [ Cloud API (NestJS/Express) ] ◄──(Prisma)──► [ PostgreSQL ]
                                                   │
                                            (HTTPS / WebSocket)
                                                   │
                                                   ▼
                                     [ Windows Print Agent (.NET 8) ]
                                                   │
                                          (Win32 Spooler API)
                                                   │
                                                   ▼
                                         [ Physical Printer ]
```

### Storage Lifecycle
* Documents are stored in temporary S3-compatible storage (MinIO for dev, AWS S3 for production).
* Documents are automatically deleted immediately after successful printing or upon expiration (1 hour TTL).

### Security
* **Tamper-Proof Pricing**: Page counts and costs are calculated server-side (PDF parsing via `pdf-parse`).
* **Checksum Integrity**: Base64 raw bytes are hashed using SHA-256 both on the API and in the C# Windows agent to guarantee payload integrity.
* **Mutual Authentication**: Print agents authenticate using paired API keys sent in the `x-agent-api-key` header.
