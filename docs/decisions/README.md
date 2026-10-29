# Architecture decision records

One page per decision: context, decision, consequences, alternatives, and when to revisit. A decision changes only through a new ADR that supersedes the old one.

| ADR | Decision | Status |
| --- | --- | --- |
| [ADR-001](ADR-001-stack.md) | TypeScript; NestJS, Next.js, Expo; PostgreSQL with Drizzle; pnpm and Turborepo | Accepted |
| [ADR-002](ADR-002-multi-tenancy-rls.md) | Shared schema with forced Row Level Security | Accepted |
| [ADR-003](ADR-003-ledger.md) | Double-entry books, accrual by rent period, append-only | Accepted |
| [ADR-004](ADR-004-money.md) | Integer pesewas, basis points, half-up rounding, largest remainder | Accepted |
| [ADR-005](ADR-005-jobs-outbox.md) | pg-boss with a transactional outbox | Accepted |
| [ADR-006](ADR-006-documents.md) | HTML templates to PDF in Chromium, SHA-256, write-once storage | Accepted |
| [ADR-007](ADR-007-esignature.md) | In-house e-signature confirmed by one-time code | Accepted, pending counsel |
| [ADR-008](ADR-008-settlement.md) | Rent settles directly to landlords and agencies | Accepted, pending providers |
| [ADR-009](ADR-009-hosting-region.md) | AWS region chosen by a latency test | Proposed |
| [ADR-010](ADR-010-tenant-app-expo.md) | Expo tenant app for iOS, Android and web | Accepted |
| [ADR-011](ADR-011-authentication.md) | Better Auth for staff, tenants and caretakers | Accepted; M1 spike passed |
| [ADR-012](ADR-012-shared-server-package.md) | Shared NestJS modules in `packages/server` | Accepted |
| [ADR-013](ADR-013-local-object-storage.md) | SeaweedFS as the local S3 store (MinIO archived) | Accepted |
| [ADR-014](ADR-014-api-contracts.md) | API contracts with oRPC | Accepted |
