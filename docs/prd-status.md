# PrintOk — PRD Status

Every section of [`prd.md`](../prd.md) grouped into delivery phases, with an
honest status. Companion to the PRD; update it in the same commit as the code it
describes.

**Last assessed:** 12 Sep 2026 · against `eb74af6`

## Status legend

| | Meaning |
|---|---|
| **DONE** | Built, tested, deployed, and verified working in production |
| **REVIEW** | Built and deployed, but never verified in the real world, or with a known open question |
| **PARTIAL** | Meaningfully started; important parts missing |
| **TODO** | No implementation |

**The single most important line in this document:** nothing has ever physically
printed through this system. The agent has never run on a real Windows PC against
a real printer. Nothing in Phase 2 can therefore score better than REVIEW,
however well it is tested at the API level.

**Second most important:** the platform cannot send email. Not a missing
template — no mail library, no provider, nothing. Contact enquiries are stored
and never delivered, and a shop owner who forgets their password is locked out
permanently. See §18 and §24.

---

## Phase 0 — Product definition

| § | Area | Status | Notes |
|---|---|---|---|
| 1 | Product Vision | DONE | Defined in the PRD |
| 2 | Production Objective | DONE | Defined |
| 3 | Product Principles | DONE | Defined |
| 4 | Users & Roles | PARTIAL | Customer, shop owner and platform admin exist. Shop staff and support agent roles are named but unbuilt (see §20, §24) |

---

## Phase 1 — Core print flow · mostly done

The path a customer actually walks. Verified end to end in production on the test
shop, minus the physical print.

| § | Area | Status | Notes |
|---|---|---|---|
| 5 | Customer Experience | DONE | QR → upload → configure → price → pay → status. Server-side page verification; PDF/Word/Excel/CSV/PPT/images |
| 6 | Shop Experience | DONE | Registration, QR poster, dashboard, live queue, cash approval, rate card |
| 9 | Job Orchestration | DONE | Full job model: orderId, shopId, deviceId, immutable config and price snapshots, payment ref, retry metadata, idempotency key, lifecycle events |
| 10 | Payment Architecture | DONE | Payment and print state fully independent, each with its own guarded transition table |
| 11 | Idempotency | DONE | Client keys on job creation; conditional claims prevent two agents printing the same job |
| 16 | Shop Pricing | DONE | Per-shop persisted rate card; price frozen at quote time so later rate changes cannot restate a past quote |

---

## Phase 2 — The Windows agent · unproven in reality

Code complete and CI-built, but **never run against a real printer.**

| § | Area | Status | Notes |
|---|---|---|---|
| 7.1 | Agent lifecycle | REVIEW | Pairing, reconnect with backoff, autostart documented. Never run on a shop PC |
| 7.2 | Agent security | REVIEW | Device-scoped tokens, DPAPI at rest, per-device revocation, audit events. DPAPI never exercised on real Windows |
| 7.3 | Printing paths | REVIEW | `printto` with named printer, `print` fallback, one job per copy. **Never produced physical paper** |
| 8 | Printer Fleet Management | TODO | No compatibility matrix, no certification tiers. Cannot begin without real printers |
| 12 | Failure & Recovery | DONE | Failures classified customer/shop/platform-resolvable; 60s sweep reclaims abandoned jobs |
| 13 | Offline & Network Resilience | REVIEW | Jobs queue while offline; agent reconnects. Verified by tests, not by pulling a real cable |
| 30 | Agent Update Strategy | TODO | No self-update. Updating means re-downloading the exe |

**Highest-value next action in the whole project:** install the agent on one
Windows PC, pair it, and print one real page.

---

## Phase 3 — Money · blocked on configuration

The §10 *architecture* is scored in Phase 1; this phase covers applying it.

| § | Area | Status | Notes |
|---|---|---|---|
| 10 | Razorpay integration (applying §10) | DONE | Live keys configured; a real ₹2 live payment captured in production. Checkout, server-side signature verification and the live webhook all wired. Three defects found and fixed since: `payment.failed` was confirming payments, the webhook secret fell back to a public literal, and sub-rupee orders reached the gateway |
| 17 | Refunds & Disputes | PARTIAL | A shop can decline a job, which refunds the customer in full via the Razorpay refunds API, ordered so nothing is recorded as refunded before the money moves. **No customer-facing refund request**, no dispute handling, no reconciliation tooling |
| 18 | Notifications | TODO | **The system cannot send email at all** — no library, no provider. No SMS or push either. A customer must keep the status page open to learn their job printed, and a shop owner cannot recover a forgotten password |
| 41 | Commercial Model | DONE | Four tiers with fixed commissions in `PLAN_CATALOGUE`, editable per shop in admin, published on the landing page and in the terms. A test asserts all three agree |

Those three env vars are now set with live credentials. What remains in this
phase is **Razorpay Route** — an external dependency, requested and pending —
without which every payment lands in the platform account and each shop must be
paid by hand. The application side of Route is built and preserved.

---

## Phase 4 — Operations · foundations only

| § | Area | Status | Notes |
|---|---|---|---|
| 21 | Admin & Operations Platform | DONE | Console with auth, network overview, shop table, plan editing, archive/delete with audit |
| 22 | Observability | PARTIAL | Job lifecycle events, agent security events, admin audit log, `/health` with build commit. No metrics, tracing or dashboards |
| 23 | Monitoring & Alerts | TODO | Nothing alerts anyone. A shop offline overnight goes unnoticed |
| 24 | Support System | PARTIAL | Contact enquiries with a status workflow; job event history aids investigation. No ticketing, no scoped support access |
| 25 | Analytics | PARTIAL | Shop stats and network overview. No funnels, cohorts or retention analysis |

---

## Phase 5 — Security, privacy, resilience · mixed

| § | Area | Status | Notes |
|---|---|---|---|
| 14 | Document Security & Privacy | PARTIAL | SHA-256 integrity, TLS in transit, documents purged on terminal state, temp files removed. No encryption at rest beyond the provider's |
| 15 | Retention & Deletion | PARTIAL | Purge happens on terminal state and is recorded, including failures. **No timed sweep**, so the PRD's ~10 minute target is not enforced for a job that never terminates |
| 26 | Security Program | PARTIAL | scrypt passwords, HMAC sessions, device tokens, timing-safe signature verification, honeypot and per-caller rate limits. Four real holes closed since the last assessment: the public printer endpoint leaked the agent API key and owner email, the webhook secret fell back to a value published in the repo, `payment.failed` marked jobs paid, and every visitor shared one rate-limit bucket. No external review or pen test |
| 27 | Data Protection & Compliance | PARTIAL | Privacy policy, terms and refund policy published, written against the DPDP Act 2023, the IT Act 2000, the Consumer Protection (E-Commerce) Rules 2020 and the GDPR, and describing what the code actually does. **Live with unfilled placeholders** — proprietor name, address, grievance email and phone. No DPA, no lawyer review |
| 28 | Backup & Disaster Recovery | REVIEW | Supabase provides backups; one manual export exists. **Restore has never been tested** |

---

## Phase 6 — Release engineering · solid

| § | Area | Status | Notes |
|---|---|---|---|
| 29 | Deployment & Release | DONE | Auto-deploy on push, migrations on boot with automatic baselining, `/health` reports the running commit, guard against migrating production from a laptop |
| 37 | Quality Assurance | PARTIAL | 63 automated tests (41 API, 22 Postgres) covering money, refunds, webhook events, state machine, idempotency, auth, rate limiting and recovery. **No print-specific tests, no failure injection, no load testing** |

---

## Phase 7 — Growth · not started

Deliberately deferred. PRD §44 places these after the core network is dependable.

| § | Area | Status |
|---|---|---|
| 19 | Customer Accounts | TODO |
| 20 | Shop Staff & Permissions | TODO — admin roles exist; shop-level staff do not |
| 31 | Multi-Printer & Routing | PARTIAL — multiple printers per shop work; no routing logic |
| 32 | Multi-Location Shops | TODO |
| 33 | Public Shop Discovery | TODO |
| 34 | Growth & Network Effects | TODO |
| 44 | Post-Launch Evolution | TODO |

---

## Phase 8 — Scale & polish

| § | Area | Status | Notes |
|---|---|---|---|
| 35 | Performance Requirements | TODO | No targets set, no load testing. Currently on Render's free tier, which sleeps |
| 36 | Reliability Objectives | TODO | No SLOs, no error budget |
| 38 | UX / UI Direction | DONE | Landing, customer, dashboard and admin all built on one design system |
| 39 | Accessibility | PARTIAL | ARIA roles, labels, live regions, reduced-motion support, keyboard-reachable controls. Never audited with a screen reader |
| 40 | Internationalization | TODO | English and ₹ hardcoded throughout |

---

## Production readiness gates (§42)

| Gate | Status | What is missing |
|---|---|---|
| 1 — Technical | PARTIAL | Queue, idempotency and recovery are done and tested. **Agent stability unproven; no printer compatibility matrix** |
| 2 — Security | PARTIAL | Auth, secrets, document privacy and auditability in place. No external review |
| 3 — Payments | PARTIAL | Live keys configured, a real payment captured, webhook verified, refunds on decline. **Route not activated, so no shop can be paid automatically; no customer refund path; no reconciliation** |
| 4 — Operations | PARTIAL | Support tooling and audit exist. **No monitoring, no alerts, no incident process, untested restore** |
| 5 — Shop Network | PARTIAL | Onboarding and agent pairing work. No certification, no agent updates, no training material |
| 6 — Customer | PARTIAL | Mobile UX, status clarity, collection flow and live payment all work. **No way for a customer to ask for a refund, and no notification of any kind** |

**No gate is fully passed.** Closest: Gate 1, pending a real print.

---

## Definition of done (§43)

| Criterion | Status |
|---|---|
| New shop onboards without engineering | DONE |
| Shop can configure and validate its printer | REVIEW — configure yes; validate never proven |
| Agent operates unattended | REVIEW — unproven |
| Customer completes the journey from a phone | REVIEW — works end to end with live payment; never done by a real customer on a real shop |
| Paid jobs safely orchestrated | DONE |
| Duplicate printing prevented or safely resolved | DONE |
| Payment and print records reconcile | PARTIAL — no reconciliation tooling |
| Failures visible and actionable | DONE |
| Documents securely handled and deleted | PARTIAL — no timed sweep |
| Support can investigate without unsafe access | PARTIAL — no scoped support role |
| Administrators can operate the network | DONE |
| Backups and recovery tested | TODO — restore never tested |
| Production monitoring active | TODO |
| Release and rollback procedures exist | PARTIAL — release yes, rollback undocumented |
| Security and privacy controls validated | TODO — no external validation |
| Real printer compatibility documented | TODO |
| Refund, dispute, pricing and support policies operational | PARTIAL — all three published and pricing is enforced in code; refunds operational only as a shop decline; support has no delivery channel |

---

## Summary

Across §§1–41 and §44 (42 scored sections; §42 and §43 are the gate and
done-criteria tables above, scored separately).

| Status | Count | Sections |
|---|---|---|
| DONE | 15 | 1, 2, 3, 5, 6, 9, 10, 11, 12, 16, 21, 29, 38, 41, and §10 applied |
| REVIEW | 3 | 7, 13, 28 |
| PARTIAL | 13 | 4, 14, 15, 17, 22, 24, 25, 26, 27, 31, 37, 39 |
| TODO | 13 | 8, 18, 19, 20, 23, 30, 32, 33, 34, 35, 36, 40, 44 |

Movement since 11 Sep: §10 and §41 to DONE, §17 TODO → PARTIAL.

The core print pipeline is genuinely production-grade: durable job model,
guarded state machine, idempotency, failure recovery, device-scoped agent
credentials, and an audited admin console — all deployed and tested.

Payments now work with live credentials, the commercial model is settled and
enforced, and a shop can refuse a job and refund the customer. What stands
between this and a real launch is still not more features. It is:

1. **One physical print** — the entire Phase 2 column is unverified reality,
   and no amount of API testing substitutes for it
2. **Email** — enquiries reach nobody, and a locked-out shop owner has no way
   back into their account
3. **`PUBLIC_WEB_URL`** — unset in production, so shop registration returns 500
   and no new shop can sign up at all
4. **Razorpay Route** — pending with Razorpay; until then every payment lands
   in the platform account and each shop is paid by hand
5. **Monitoring** — nobody finds out when something breaks. Three of the four
   defects fixed this week were found by reading code, not by an alert

The legal pages are published but still carry placeholders, and are publicly
reachable in that state.
