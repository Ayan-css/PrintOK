# 🚀 PrintOk — Production / Final Product PRD

# Document Control

**Version:** 2.0 — Production / Final Product

**Status:** Product definition for production build

**Supersedes:** MVP PRD as the implementation scope

**Product:** PrintOk

> The MVP has already been completed. This document defines the production-grade product: the system we intend to operate reliably in the real world, across customers, shops, printers, payments, support, security, and platform operations.
> 

---

# 1. Product Vision

PrintOk is the operating platform that turns participating stationery shops into instant, phone-accessible print locations without requiring new shop hardware.

**Customer promise:**

**Scan → Upload → Configure → Pay → Track → Collect**

**Shop promise:**

**Install once → Configure once → Print automatically → Act only when something needs attention**

The final product should make digital-to-physical printing feel as simple as ordering a normal online service while preserving the economics and hardware already present in stationery shops.

---

# 2. Production Product Objective

Move from “the print workflow works” to “the print network can be trusted.”

Production success means PrintOk can:

- operate continuously;
- onboard and support real shops at scale;
- securely process customer documents and payments;
- automatically route and print jobs;
- recover from common failures;
- prevent duplicate or unauthorized printing;
- give customers accurate status;
- give shops actionable operational visibility;
- give administrators enough control to diagnose and resolve incidents;
- evolve without breaking existing shops.

---

# 3. Product Principles

1. **Reliability before novelty.**
2. **No unnecessary hardware.**
3. **The shop should not babysit software.**
4. **The customer should not understand the underlying technology.**
5. **Every money movement must be auditable.**
6. **Every print job must have an explainable lifecycle.**
7. **Customer documents are sensitive data.**
8. **Retries must be safe.**
9. **Operational exceptions must be visible and actionable.**
10. **Do not expose capabilities the printer/driver cannot reliably support.**
11. **Use progressive rollout for risky changes.**
12. **The simplest architecture that meets the production requirement wins.**

---

# 4. Users & Roles

## 4.1 Customer

Can discover a shop, upload a document, configure printing, pay, track status, and collect the completed print.

## 4.2 Shop Owner

Can manage shop profile, operating status, printers, pricing, staff access, orders, refunds where permitted, and operational settings.

## 4.3 Shop Staff

Can monitor jobs, resolve supported exceptions, reprint where authorized, and handle physical collection/customer disputes according to policy.

## 4.4 Platform Operations

Can monitor network health, devices, jobs, payments, incidents, support cases, and configuration.

## 4.5 Platform Administrator

Has elevated controls for shops, devices, pricing policies, refunds, account restrictions, security events, and system configuration.

## 4.6 Support Agent

Can investigate customer/shop problems with privacy-limited access and a complete audit trail.

---

# 5. Production Customer Experience

## 5.1 Discovery

Customers can discover PrintOk shops through:

- shop QR code;
- direct shop link;
- PrintOk discovery/search experience, when enabled;
- shared shop link.

## 5.2 Shop Selection

Before upload or payment, the customer must clearly know which shop will fulfill the order.

Display:

- shop name;
- location/context;
- operating status;
- available printing services;
- estimated readiness where meaningful.

## 5.3 Upload

Support a defined production file matrix.

PDF should remain the reference format. Additional formats can be supported only when conversion and print fidelity are proven.

Requirements:

- upload progress;
- resumable/retryable upload where practical;
- file validation;
- size limits;
- corruption detection;
- clear failure messages;
- safe temporary storage.

## 5.4 Document Preview

Where technically reliable, show a preview or page summary before payment.

The customer should be able to confirm:

- document name;
- page count;
- selected page range;
- estimated number of printed sheets;
- selected print mode.

## 5.5 Print Configuration

Production configuration should support the printer capabilities exposed by the selected shop.

Core options:

- copies;
- page range;
- colour / black & white;
- simplex / duplex;
- paper size;
- orientation;
- supported finishing/options where reliable.

The UI must not present an option as available if the selected fulfillment path cannot reliably execute it.

## 5.6 Price Review

Before payment the customer sees a deterministic order summary:

- document/pages;
- copies;
- print mode;
- paper/settings;
- itemized price where appropriate;
- taxes/fees where applicable;
- final payable amount.

The backend is authoritative for pricing.

## 5.7 Payment

Customer completes payment through the supported payment provider.

The order cannot enter the printable state until payment is authoritatively confirmed.

## 5.8 Live Order Status

Customer status should progress through understandable states such as:

**Payment → Queued → Printing → Ready → Completed**

Technical states should remain available internally without exposing confusing implementation details to customers.

## 5.9 Collection

The customer receives a clear collection instruction and, where appropriate, an order code/identifier for matching the physical print to the order.

---

# 6. Production Shop Experience

## 6.1 Onboarding

Shop onboarding must include:

1. Account creation.
2. Business/shop verification where required.
3. Shop profile.
4. Pricing/service configuration.
5. Windows Print Agent installation.
6. Device pairing.
7. Printer discovery.
8. Printer capability detection/configuration.
9. Test print.
10. QR generation.
11. Operational readiness check.

## 6.2 Zero-Touch Normal Operation

When healthy, the shop should not need to:

- keep a browser open;
- manually download files;
- manually open documents;
- manually initiate each print;
- repeatedly log in;
- restart the agent for routine jobs.

## 6.3 Exception-Driven Shop Workflow

The shop UI should primarily answer:

- What is happening?
- Is anything blocked?
- What needs my attention?
- What action is safe?
- What happened to the customer's job?

---

# 7. Windows Print Agent — Production Requirements

The Windows agent is a first-class production component.

## 7.1 Lifecycle

- install;
- authenticate/pair;
- start automatically with Windows;
- maintain backend connectivity;
- receive authorized work;
- process jobs;
- report lifecycle events;
- recover after restart;
- reconnect after network loss;
- update safely;
- uninstall cleanly.

## 7.2 Security

The agent must:

- use device-scoped credentials/tokens;
- securely store secrets using appropriate Windows mechanisms;
- validate job authorization;
- reject expired/replayed jobs;
- avoid arbitrary remote command execution;
- restrict filesystem access;
- protect temporary files;
- securely remove temporary documents;
- produce auditable security events.

## 7.3 Printing

The agent must use a supported Windows printing path and maintain a compatibility matrix by printer model/driver/capability.

Production support should distinguish:

- printer detected;
- printer reachable;
- spooler accepted;
- job submitted;
- printer reported completion, where available;
- physical output verified only where a reliable signal exists.

---

# 8. Printer Fleet Management

Production PrintOk must treat printers as a managed compatibility fleet rather than assuming all printers behave identically.

For each supported printer class, track:

- manufacturer;
- model;
- driver family/version;
- Windows version;
- supported paper sizes;
- colour capability;
- duplex capability;
- known limitations;
- validation status;
- last successful test;
- failure history.

Printer support tiers:

- **Certified:** fully tested and supported.
- **Compatible:** expected to work but with limited validation.
- **Unsupported:** not eligible for normal production use.
- **Blocked:** known unsafe/unreliable configuration.

---

# 9. Job Orchestration

The backend is responsible for durable job state and orchestration.

A production job must have:

- globally unique job ID;
- order ID;
- shop ID;
- device ID;
- printer ID;
- document reference;
- immutable print configuration snapshot;
- price snapshot;
- payment reference;
- timestamps;
- retry metadata;
- idempotency identifiers;
- lifecycle events.

---

# 10. Payment Architecture

Payment and print state remain separate.

## Payment States

- Pending.
- Processing.
- Paid.
- Failed.
- Cancelled.
- Refund Pending.
- Refunded.
- Partially Refunded, where supported.

## Print States

- Created.
- Awaiting Payment.
- Queued.
- Assigned.
- Downloading.
- Printing.
- Printed.
- Ready for Collection.
- Completed.
- Failed.
- Cancelled.
- Requires Shop Action.
- Refund Review.

A successful payment must never be interpreted as proof that printing succeeded.

---

# 11. Idempotency & Duplicate Prevention

Production must protect against:

- repeated customer submissions;
- payment webhook duplication;
- agent reconnects;
- backend retries;
- duplicate queue messages;
- agent crashes during processing;
- acknowledgement loss;
- ambiguous printer submission state.

Every operation capable of causing money movement or physical printing must have an explicit idempotency strategy.

Where the printer state is ambiguous, the system must prefer controlled human resolution over blindly printing again.

---

# 12. Failure & Recovery System

Production failures must be classified.

## Customer-Resolvable

Examples:

- unsupported file;
- invalid page range;
- payment failure.

## Shop-Resolvable

Examples:

- printer offline;
- paper unavailable;
- printer paused;
- agent disconnected.

## Platform-Resolvable

Examples:

- queue failure;
- payment webhook processing failure;
- object storage failure;
- backend service failure.

## Safety-Critical / Ambiguous

Examples:

- uncertain whether a job already printed;
- conflicting payment state;
- possible duplicate print;
- suspected unauthorized access.

These must enter a controlled resolution flow.

---

# 13. Offline & Network Resilience

The platform must gracefully handle:

- customer mobile network loss;
- shop internet loss;
- backend connectivity loss;
- agent restart;
- Windows restart;
- temporary storage outage;
- payment provider delay.

A paid order must remain recoverable even if the shop temporarily loses connectivity after payment confirmation.

---

# 14. Document Security & Privacy

Customer documents must be treated as sensitive by default.

Production requirements:

- encryption in transit;
- encrypted storage where supported;
- private object storage;
- short-lived access URLs/tokens;
- strict tenant isolation;
- least-privilege access;
- no permanent public document URLs;
- access logging;
- secure local temporary storage;
- automatic deletion;
- deletion verification;
- privacy-preserving support tooling.

The platform should minimize collection of unnecessary customer identity data.

---

# 15. Retention & Deletion

Default operational policy should use the shortest retention period that still allows reliable printing, support, reconciliation, and abuse investigation.

The working document-retention target remains approximately **10 minutes** after the relevant processing window, subject to production validation and explicit policy.

Production deletion must cover:

- object bytes;
- derivative/temporary files;
- local agent files;
- relevant metadata where policy requires deletion.

Deletion failures must be observable and retryable.

---

# 16. Shop Pricing & Commercial Controls

Shop owners should eventually be able to configure supported services and pricing within platform rules.

Pricing system requirements:

- versioned price rules;
- effective dates;
- minimum price safeguards;
- platform fee handling;
- tax handling where applicable;
- immutable order price snapshot;
- refund calculations;
- audit trail for price changes.

A price change must never retroactively modify an already-paid order.

---

# 17. Refunds & Disputes

Production must define controlled outcomes for:

- payment succeeded but print failed;
- printer produced partial output;
- wrong configuration printed;
- duplicate print;
- customer cancellation before printing;
- shop cancellation;
- platform failure;
- customer dispute after collection.

Refund eligibility must be policy-driven and auditable.

Shop staff must not be able to arbitrarily alter financial records.

---

# 18. Notifications

Use progressive notification channels.

Customer notifications may include:

- payment confirmation;
- print started;
- print ready;
- failure/action required;
- refund status.

Channels can include in-app/web status first, followed by email/SMS/WhatsApp or other channels where commercially justified.

Notifications must never expose document contents.

---

# 19. Customer Accounts

The production product should support a low-friction guest flow while enabling optional account-based features.

Potential account capabilities:

- order history;
- saved preferences;
- receipts;
- repeat printing;
- support history.

Do not force account creation merely to complete a simple print order unless required for a specific business/security reason.

---

# 20. Shop Staff & Permissions

Production RBAC should distinguish at least:

- Owner.
- Manager.
- Staff.
- Platform Support.
- Platform Operations.
- Administrator.

Permissions must cover:

- jobs;
- refunds;
- pricing;
- printer configuration;
- devices;
- shop settings;
- staff;
- reports.

Sensitive actions require stronger authorization and audit events.

---

# 21. Admin & Operations Platform

Production admin must provide a unified operational view.

## Shop Operations

- shop status;
- onboarding status;
- agent status;
- printer status;
- supported capabilities;
- recent failures.

## Job Operations

- search by job/order;
- lifecycle timeline;
- payment state;
- device assignment;
- retry state;
- failure reason;
- resolution history.

## Payment Operations

- transaction reference;
- payment state;
- reconciliation state;
- refund state;
- provider webhook history.

## Incident Operations

- active incidents;
- affected shops;
- affected jobs;
- service health;
- mitigation status;
- post-incident record.

---

# 22. Observability

Every production service must provide sufficient observability to answer:

**What happened, when, where, why, and what happened next?**

Required:

- structured logs;
- metrics;
- traces where useful;
- error tracking;
- audit logs;
- correlation IDs;
- job IDs;
- device IDs;
- payment references;
- service health checks.

Avoid logging document contents or unnecessary personal/payment data.

---

# 23. Monitoring & Alerts

Alerting should focus on actionable conditions, including:

- elevated job failure rate;
- payment webhook failures;
- queue backlog;
- storage failures;
- agent connectivity degradation;
- abnormal duplicate-print signals;
- elevated refund rate;
- deletion failures;
- authentication/security anomalies.

Alerts must have an owner and documented response path.

---

# 24. Support System

Customer and shop support should be tied to the order/job timeline.

Support agents should be able to see:

- order;
- payment state;
- print state;
- relevant event history;
- shop/device health;
- allowed resolution actions.

Support must not require access to the customer's document contents unless explicitly authorized and necessary.

---

# 25. Analytics

Track product, operational, and commercial analytics.

## Customer

- shop discovery;
- upload success;
- configuration completion;
- payment conversion;
- completion rate;
- repeat usage.

## Shop

- onboarding completion;
- active shops;
- active devices;
- jobs/shop/day;
- printer utilization;
- shop retention.

## Operations

- print success rate;
- failure categories;
- median queue time;
- median print time;
- agent uptime;
- recovery rate;
- refund rate;
- support tickets.

Analytics events must respect privacy policy.

---

# 26. Production Security Program

Security must become continuous rather than a one-time checklist.

Requirements:

- dependency vulnerability scanning;
- secret management;
- secure CI/CD;
- authentication hardening;
- authorization tests;
- rate limiting;
- abuse detection;
- audit logging;
- device revocation;
- session/token expiration;
- security incident procedure;
- backup and recovery testing;
- periodic access review.

---

# 27. Data Protection & Compliance

Before launch in each market, validate applicable requirements around:

- privacy notices;
- data retention/deletion;
- payment processing;
- taxation;
- consumer protection;
- electronic receipts;
- business verification;
- data breach response.

Compliance requirements must be confirmed for the actual operating geography rather than assumed.

---

# 28. Backup & Disaster Recovery

Production data must have:

- automated backups;
- tested restoration;
- defined recovery objectives;
- documented incident procedures;
- database migration rollback strategy.

Critical operational data must not depend on a single ephemeral service instance.

---

# 29. Deployment & Release Management

Production changes must support:

- development;
- staging;
- production environments;
- automated tests;
- migration checks;
- rollback strategy;
- feature flags where useful;
- controlled rollout;
- agent version compatibility.

The Windows agent must support safe version upgrades without breaking active jobs.

---

# 30. Agent Update Strategy

Production agent updates should:

- verify package integrity;
- use signed/secure distribution where appropriate;
- preserve configuration;
- avoid interrupting active jobs;
- support rollback/fallback;
- report version;
- report update status;
- allow operations to identify outdated agents.

Breaking changes require a compatibility strategy before rollout.

---

# 31. Multi-Printer & Routing

Production architecture should support a shop with multiple printers.

Routing can consider:

- printer capability;
- printer availability;
- paper size;
- colour capability;
- duplex capability;
- current load;
- shop configuration.

Routing decisions must be deterministic and auditable.

The first production implementation may still restrict a shop to a single active printer where that is operationally safer.

---

# 32. Multi-Location Shops

Production architecture should support a business operating multiple locations without requiring a separate platform account for every location.

Each location must remain isolated for:

- jobs;
- devices;
- printers;
- pricing;
- staff permissions;
- reporting.

This should not be allowed to complicate the core single-shop workflow unnecessarily.

---

# 33. Public Shop Discovery

Once the operational network is reliable, PrintOk can provide a customer discovery layer.

Potential capabilities:

- nearby shops;
- service availability;
- opening hours;
- estimated readiness;
- pricing indicators;
- supported document/print capabilities.

Discovery information must reflect real shop state where possible rather than stale claims.

---

# 34. Growth & Network Effects

The final product should make it easy to add shops without increasing operational complexity linearly.

Important capabilities:

- self-service onboarding;
- automated readiness checks;
- printer compatibility validation;
- automated health monitoring;
- shop-level analytics;
- support tooling;
- standardized pricing/service configuration.

---

# 35. Performance Requirements

Production performance targets should be measured and then locked based on real traffic.

The product should optimize for:

- fast mobile load;
- responsive upload experience;
- low payment confirmation latency;
- low queue latency;
- fast agent job acknowledgement;
- predictable printing startup;
- dashboard responsiveness.

Targets should be defined as measurable SLOs rather than vague claims such as “fast.”

---

# 36. Reliability Objectives

Production SLOs should eventually cover:

- API availability;
- payment processing availability;
- job orchestration availability;
- agent connectivity;
- successful job delivery;
- successful print completion;
- document deletion;
- notification delivery.

Separate platform availability from physical printer availability. PrintOk cannot guarantee a printer's physical condition, but it must detect and communicate problems accurately.

---

# 37. Quality Assurance

Production testing must include:

## Automated

- unit tests;
- integration tests;
- API contract tests;
- database tests;
- payment webhook tests;
- security tests;
- E2E customer tests.

## Print-Specific

- printer matrix tests;
- driver/version tests;
- PDF rendering tests;
- page range tests;
- copies tests;
- colour tests;
- duplex tests;
- paper-size tests;
- orientation tests.

## Failure Testing

- network loss;
- agent crash;
- Windows restart;
- printer disconnect;
- queue failure;
- payment webhook duplication;
- storage failure;
- backend restart;
- ambiguous print result.

---

# 38. Production UX / UI Direction

The UI should remain consistent with the PrintOk product identity and existing design direction while becoming production-grade.

Principles:

- mobile-first customer experience;
- clear hierarchy;
- strong feedback states;
- obvious primary actions;
- high readability;
- accessibility;
- responsive layouts;
- minimal cognitive load;
- strong empty/error/loading states;
- consistent design tokens;
- predictable interaction patterns.

The visual style must never compromise operational clarity.

---

# 39. Accessibility

Production interfaces should target a recognized accessibility baseline, including:

- keyboard navigation where applicable;
- sufficient contrast;
- semantic structure;
- accessible forms;
- meaningful error messages;
- screen-reader-friendly status changes;
- touch-friendly controls;
- reduced-motion considerations.

---

# 40. Internationalization Readiness

The product architecture should avoid hard-coding assumptions that make localization impossible.

Prepare for:

- multiple languages;
- currency formatting;
- regional date/time formats;
- local tax rules;
- regional payment methods;
- localized transactional messages.

Actual language/country expansion should be driven by market demand.

---

# 41. Commercial Model

The production system should support a sustainable platform model such as:

- per-print platform fee;
- percentage transaction fee;
- shop subscription;
- hybrid model.

The final commercial model remains a business decision and should be validated against shop economics, customer willingness to pay, payment costs, support costs, and printer volume.

---

# 42. Production Readiness Gates

PrintOk should not be considered production-ready merely because the happy path works.

## Gate 1 — Technical

- stable cloud services;
- stable agent;
- printer compatibility matrix;
- reliable queue;
- idempotency;
- tested recovery.

## Gate 2 — Security

- auth/authz review;
- secret handling;
- document privacy;
- secure deletion;
- abuse controls;
- auditability.

## Gate 3 — Payments

- production payment integration;
- webhook verification;
- reconciliation;
- refunds;
- failure scenarios.

## Gate 4 — Operations

- monitoring;
- alerts;
- support tooling;
- incident response;
- backup/restore.

## Gate 5 — Shop Network

- onboarding process;
- printer certification;
- agent updates;
- shop training/support;
- operational documentation.

## Gate 6 — Customer

- polished mobile UX;
- status clarity;
- payment confidence;
- collection flow;
- failure/refund experience.

---

# 43. Production Definition of Done

The final product is ready for broad launch when:

- a new shop can onboard without engineering intervention;
- a shop can configure and validate its printer;
- the agent operates unattended;
- customers can complete the entire journey from phone;
- paid jobs are safely orchestrated;
- duplicate printing is prevented or safely resolved;
- payment and print records reconcile;
- failures are visible and actionable;
- customer documents are securely handled and deleted;
- support can investigate incidents without unsafe data access;
- administrators can operate the network;
- backups and recovery have been tested;
- production monitoring is active;
- release/rollback procedures exist;
- security and privacy controls are validated;
- real-world printer compatibility is documented;
- business policies for refunds, disputes, pricing, and support are operational.

---

# 44. Post-Launch Evolution

After the production foundation is stable, future product areas may include:

- public shop discovery;
- multi-printer routing;
- multi-location management;
- recurring business/customer accounts;
- advanced print services;
- bulk printing;
- document conversion;
- OCR/document tools;
    - loyalty/rewards;
    - automated shop health scoring;
    - predictive operational alerts.
    
    These are intentionally secondary to making the core print network dependable.
    
    ---
    
    # 45. Final Product North Star
    
    PrintOk should eventually feel almost invisible.
    
    For the customer:
    
    **“I need a print. I scan the shop, upload it, pay, and collect it.”**
    
    For the shop:
    
    **“My printer is connected. Jobs arrive automatically. I only intervene when something actually needs me.”**
    
    For PrintOk operations:
    
    **“Every job, payment, device, failure, and recovery is observable, explainable, secure, and controllable.”**
    
    That is the production definition of PrintOk.
    
- business integrations;