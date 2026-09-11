# PrintOk — Production Deployment Guide

This guide provides step-by-step instructions for deploying the PrintOk hardware-free stationery printing platform to production cloud infrastructure. It details **two supported deployment methods**:

1. **Method 1: Standard Enterprise Cloud Infrastructure** (AWS S3 + Managed PostgreSQL + Render/DigitalOcean)
2. **Method 2: Supabase Accelerated Pilot Deployment** (Supabase Postgres + Supabase S3 Compatibility Endpoint — **Zero Code Changes**)

---

## Deployment Architecture Overview

```
                               ┌───────────────────────────┐
                               │  Customer Mobile Web App  │
                               │  (Vercel / Netlify Pages) │
                               └─────────────┬─────────────┘
                                             │ (HTTPS / REST)
                                             ▼
┌──────────────────────────┐   ┌───────────────────────────┐   ┌───────────────────────────┐
│  Temporary Object Store  │◄──┤      Cloud Backend API    ├──►│   Managed PostgreSQL DB   │
│ (AWS S3 / Supabase S3)   │   │   (Render / DigitalOcean) │   │ (Supabase / Neon / RDS)   │
└──────────────────────────┘   └─────────────┬─────────────┘   └───────────────────────────┘
                                             │
                                     (HTTPS / WebSocket)
                                             │
                                             ▼
                               ┌───────────────────────────┐
                               │   Windows Print Agent     │
                               │   (.NET 8 Service on PC)  │
                               └─────────────┬─────────────┘
                                             │ (Win32 Spooler)
                                             ▼
                               ┌───────────────────────────┐
                               │   Physical Shop Printer   │
                               └───────────────────────────┘
```

---

## Method 1: Standard Enterprise Cloud Infrastructure (AWS S3 + PostgreSQL)

Best suited for full-scale production deployments requiring granular AWS S3 lifecycle rules and dedicated cloud database management.

### 1. Database Provisioning
1. Provision a managed PostgreSQL instance (e.g. [Neon](https://neon.tech), [AWS RDS](https://aws.amazon.com/rds/), or [DigitalOcean Managed DB](https://www.digitalocean.com/products/managed-databases)).
2. Connection string format (`DATABASE_URL`):
   ```env
   DATABASE_URL="postgresql://user:password@production-host:5432/printok_prod?schema=public&sslmode=require"
   ```
3. Run Prisma migrations:
   ```bash
   cd services/api
   npx prisma migrate deploy
   ```

### 2. Temporary Storage Provisioning (AWS S3)
1. Create a dedicated S3 bucket (e.g., `printok-customer-documents-prod`).
2. **Privacy Rule (Auto-Cleanup)**: Add a Bucket Lifecycle Rule to automatically delete objects after **1 hour** (`ExpirationDays = 1` or lifecycle rule tag).
3. Create IAM credentials with `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` policies.
4. Environment Variables for API:
   ```env
   S3_ENDPOINT="https://s3.us-east-1.amazonaws.com"
   S3_REGION="us-east-1"
   S3_BUCKET_NAME="printok-customer-documents-prod"
   S3_ACCESS_KEY_ID="AKIA..."
   S3_SECRET_ACCESS_KEY="..."
   ```

---

## Method 2: Supabase Accelerated Pilot Deployment (Zero Code Changes)

Ideal for fast pilot testing with real stationery shops. Supabase provides both a managed PostgreSQL database and an S3-Compatible Storage API, requiring **zero changes** to the PrintOk codebase.

> [!TIP]
> **Why Supabase for Pilots?**
> Supabase provides a unified dashboard for PostgreSQL database hosting and S3-compatible document storage under a generous free tier. PrintOk's AWS S3 SDK integration connects seamlessly using Supabase's S3 Storage endpoint.

### 1. Create Supabase Project
1. Log into [Supabase Dashboard](https://supabase.com) and create a new project (e.g., `printok-pilot`).
2. Copy your PostgreSQL Connection String under **Project Settings ➔ Database ➔ Connection String (URI)**.
   ```env
   DATABASE_URL="postgresql://postgres:[YOUR-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres?sslmode=require"
   ```
3. Initialize Database Schema:
   ```bash
   cd services/api
   npx prisma migrate deploy
   ```

### 2. Configure Supabase S3 Storage Bucket
1. In the Supabase Dashboard, go to **Storage ➔ New Bucket**.
2. Name the bucket `printok-documents` and set privacy to **Private**.
3. Generate S3 Access Keys:
   - Go to **Project Settings ➔ Storage**.
   - Under **S3 Access Keys**, click **Create Access Key**.
   - Save the **Access Key ID** and **Secret Access Key**.
4. Configure S3 Environment Variables:
   ```env
   S3_ENDPOINT="https://[PROJECT-REF].supabase.co/storage/v1/s3"
   S3_REGION="global"
   S3_BUCKET_NAME="printok-documents"
   S3_ACCESS_KEY_ID="[SUPABASE-S3-ACCESS-KEY-ID]"
   S3_SECRET_ACCESS_KEY="[SUPABASE-S3-SECRET-ACCESS-KEY]"
   ```

### 3. Ephemeral File Clean-Up Strategy
* **Automated Agent Clean-Up**: PrintOk API & Windows Print Agent automatically delete the document payload immediately upon print job completion (`storage.deleteDocument()`).
* **Supabase Cron Clean-Up (Fallback)**: For abandoned unprinted jobs, enable `pg_cron` in Supabase SQL Editor:
   ```sql
   -- Auto-delete unprinted jobs older than 1 hour from DB queue
   SELECT cron.schedule(
     'cleanup-expired-jobs',
     '0 * * * *',
     $$ UPDATE "PrintJob" SET status = 'CANCELLED' WHERE status = 'AWAITING_PAYMENT' AND "createdAt" < NOW() - INTERVAL '1 hour' $$
   );
   ```

---

## 3. Backend API Cloud Deployment (Render / Railway / DigitalOcean)

Deploy `services/api` to any Node.js container service:

1. **Build Command**: `npm run build --workspace=@printok/api`
2. **Start Command**: `npm run start --workspace=@printok/api`
3. **Complete Environment Variable Template**:
   ```env
   PORT=4000
   NODE_ENV=production
   API_BASE_URL=https://api.yourdomain.com
   DATABASE_URL=postgresql://...
   
   # S3 Configuration (Method 1 or Method 2)
   S3_ENDPOINT=https://[s3-endpoint]
   S3_REGION=us-east-1
   S3_BUCKET_NAME=printok-documents
   S3_ACCESS_KEY_ID=...
   S3_SECRET_ACCESS_KEY=...

   # Application Secrets
   JWT_SECRET=your_production_secure_jwt_secret
   AGENT_PAIRING_SECRET=your_production_agent_secret

   # Razorpay Live Credentials
   RAZORPAY_KEY_ID=rzp_live_...
   RAZORPAY_KEY_SECRET=...
   RAZORPAY_WEBHOOK_SECRET=your_production_webhook_secret
   ```

---

## 4. Customer Web & Merchant Dashboard Deployment (Vercel)

Deploy `apps/customer-web` to Vercel or Cloudflare Pages:

1. Connect the GitHub repository `Ayan-css/PrintOK`.
2. **Root Directory**: `apps/customer-web`
3. **Build Command**: None (Static Web App with Vanilla JS/HTML/CSS)
4. **Output Directory**: `./`
5. **Environment Variables**:
   ```env
   NEXT_PUBLIC_API_URL=https://api.yourdomain.com
   ```

---

## 5. Live Razorpay Payment Gateway Configuration

1. Log into your [Razorpay Dashboard](https://dashboard.razorpay.com/) and switch to **Live Mode**.
2. Go to **Account & Settings ➔ Webhooks ➔ Add New Webhook**.
3. Set Webhook URL:
   ```text
   https://api.yourdomain.com/api/payments/webhook
   ```
4. Paste your `RAZORPAY_WEBHOOK_SECRET`.
5. Select Active Events: `order.paid`, `payment.captured`, `payment.failed`.
6. Save Webhook.

---

## 6. Building & Distributing the Windows Print Agent

To deploy the background print service to shop Windows computers:

1. **Compile Executable**:
   ```bash
   dotnet publish agent/windows-print-agent/WindowsPrintAgent.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o bin/publish
   ```
   The publish must be **self-contained**. A framework-dependent publish produces a
   ~150 KB apphost stub that cannot run without its sibling DLLs and an installed
   .NET 8 runtime, which no shop PC is guaranteed to have.

2. Executable location (Manual compilation):
   `bin/publish/WindowsPrintAgent.exe` (tens of MB — if it is ~150 KB, the publish was not self-contained).

3. **Automated CI/CD Compilation & Dashboard Download**:
   - The GitHub Actions workflow (`.github/workflows/build-print-agent.yml`) compiles a
     self-contained single-file `WindowsPrintAgent.exe` on a Windows runner and publishes it
     to the `latest` GitHub release, together with `PrintAgent-win-x64.zip` (executable +
     `appsettings.json` template + `README.txt` setup instructions).
   - Shop owners click **⬇️ Download PrintAgent.exe** on the merchant dashboard
     (endpoint `/api/agent-installer`), then **⚙️ Auto-Config (.json)** for their pre-filled
     settings. `/api/agent-installer?format=zip` returns the full bundle instead.

4. **Run on Shop PC**:
   Place `WindowsPrintAgent.exe` and `appsettings.json` in the same folder and run the
   executable. To start it automatically on boot, press `Win+R`, type `shell:startup`,
   and drop a shortcut to the executable into that folder.

5. **Agent Configuration (`appsettings.json` next to the executable)**:
   ```json
   {
     "PrintOkApiUrl": "https://api.yourdomain.com",
     "AgentApiKey": "paired_agent_key_here",
     "ShopId": "shop_123",
     "PrinterId": "printer_456",
     "PrinterName": "",
     "PollIntervalMs": 3000,
     "HeartbeatIntervalSeconds": 30
   }
   ```
   `PrinterName` is the exact Windows printer name; leave it empty to use the PC's default
   printer. The agent resolves these flat keys first and falls back to a nested `PrintOk`
   section, so configs emitted by older builds keep working. Settings can also be supplied as
   command line arguments (`--AgentApiKey=...`) or `PRINTOK_`-prefixed environment variables,
   both of which override the file.

   *(Shop owners can also click **⚙️ Auto-Config (.json)** on their dashboard to download pre-filled settings).*

   Full end-user setup and troubleshooting: `agent/windows-print-agent/INSTALL.md`.

---

## 7. Post-Deployment Verification Checklist

| Step | Test Action | Expected Result | Status |
| :--- | :--- | :--- | :--- |
| 1 | Mobile Customer Scan & Upload | PDF cost calculated server-side, Token `#001` generated | Pass |
| 2 | Live Razorpay Payment | Status updates `Paid` $\rightarrow$ `Queued` | Pass |
| 3 | Print Agent Spooling | Agent downloads doc, verifies SHA-256, spools to Win32 printer | Pass |
| 4 | Offline Heartbeat Alert | Merchant dashboard shows "Offline" alert if agent misses 45s heartbeat | Pass |
| 5 | Counter Cash Approval | Merchant clicks "⚡ Cash Approve", job auto-prints immediately | Pass |
| 6 | Ephemeral Payload Deletion | Document automatically removed from storage upon print completion | Pass |