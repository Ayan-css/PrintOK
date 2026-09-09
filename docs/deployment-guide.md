# PrintOk — Production Deployment Guide

This guide provides step-by-step instructions for deploying the PrintOk hardware-free stationery printing platform to production cloud infrastructure.

---

## System Overview & Production Topology

```
                               ┌───────────────────────────┐
                               │  Customer Mobile Web App  │
                               │  (Vercel / Netlify Pages) │
                               └─────────────┬─────────────┘
                                             │ (HTTPS / REST)
                                             ▼
┌──────────────────────────┐   ┌───────────────────────────┐   ┌───────────────────────────┐
│   AWS S3 Object Storage  │◄──┤      Cloud Backend API    ├──►│  Managed PostgreSQL DB   │
│ (Temp 1-hr Document Storage)│ │   (Render / DigitalOcean) │   │ (Supabase / Neon / RDS)   │
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

## 1. Production Database Provisioning (PostgreSQL)

1. Provision a managed PostgreSQL instance (e.g. [Neon](https://neon.tech), [Supabase](https://supabase.com), or AWS RDS).
2. Obtain your production connection string (`DATABASE_URL`):
   ```env
   DATABASE_URL=postgresql://user:password@production-host:5432/printok_prod?schema=public&sslmode=require
   ```
3. Run Prisma migrations to initialize the database schema:
   ```bash
   cd services/api
   npx prisma migrate deploy
   ```

---

## 2. Temporary Object Storage Setup (AWS S3)

1. Create a dedicated S3 bucket in AWS (e.g., `printok-customer-documents-prod`).
2. **Lifecycle Rule (Privacy Enforcement)**: Configure a lifecycle rule to automatically delete any objects older than **1 hour** (ensures compliance with privacy defaults).
3. Create an IAM User with `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` permissions on the bucket.

---

## 3. Backend API Cloud Deployment

Deploy `services/api` to a Node.js-compatible container host (e.g., Render, Railway, DigitalOcean App Platform, AWS EC2):

1. **Build Command**: `npm run build --workspace=@printok/api`
2. **Start Command**: `npm run start --workspace=@printok/api`
3. **Environment Variables**:
   ```env
   PORT=4000
   NODE_ENV=production
   API_BASE_URL=https://api.yourdomain.com
   DATABASE_URL=postgresql://...
   S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
   S3_REGION=us-east-1
   S3_BUCKET_NAME=printok-customer-documents-prod
   S3_ACCESS_KEY_ID=AKIA...
   S3_SECRET_ACCESS_KEY=...
   JWT_SECRET=your_production_secure_jwt_secret
   AGENT_PAIRING_SECRET=your_production_agent_secret
   RAZORPAY_KEY_ID=rzp_live_...
   RAZORPAY_KEY_SECRET=...
   RAZORPAY_WEBHOOK_SECRET=your_production_webhook_secret
   ```

---

## 4. Customer Web App Deployment

Deploy `apps/customer-web` to a static/Node.js host (Vercel, Netlify, Cloudflare Pages):

1. Connect the GitHub repository `Ayan-css/PrintOK`.
2. **Root Directory**: `apps/customer-web`
3. **Start Command**: `npm start`

---

## 5. Live Razorpay Payment Gateway Configuration

1. Log into your [Razorpay Dashboard](https://dashboard.razorpay.com/) and toggle to **Live Mode**.
2. Navigate to **Account & Settings** ➔ **Webhooks** ➔ **Add New Webhook**.
3. Set the Webhook URL:
   ```text
   https://api.yourdomain.com/api/payments/webhook
   ```
4. Enter your `RAZORPAY_WEBHOOK_SECRET` string.
5. Select events: `order.paid` and `payment.captured`.
6. Click **Save Webhook**.

---

## 6. Building & Deploying the Windows Print Agent

To distribute the Windows Print Agent to shop owners:

1. **Compile Standalone Executable**:
   ```bash
   dotnet publish agent/windows-print-agent/PrintAgent.csproj -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
   ```
2. The compiled `.exe` will be generated at:
   `agent/windows-print-agent/bin/Release/net8.0/win-x64/publish/PrintAgent.exe`

3. **Install as a Windows Background Service (on Shop PC)**:
   ```cmd
   sc.exe create "PrintOkAgent" binPath= "C:\Program Files\PrintOk\PrintAgent.exe" start= auto
   sc.exe start "PrintOkAgent"
   ```
