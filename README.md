# PrintOk

Hardware-free stationery printing platform. Customer scans shop QR code, uploads document on mobile web, pays, and the shop's existing Windows computer automatically prints the document via a persistent background print agent.

## Architecture

- `apps/customer-web`: Mobile web application for scanning QR, document upload, print config, and payment.
- `services/api`: Backend API service handling authentication, document upload, pricing, payments, and print job queue.
- `agent/windows-print-agent`: C# / .NET Windows background service running on shop PC to fetch and spool print jobs.
- `packages/shared-types`: Common TypeScript definitions, API contracts, and state enums.
- `infrastructure`: Docker Compose / deployment scripts for PostgreSQL and local object storage (MinIO).

## Development Setup

1. Copy `.env.example` to `.env`.
2. Inspect `AGENTS.md` for project guidelines and AI agent operating rules.
3. Build repository knowledge graph:
   ```bash
   graphify .
   ```

## Development Philosophy

- YAGNI & Minimal Code: No unnecessary dependencies or abstractions.
- Security & Ephemeral Storage: Zero customer document persistence after printing.
- Hardware Validation First: Prioritize physical print validation via Windows Agent.
