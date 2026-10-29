# ADR-012: Shared NestJS modules in `packages/server`

- **Status:** Accepted, 2026-10-28 (M1 plan, decision 4, approved by the founder)
- **Amends:** ADR-001 (repository layout)

## Context

The API and the worker are separate NestJS processes (ADR-001, ADR-005). Both need the same modules: the database context, audit, rules, documents, policy, approvals and companies. The worker writes audit events from jobs, renders documents the API requests and runs approvals expiry; the API reads and writes the same records. The layout in `CLAUDE.md` section 3 had nowhere to put shared NestJS modules except one app importing another.

## Decision

- Add `packages/server`. It holds the NestJS modules from the module map (`docs/architecture.md`, section 2): services, repositories and the module definitions, including the `core` module (database context, outbox, job runner, storage, PDF service, crypto, logging).
- `apps/api` holds HTTP concerns only: `main.ts`, controllers that implement the contracts, the Better Auth mount, guards and webhook routes.
- `apps/worker` holds job handlers, the outbox relay, schedulers and the PDF renderer pool.
- `packages/domain` stays pure. `packages/server` may import `domain`, `db`, `integrations`, `documents` and `contracts`, never `apps/*`.

## Consequences

- One implementation of each module serves both processes.
- Module layer rules (architecture section 2) are enforced inside `packages/server` by `eslint-plugin-boundaries`.
- Apps stay thin, so a third process (for example a webhook intake service) can be added without moving code.

## Alternatives considered

- **The worker imports modules from `apps/api`.** No new package, but it couples one app's build to another and blurs what is HTTP and what is business logic.
- **One NestJS app with two entry points.** Simpler wiring, but the playbook and the job catalogue treat the worker as its own deployable.

## Revisit when

- A module needs to be deployed independently of the rest.
