# PrintOk — PRD Status

Every section of [`prd.md`](../prd.md) grouped into delivery phases, with an
honest status. Companion to the PRD; update it in the same commit as the code it
describes.

**Last assessed:** 11 Sep 2026 · against `fc8c28a`

## Status legend

| | Meaning |
|---|---|
| ✅ **Complete** | Built, tested, deployed, and verified working in production |
| 🔍 **Needs review** | Built and deployed, but never verified in the real world, or with a known open question |
| 🟠 **Incomplete** | Meaningfully started; important parts missing |
| ⬜ **Not started** | No implementation |

**The single most important line in this document:** nothing has ever physically
printed through this system. The agent has never run on a real Windows PC against
a real printer. Everything in Phase 2 is therefore 🔍 at best, however well it is
tested at the API level.

---

## Phase 0 — Product definition

| § | Area | Status | Notes |
|---|---|---|---|
| 1 | Product Vision | ✅ | Defined in the PRD |
| 2 | Production Objective | ✅ | Defined |
| 3 | Product Principles | ✅ | Defined |
| 4 | Users & Roles | 🟠 | Customer, shop owner and platform admin exist. Shop staff and support agent roles are named but unbuilt (see §20, §24) |

---

## Phase 1 — Core print flow · mostly ✅

The path a customer actually walks. Verified end to end in production on the test
shop, minus the physical print.

| § | Area | Status | Notes |
|---|---|---|---|
| 5 | Customer Experience | ✅ | QR → upload → configure → price → pay → status. Server-side page verification; PDF/Word/Excel/CSV/PPT/images |
| 6 | Shop Experience | ✅ | Registration, QR poster, dashboard, live queue, cash approval, rate card |
| 9 | Job Orchestration | ✅ | Full job model: orderId, shopId, deviceId, immutable config and price snapshots, payment ref, retry metadata, idempotency key, lifecycle events |
| 10 | Payment Architecture | ✅ | Payment and print state fully independent, each with its own guarded transition table |
| 11 | Idempotency | ✅ | Client keys on job creation; conditional claims prevent two agents printing the same job |
| 16 | Shop Pricing | ✅ | Per-shop persisted rate card; price frozen at quote time so later rate changes cannot restate a past quote |

---

## Phase 2 — The Windows agent · 🔍 unproven in reality

Code complete and CI-built, but **never run against a real printer.**

| § | Area | Status | Notes |
|---|---|---|---|
| 7.1 | Agent lifecycle | 🔍 | Pairing, reconnect with backoff, autostart documented. Never run on a shop PC |
| 7.2 | Agent security | 🔍 | Device-scoped tokens, DPAPI at rest, per-device revocation, audit events. DPAPI never exercised on real Windows |
| 7.3 | Printing paths | 🔍 | `printto` with named printer, `print` fallback, one job per copy. **Never produced physical paper** |
| 8 | Printer Fleet Management | ⬜ | No compatibility matrix, no certification tiers. Cannot begin without real printers |
| 12 | Failure & Recovery | ✅ | Failures classified customer/shop/platform-resolvable; 60s sweep reclaims abandoned jobs |
| 13 | Offline & Network Resilience | 🔍 | Jobs queue while offline; agent reconnects. Verified by tests, not by pulling a real cable |
| 30 | Agent Update Strategy | ⬜ | No self-update. Updating means re-downloading the exe |

**Highest-value next action in the whole project:** install the agent on one
Windows PC, pair it, and print one real page.

---

## Phase 3 — Money · 🟠 blocked on configuration

The §10 *architecture* is scored in Phase 1; this phase covers applying it.

| § | Area | Status | Notes |
|---|---|---|---|
| 10 | Razorpay integration (applying §10) | 🔍 | Checkout wired, signatures verified server-side, webhook on the real Razorpay format. **Blocked: live keys not set on Render, so no payment can complete** |
| 17 | Refunds & Disputes | ⬜ | `RefundReview` and `PartiallyRefunded` exist in the state machine; no refund flow, no dispute handling |
| 18 | Notifications | ⬜ | No SMS, email or push to customers. The only push that exists is API → agent over WebSocket. A customer must keep the status page open to learn their job printed |
| 41 | Commercial Model | 🟠 | Hybrid tier + per-shop commission built and editable in admin. **Actual numbers undecided**; landing page shows placeholders |

Three env vars stand between this and working payments: `RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.

---

## Phase 4 — Operations · 🟠 foundations only

| § | Area | Status | Notes |
|---|---|---|---|
| 21 | Admin & Operations Platform | ✅ | Console with auth, network overview, shop table, plan editing, archive/delete with audit |
| 22 | Observability | 🟠 | Job lifecycle events, agent security events, admin audit log, `/health` with build commit. No metrics, tracing or dashboards |
| 23 | Monitoring & Alerts | ⬜ | Nothing alerts anyone. A shop offline overnight goes unnoticed |
| 24 | Support System | 🟠 | Contact enquiries with a status workflow; job event history aids investigation. No ticketing, no scoped support access |
| 25 | Analytics | 🟠 | Shop stats and network overview. No funnels, cohorts or retention analysis |

---

## Phase 5 — Security, privacy, resilience · 🟠 mixed

| § | Area | Status | Notes |
|---|---|---|---|
| 14 | Document Security & Privacy | 🟠 | SHA-256 integrity, TLS in transit, documents purged on terminal state, temp files removed. No encryption at rest beyond the provider's |
| 15 | Retention & Deletion | 🟠 | Purge happens on terminal state and is recorded, including failures. **No timed sweep**, so the PRD's ~10 minute target is not enforced for a job that never terminates |
| 26 | Security Program | 🟠 | scrypt passwords, HMAC sessions, device tokens, signature verification, honeypot and rate limits. No external review or pen test |
| 27 | Data Protection & Compliance | 🟠 | Minimal collection, hashed IPs, no card data touched. No policy, no DPA, no retention schedule |
| 28 | Backup & Disaster Recovery | 🔍 | Supabase provides backups; one manual export exists. **Restore has never been tested** |

---

## Phase 6 — Release engineering · ✅ solid

| § | Area | Status | Notes |
|---|---|---|---|
| 29 | Deployment & Release | ✅ | Auto-deploy on push, migrations on boot with automatic baselining, `/health` reports the running commit, guard against migrating production from a laptop |
| 37 | Quality Assurance | 🟠 | 43 automated tests (22 API, 21 Postgres) covering money, state machine, idempotency, auth and recovery. **No print-specific tests, no failure injection, no load testing** |

---

## Phase 7 — Growth · ⬜ not started

Deliberately deferred. PRD §44 places these after the core network is dependable.

| § | Area | Status |
|---|---|---|
| 19 | Customer Accounts | ⬜ |
| 20 | Shop Staff & Permissions | ⬜ (admin roles exist; shop-level staff do not) |
| 31 | Multi-Printer & Routing | 🟠 (multiple printers per shop work; no routing logic) |
| 32 | Multi-Location Shops | ⬜ |
| 33 | Public Shop Discovery | ⬜ |
| 34 | Growth & Network Effects | ⬜ |
| 44 | Post-Launch Evolution | ⬜ |

---

## Phase 8 — Scale & polish

| § | Area | Status | Notes |
|---|---|---|---|
| 35 | Performance Requirements | ⬜ | No targets set, no load testing. Currently on Render's free tier, which sleeps |
| 36 | Reliability Objectives | ⬜ | No SLOs, no error budget |
| 38 | UX / UI Direction | ✅ | Landing, customer, dashboard and admin all built on one design system |
| 39 | Accessibility | 🟠 | ARIA roles, labels, live regions, reduced-motion support, keyboard-reachable controls. Never audited with a screen reader |
| 40 | Internationalization | ⬜ | English and ₹ hardcoded throughout |

---

## Production readiness gates (§42)

| Gate | Status | What is missing |
|---|---|---|
| 1 — Technical | 🟠 | Queue, idempotency and recovery are done and tested. **Agent stability unproven; no printer compatibility matrix** |
| 2 — Security | 🟠 | Auth, secrets, document privacy and auditability in place. No external review |
| 3 — Payments | 🟠 | Integration and webhook verification done. **Keys not configured; no refunds; no reconciliation** |
| 4 — Operations | 🟠 | Support tooling and audit exist. **No monitoring, no alerts, no incident process, untested restore** |
| 5 — Shop Network | 🟠 | Onboarding and agent pairing work. No certification, no agent updates, no training material |
| 6 — Customer | 🟠 | Mobile UX, status clarity and collection flow are built. **Payment confidence blocked on keys; no refund experience** |

**No gate is fully passed.** Closest: Gate 1, pending a real print.

---

## Definition of done (§43)

| Criterion | Status |
|---|---|
| New shop onboards without engineering | ✅ |
| Shop can configure and validate its printer | 🔍 configure yes; validate never proven |
| Agent operates unattended | 🔍 unproven |
| Customer completes the journey from a phone | 🟠 blocked on payment keys |
| Paid jobs safely orchestrated | ✅ |
| Duplicate printing prevented or safely resolved | ✅ |
| Payment and print records reconcile | 🟠 no reconciliation tooling |
| Failures visible and actionable | ✅ |
| Documents securely handled and deleted | 🟠 no timed sweep |
| Support can investigate without unsafe access | 🟠 no scoped support role |
| Administrators can operate the network | ✅ |
| Backups and recovery tested | ⬜ restore never tested |
| Production monitoring active | ⬜ |
| Release and rollback procedures exist | 🟠 release yes, rollback undocumented |
| Security and privacy controls validated | ⬜ no external validation |
| Real printer compatibility documented | ⬜ |
| Refund, dispute, pricing and support policies operational | ⬜ |

---

## Summary

Across §§1–41 and §44 (42 scored sections; §42 and §43 are the gate and
done-criteria tables above, scored separately).

| Status | Count | Sections |
|---|---|---|
| ✅ Complete | 13 | 1, 2, 3, 5, 6, 9, 10, 11, 12, 16, 21, 29, 38 |
| 🔍 Needs review | 3 | 7, 13, 28 |
| 🟠 Incomplete | 12 | 4, 14, 15, 22, 24, 25, 26, 27, 31, 37, 39, 41 |
| ⬜ Not started | 14 | 8, 17, 18, 19, 20, 23, 30, 32, 33, 34, 35, 36, 40, 44 |

The core print pipeline is genuinely production-grade: durable job model,
guarded state machine, idempotency, failure recovery, device-scoped agent
credentials, and an audited admin console — all deployed and tested.

What stands between this and a real launch is not more features. It is:

1. **Three Razorpay env vars** — no one can pay without them
2. **One physical print** — the entire Phase 2 column is unverified reality
3. **Monitoring** — nobody currently finds out when something breaks
4. **Refunds** — needed the first time a real payment goes wrong
