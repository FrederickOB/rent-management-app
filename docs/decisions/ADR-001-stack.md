# ADR-001: Stack and repository

- **Status:** Accepted, 2026-10-28 (decision D3, confirmed by the founder)
- **Supersedes:** none

## Context

The founder's own team builds the product in-house. Their recent projects are TypeScript: Next.js, Fastify and Expo. The PRD needs payments, a ledger, multi-tenant SaaS, three front ends and a lot of background work, for agencies of 5,000+ units and 50+ staff.

## Decision

- **Language and tooling:** TypeScript in strict mode everywhere; Node.js 24 LTS; pnpm workspaces; Turborepo pipelines.
- **API and worker:** NestJS. Its modules map one-to-one onto PRD modules, and guards give one place to call the policy layer. Use the Fastify adapter unless a required library needs Express; M1 confirms.
- **Web:** Next.js with the App Router, for `apps/web` (staff, owners, platform admin) and `apps/links` (no-login pages).
- **Tenant app:** Expo, for iOS, Android and web (ADR-010).
- **Database:** PostgreSQL 17 or later. Drizzle ORM for typed queries and schema. Hand-written SQL migrations for RLS policies, triggers, constraints and functions, applied by the same migration runner.
- **Contracts:** zod schemas in `packages/contracts`, with a typed client shared by `web`, `links` and `tenant`. M1 picks ts-rest or OpenAPI code generation.
- **Jobs:** pg-boss (ADR-005). **Auth:** Better Auth (ADR-011).
- **Tests:** Vitest, fast-check and Playwright; Jest with React Native Testing Library in the Expo app.
- **Repository layout:** as in `CLAUDE.md` section 3.

## Consequences

- One language and shared types from database to phone.
- PostgreSQL is the only stateful dependency in the MVP: no Redis, no separate queue.
- The team knows Fastify, not NestJS. The M1 plan fixes module, provider and testing conventions early, and NestJS can run on Fastify.
- Custom SQL migrations need discipline: CI checks that every table with `company_id` has forced RLS and a policy, and that ledger tables have their append-only triggers.

## Alternatives considered

- **Fastify alone.** Familiar and light, but we would hand-build the module boundaries, dependency injection and guard structure that 20+ modules need.
- **Laravel or Django.** Mature, but the team is stronger in TypeScript.
- **Prisma.** Good developer experience, but transaction-local settings for RLS and custom constraints are harder to control.
- **Kysely.** A strong query builder; Drizzle adds schema-as-code and first-class RLS policy support.

## Revisit when

- NestJS slows the team noticeably during M1 and M2.
- Drizzle cannot express a constraint or query the ledger needs (fall back to raw SQL in that module).
