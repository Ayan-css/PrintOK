# Contributing to PrintOk — Developer & Reading Guide

> **Who this is for**: A developer who has never seen this codebase before and wants to understand it well enough to contribute safely.
> **How to use it**: Read the sections **in order**. Each section builds on the last. Don't skip ahead.

---

## Part 0 — The One-Paragraph Mental Model (Read This First)

A customer scans a QR code on a shop counter with their phone. That opens a web page where they upload a PDF, choose options, and pay. The payment is confirmed by a webhook. A Windows desktop app running silently on the shop's PC polls the API for new paid jobs, downloads the file, and sends it directly to the printer. The shop owner never needs to touch a browser.

```
Customer Phone
  └─ scan QR ──► printok.store/?printer=prn_xxx
  └─ upload PDF, pay
        │  HTTPS
        ▼
   Cloud API  (Node.js / Express / Prisma)
        │ stores job + PDF in PostgreSQL + S3
        │ webhook ← Razorpay confirms payment
        │
        ▼
   Windows Print Agent  (C# .NET, runs on shop PC)
        │ polls or gets pushed via WebSocket
        └─ downloads file, prints, reports back
```

Everything else in this codebase is scaffolding for that flow.

---

## Part 1 — The Contract: Read These First Before Any Code

These files define the *language* the whole system speaks. Read them before touching any implementation file.

### 1.1 [`packages/shared-types/src/index.ts`](packages/shared-types/src/index.ts)

**Time: ~15 min**

This is the single source of truth for every domain concept. Read it top to bottom.

Key things to absorb:
- `PaymentState` enum — 7 states. Payment is *completely independent* of print state. Never derive one from the other.
- `PrintState` enum — 13 states. Memorise the happy path: `Created → AwaitingPayment → Queued → Assigned → Downloading → Printing → Printed → Completed`.
- `PriceSnapshot` interface — frozen at job creation. Changing a shop's rates never restates past orders.
- `Printer`, `PrintJob`, `Shop`, `MerchantPricingConfig` — all the core data shapes.

> [!IMPORTANT]
> **Payment state ≠ Print state.** This is the #1 rule of this codebase. A paid job is not yet a printed job. A printed job does not mean payment succeeded. The architecture enforces this separation deliberately.

### 1.2 [`services/api/prisma/schema.prisma`](services/api/prisma/schema.prisma)

**Time: ~10 min**

The database schema. Read this to understand how the domain types above map to actual tables. Every model here corresponds to an interface in `shared-types`. Notice:
- `PrintJob` has *both* `paymentState` and `printState` as separate columns.
- `Printer` stores `qrCodeDataUrl` as a base64 PNG — baked at creation time, not generated on the fly.
- `AgentDevice` is separate from `Printer` — each shop PC gets its own credentials.

---

## Part 2 — The API: The Heart of the Backend

### 2.1 [`services/api/src/env.ts`](services/api/src/env.ts)

**Time: 3 min**

Read this first when looking at the API. It explains *why* env loading must happen before anything else, and what happens when secrets are missing. Very short file.

### 2.2 [`services/api/src/server.ts`](services/api/src/server.ts)

**Time: 5 min**

The entrypoint. It:
1. Checks required env vars (fail fast, not at runtime).
2. Runs database migrations.
3. Picks `PrismaStorage` (Postgres) or `MemoryStorage` (local dev with no Docker).
4. Creates the HTTP server, then the WebSocket server, then the Express app.
5. Starts the stale-job recovery sweep every 60 seconds.

### 2.3 [`services/api/src/storage.ts`](services/api/src/storage.ts)

**Time: 30 min**

This is the **storage interface + MemoryStorage implementation** in one file. Read the `IStorageProvider` interface at the top — it defines every database operation the app ever performs. Then skim `MemoryStorage` to see the simplest possible implementation.

Key insight: **all business rules live here, not in the routes**. State machine enforcement, document retention, pricing snapshots — the route handlers in `app.ts` call storage methods, they don't implement business logic themselves.

### 2.4 [`services/api/src/jobStateMachine.ts`](services/api/src/jobStateMachine.ts)

**Time: 10 min**

Small, critical file. It defines which state transitions are legal. Every `storage.transitionPrintState()` call goes through this. Read the transition table — it's the authoritative spec for what can move where.

### 2.5 [`services/api/src/app.ts`](services/api/src/app.ts)

**Time: Read in sections over multiple days**

This is a ~5,400-line file. **Do not read it linearly.** Instead, use it as a reference. Navigate by route groups:

| Route prefix | What it does |
|---|---|
| `/api/merchant/signup`, `/api/merchant/login` | Shop registration and auth |
| `/api/shops/*` | Shop profile, pricing config, staff, plans |
| `/api/printers/*` | Printer management, QR, agent pairing |
| `/api/jobs/*` | Customer file upload, job creation, status |
| `/api/payments/*` | Razorpay webhook handling |
| `/api/agent/*` | Windows print agent polling protocol |
| `/api/admin/*` | Platform operator console |

Use search to jump to the route you need. Each route group is comment-separated.

---

## Part 3 — The Business Logic Modules (Read in Any Order)

These are small focused files. Read whichever is relevant to what you're working on.

| File | What it does | When to read it |
|---|---|---|
| [`services/api/src/corsPolicy.ts`](services/api/src/corsPolicy.ts) | Which browser origins can call the API | Before any API work |
| [`services/api/src/agentAuth.ts`](services/api/src/agentAuth.ts) | Device token issuance, pairing codes | Before touching agent auth |
| [`services/api/src/adminAuth.ts`](services/api/src/adminAuth.ts) | Merchant JWT + admin JWT | Before touching auth routes |
| [`services/api/src/pricing.ts`](services/api/src/pricing.ts) | Price calculation logic | Before touching job pricing |
| [`services/api/src/documentRetention.ts`](services/api/src/documentRetention.ts) | When to delete uploaded PDFs | Before touching file cleanup |
| [`services/api/src/documentProcessor.ts`](services/api/src/documentProcessor.ts) | PDF page counting, validation | Before touching upload handling |
| [`services/api/src/jobRecovery.ts`](services/api/src/jobRecovery.ts) | Reclaiming stuck/abandoned jobs | Before touching the recovery sweep |
| [`services/api/src/ws.ts`](services/api/src/ws.ts) | WebSocket push to print agent | Before touching real-time job dispatch |
| [`services/api/src/s3Storage.ts`](services/api/src/s3Storage.ts) | Upload/download of PDFs to S3 | Before touching file storage |
| [`services/api/src/email.ts`](services/api/src/email.ts) | Password reset emails | Before touching email sending |
| [`services/api/src/qr.ts`](services/api/src/qr.ts) | QR code image generation | Before touching QR features |

---

## Part 4 — The Frontend

The frontend is a static HTML/JS/CSS site with no build step. No React. No bundler. What you see in `apps/customer-web/public/` is exactly what gets served.

### 4.1 HTML Pages — What Exists

| File | Route | Who uses it |
|---|---|---|
| [`apps/customer-web/public/index.html`](apps/customer-web/public/index.html) | `/` | Landing + customer print flow (same page, different screens) |
| [`apps/customer-web/public/print.html`](apps/customer-web/public/print.html) | `/print` | Customer print page (QR scan lands here) |
| [`apps/customer-web/public/register.html`](apps/customer-web/public/register.html) | `/register` | New shop signup wizard |
| [`apps/customer-web/public/dashboard.html`](apps/customer-web/public/dashboard.html) | `/dashboard` | Merchant control panel |
| [`apps/customer-web/public/admin.html`](apps/customer-web/public/admin.html) | `/admin` | Platform operator console |
| [`apps/customer-web/public/setup.html`](apps/customer-web/public/setup.html) | `/setup` | Guided first-time shop setup |

### 4.2 [`apps/customer-web/public/app.js`](apps/customer-web/public/app.js)

**Time: Read in sections**

One large JS file (~4,100 lines) handles all pages. Navigate using the section comments:

```javascript
// ============================================================
//  1. REGISTRATION FLOW (register.html)
//  2. MERCHANT DASHBOARD (dashboard.html)
//  3. CUSTOMER MOBILE PRINTING DRIVER (index.html / ?printer=)
// ============================================================
```

Key patterns to understand:
- `MerchantSession` — manages the merchant JWT in `localStorage`.
- `shopFetch(path, options)` — authenticated fetch that auto-handles 401 sign-out.
- `showToast(type, title, message)` — the uniform way to show feedback.
- `ShopContext` — stores `shopId` + `printerId` in localStorage for the dashboard.

### 4.3 Supporting JS Files

| File | Purpose |
|---|---|
| [`apps/customer-web/public/scan.js`](apps/customer-web/public/scan.js) | Camera scan + document upload |
| [`apps/customer-web/public/admin.js`](apps/customer-web/public/admin.js) | Admin console logic |
| [`apps/customer-web/public/setup.js`](apps/customer-web/public/setup.js) | Setup wizard |
| [`apps/customer-web/public/poster.js`](apps/customer-web/public/poster.js) | A4 QR poster generator |
| [`apps/customer-web/public/theme.js`](apps/customer-web/public/theme.js) | Dark/light mode toggle |
| [`apps/customer-web/public/site-config.js`](apps/customer-web/public/site-config.js) | Runtime config (API base URL) |
| [`apps/customer-web/public/session.js`](apps/customer-web/public/session.js) | Shared session helpers |

---

## Part 5 — The Windows Print Agent

The agent is a C# .NET 8 application that runs silently on the shop's PC.

### 5.1 Reading Order

Read these files in this order:

1. **[`agent/PrintOk.Agent.Core/Models.cs`](agent/PrintOk.Agent.Core/Models.cs)** — Data transfer objects: `PrintJobDto`, `AgentPollResponse`, etc.

2. **[`agent/PrintOk.Agent.Core/AgentSettings.cs`](agent/PrintOk.Agent.Core/AgentSettings.cs)** — How the agent reads `appsettings.json`, env vars, and CLI args.

3. **[`agent/PrintOk.Agent.Core/PrintAgentWorker.cs`](agent/PrintOk.Agent.Core/PrintAgentWorker.cs)** — The main loop. Polls the API, downloads documents, calls the spooler. This is the most important file in the agent.

4. **[`agent/PrintOk.Agent.Core/PrinterSpooler.cs`](agent/PrintOk.Agent.Core/PrinterSpooler.cs)** + **[`agent/PrintOk.Agent.Core/WindowsRasterPrinter.cs`](agent/PrintOk.Agent.Core/WindowsRasterPrinter.cs)** — How PDFs are rasterized to bitmaps and sent to the Windows print spooler.

5. **[`agent/PrintOk.Agent.Tray/TrayContext.cs`](agent/PrintOk.Agent.Tray/TrayContext.cs)** — The Windows system tray UI wrapper.

### 5.2 The Agent Protocol (Quick Summary)

The agent authenticates with a device token (obtained via pairing). It:
1. Polls `GET /api/agent/jobs/next` for the next queued job.
2. Reports `DOWNLOADING` → downloads file from S3 URL + validates SHA-256.
3. Reports `PRINTING` → spools to Windows printer.
4. Reports `PRINTED` or `FAILED` back to API.
5. Sends heartbeats every 30s.
6. Listens on WebSocket `/ws/agent` for push notifications to skip idle polling.

---

## Part 6 — The Tests

Tests are the best way to understand what a feature is *supposed* to do.

| File | What it covers |
|---|---|
| [`services/api/src/tests/api.test.ts`](services/api/src/tests/api.test.ts) | 128+ integration tests, end-to-end through the HTTP API |
| [`services/api/src/tests/prismaStorage.test.ts`](services/api/src/tests/prismaStorage.test.ts) | Storage layer unit tests |
| [`agent/PrintOk.Agent.Core.Tests/PrintAgentWorkerTests.cs`](agent/PrintOk.Agent.Core.Tests/PrintAgentWorkerTests.cs) | Agent worker tests |

> [!TIP]
> When you don't understand what a route does, **find its test first**. Test names are plain English: `'42. Printer management endpoints reject unauthenticated callers'`. The test shows exactly what input goes in and what response is expected.

---

## Part 7 — On the Comments

**Short answer: Do NOT mass-delete the comments.**

A sample audit of `app.ts` alone (5,400 lines, 659 comment lines):

| Comment type | Count | Example |
|---|---|---|
| Security rationale | ~32 | Why CORS is an allowlist, not a wildcard; why tokens aren't in query strings |
| Business rule explanation | ~89 | Why payment state ≠ print state; why PriceSnapshot is frozen |
| "Why not the obvious thing" | many | Why `X-Forwarded-For` trust is set to 1 hop, not `true`; why sessions use localStorage not sessionStorage |
| PRD references | scattered | `(PRD 7.2)`, `(PRD 12)` — links the code to the product requirements |
| Section headers | ~20 | `// ============= QR POSTER ============` |

**Almost none of these are "obvious" comments.** They explain *why* a decision was made, *what goes wrong if you change it*, or *what failed in production before*. Removing them would delete institutional knowledge that isn't written anywhere else.

**What IS safe to remove (if you ever find one):**
```javascript
// increment counter by 1
counter += 1;
```
Comments that restate what the code already says with no additional context. There are very few of these in this codebase.

> [!WARNING]
> Before removing any comment, ask: **"Would a future developer know not to make the same mistake without this comment?"** If the answer is no, keep it.

---

## Part 8 — How to Run Everything Locally

```bash
# 1. Install deps
npm install

# 2. Start infrastructure (Postgres + MinIO S3)
docker-compose -f infrastructure/docker-compose.yml up -d

# 3. Copy env
cp services/api/.env.example services/api/.env
# Fill in: JWT_SECRET, DATABASE_URL (local postgres), S3 credentials

# 4. Run API
cd services/api && npm run dev

# 5. Serve frontend (static)
cd apps/customer-web && node server.js

# 6. Run all tests
npm test   # from project root
```

---

## Part 9 — The Right Mental Order For a New Feature

When you want to add something, follow this checklist from [`AGENTS.md`](AGENTS.md):

1. Start with `packages/shared-types/src/index.ts` — do the types need changing?
2. Check `services/api/prisma/schema.prisma` — does the database need a new column/table?
3. Add/update the `IStorageProvider` interface in `services/api/src/storage.ts`.
4. Implement in `PrismaStorage` (`services/api/src/prismaStorage.ts`) and `MemoryStorage` (`services/api/src/storage.ts`).
5. Add the route in `services/api/src/app.ts`.
6. Wire the UI in `apps/customer-web/public/dashboard.html` + `apps/customer-web/public/app.js`.
7. Write the test in `services/api/src/tests/api.test.ts` first (TDD).
8. Run `npm test` — all tests must still pass.

---

## Quick Reference: Where Is What?

| "I need to find..." | Look here |
|---|---|
| All data types and enums | `packages/shared-types/src/index.ts` |
| Database schema | `services/api/prisma/schema.prisma` |
| API routes | `services/api/src/app.ts` |
| Storage operations (interface) | `services/api/src/storage.ts` (top ~100 lines) |
| Storage implementation (Postgres) | `services/api/src/prismaStorage.ts` |
| State machine transitions | `services/api/src/jobStateMachine.ts` |
| Auth (merchant/admin JWT) | `services/api/src/adminAuth.ts` |
| Auth (agent device token) | `services/api/src/agentAuth.ts` |
| CORS allowed origins | `services/api/src/corsPolicy.ts` |
| Pricing calculation | `services/api/src/pricing.ts` |
| WebSocket push to agent | `services/api/src/ws.ts` |
| Frontend merchant session | `apps/customer-web/public/app.js` → search `MerchantSession` |
| Frontend API calls | `apps/customer-web/public/app.js` → search `shopFetch` |
| Dashboard QR tab | `apps/customer-web/public/dashboard.html` → `tabQr` |
| Agent main loop | `agent/PrintOk.Agent.Core/PrintAgentWorker.cs` |
| Windows printer spooler | `agent/PrintOk.Agent.Core/WindowsRasterPrinter.cs` |
| All integration tests | `services/api/src/tests/api.test.ts` |
| Environment variable list | `services/api/.env.example` |
| Deployment config | `render.yaml` |
