# PrintOk — Project Agent Guidelines & System Architecture

> **Mission**: Build a hardware-free stationery printing platform where a customer scans a shop QR code, uploads a document from their phone, configures printing, pays, and the shop's existing Windows computer automatically sends the job to its existing printer through a persistent background print agent.
> **Core Constraint**: The shop must **NOT** need to open a browser or manually operate a website for every print job.

---

## 1. AI Agent Operating Rules (Before Coding Checklist)

Before writing any code, every AI agent must execute this 10-step protocol:

1. **Understand**: Clarify exact requirements, goals, and acceptance criteria.
2. **Inspect Repository**: Read existing files, directory structures, and configurations.
3. **Check Architecture**: Verify how the requested change fits into the PrintOk system flow.
4. **Use Graphify**: Run `/graphify .` or `graphify query` when understanding source code, API, and database relationships.
5. **Check Dependencies**: Review existing `package.json` / dependencies; avoid introducing new ones unless strictly necessary.
6. **Check Patterns**: Follow established code style, error handling, and component structure.
7. **Identify Affected Components**: Determine which apps (`customer-web`), services (`api`), or agents (`windows-print-agent`) are touched.
8. **Identify Risks**: Highlight security, reliability, network retry, or printer spooler risks.
9. **Assess Necessity**: Apply YAGNI. Challenge unnecessary complexity, premature abstractions, or over-engineering.
10. **Produce Implementation Plan**: Write a concise, step-by-step implementation plan before modifying code.

---

## 2. Core System Architecture & Data Flow

```
[ Customer Mobile Web App ] (Scan QR -> Upload PDF -> Config -> Price -> Pay)
            │ (HTTPS / REST)
            ▼
   [ Cloud Backend API ] (NestJS / Node.js + Prisma ORM)
       │           │
       ▼           ▼
[ PostgreSQL ]   [ Temporary S3 Object Storage ] (PDF payload, auto-cleaned)
                   │
                   ▼
         [ Print Job Queue ] (Polling / WebSocket / Secure Pull)
                   │
                   ▼
      [ Windows Print Agent ] (C# / .NET Windows Service on Shop PC)
                   │
                   ▼
  [ Windows Spooler & Printer ] (Physical Print Output)
```

---

## 3. Technology Baseline

* **Frontend**: Next.js, React, TypeScript, Tailwind CSS
* **Backend**: Node.js / NestJS, TypeScript, REST API
* **Database**: PostgreSQL, Prisma ORM
* **Temporary Object Storage**: S3-compatible object storage (temporary PDF blobs)
* **Print Job Queue**: Lightweight DB polling / WebSocket initial prototype (Redis + BullMQ reserved ONLY if prototype volume demands it)
* **Windows Print Agent**: C# / .NET Core, Windows Service / Background Application
* **Source Control & CI**: Git, GitHub, GitHub Actions
* **Testing**: Vitest / Jest (Unit & Integration), Playwright (Web E2E), .NET xUnit / NUnit (Print Agent)

---

## 4. State Model (Strict Separation)

**Payment State and Print State MUST be maintained independently.**
Never assume `Payment Paid == Print Completed`.

### Payment States
`Pending` ──► `Processing` ──► `Paid` ──► `Failed` / `Cancelled`
                                  │
                                  └──► `Refund Pending` ──► `Refunded`

### Print Job States
`Created` ──► `Awaiting Payment` ──► `Queued` ──► `Downloading` ──► `Printing` ──► `Printed` ──► `Completed`
                                                                          │
                                                                          └──► `Failed` / `Cancelled` / `Requires Shop Action`

---

## 5. Highest Priority Technical Proof (MVP Milestone 1)

Do **NOT** spend excessive effort polishing frontend UI before validating the core hardware risk.
The primary technical proof milestone is:

```
Phone Upload -> Cloud API -> Authorized Job Queue -> Windows Agent -> Windows Spooler -> Physical Print Output
```

### Print Agent Requirements:
* Authenticate & pair shop printer once during setup.
* Poll / receive job securely via HTTPS / WSS.
* Download temporary document blob.
* Validate PDF checksum and format.
* Send document directly to Windows default/selected printer.
* Report print completion or error status back to Cloud API.
* Clean up temporary file immediately after printing.
* Auto-reconnect cleanly on network interruption without duplicate printing.

---

## 6. Anti-Complexity & Engineering Philosophy (Ponytail Integration)

We adhere strictly to the **Ponytail Senior Developer Principles**:
The best code is the code never written.

### The Decision Ladder (Check before writing code):
1. **Does this need to exist?** (YAGNI — if not, skip it).
2. **Does it already exist in the codebase?** (Reuse helpers, patterns, components).
3. **Does standard library cover it?** (Use built-in modules).
4. **Does a native platform feature cover it?** (Use native browser/OS APIs).
5. **Does an installed dependency cover it?** (Avoid new packages).
6. **Can it be a single clear line?** (Keep diffs small).
7. **Only then**: Write the minimum, clean code that works.

### Hard Rules:
* No premature microservices, Kubernetes, Redis, or Kafka.
* Deletion over addition. Boring tech over clever tech.
* Root cause fixes over superficial symptom patches.
* Trust boundary input validation & data protection are **mandatory**.

---

## 7. Security & Privacy Defaults

* **Zero Secrets in Git**: Never commit `.env`, credentials, private keys, API tokens, or customer documents.
* **Ephemeral Document Storage**: Customer document payloads are stored in temporary S3 storage and deleted immediately upon print completion or expiration (1 hour max).
* **Agent Authentication**: Windows Print Agent uses token-based mutual authentication / paired API keys.
* **Input Sanitization**: Validate file types (PDF/Images only), file size limits, and sanitization before spooling.

---

## 8. Installed AI Skills & Tooling Reference

The environment is configured with specialized Agent Skills:

### Ponytail Behavioral Skills
* `/ponytail`: Enforce lazy senior dev rules & decision ladder.
* `/ponytail-review`: Review diffs for over-engineering and unnecessary lines.
* `/ponytail-audit`: Audit codebase for dead code and technical debt.
* `/ponytail-help`: Explain simplification options.

### Graphify Knowledge Graph
* `/graphify .`: Build structural knowledge graph of AST, dependencies, and APIs.
* `graphify query "<question>"`: Query code relationships without reading every file.

### 24-Skill Engineering Collection
* `requirements-discovery`, `planning`, `architecture-design`, `system-design`
* `implementation`, `code-review`, `unit-testing`, `integration-testing`, `e2e-testing`
* `security-audit`, `vulnerability-scanning`, `debugging-investigation`, `error-recovery`
* `observability-instrumentation`, `performance-optimization`, `refactoring`
* `documentation-generation`, `api-design`, `database-migration-design`, `git-workflow`
* `verification-validation`, `deployment-automation`, `release-readiness`, `using-agent-skills`

---

## 9. Learning Mode Protocol

When introducing a major technical concept or implementation:
1. **What we are building**: Brief high-level summary.
2. **Why this technology**: Plain rationale.
3. **What problem it solves**: Clear engineering context.
4. **What could go wrong**: Failure modes & risks.
5. **Key Takeaway**: Core lesson for the developer.

---

## 10. Notion Management Hub

* **Project Hub**: https://app.notion.com/p/3d3916dfb2068197b535c3ec894be45f?pvs=204
* **Execution Tracker**: https://app.notion.com/p/91151e87a0574720bc4c645ba2c06038
