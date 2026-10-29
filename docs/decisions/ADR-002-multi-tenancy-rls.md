# ADR-002: Multi-tenancy and Row Level Security

- **Status:** Accepted, 2026-10-28

## Context

Every landlord and agency is a company. Agencies hold many owners' portfolios in one account (AD-02), and a leak between companies would end the product. The PRD needs agencies of 5,000+ units without redesign. M1 must prove that isolation holds even when application scoping is bypassed.

## Decision

- **Shared database, shared schema.** Every company-scoped table has `company_id NOT NULL` and `UNIQUE (company_id, id)`. Foreign keys between company-scoped tables are composite `(company_id, x_id)`.
- **Forced RLS.** RLS is enabled and forced on every company-scoped table, with the policy `company_id = current_setting('app.company_id')::uuid`. The application role does not own the tables and has no `BYPASSRLS`.
- **Transaction-local context.** The `db` helper opens a transaction and calls `set_config` with `is_local = true` for `app.company_id`, `app.user_id`, `app.request_id` and, for scoped sessions, `app.scope`. This is safe under connection pooling, including PgBouncer in transaction mode. Session-level `SET` is forbidden.
- **Jobs** carry `company_id` and run through the same helper.
- **System paths**, each with its own narrowly granted role or function:
    - Webhook intake writes to the global `webhook_inbox`, resolves the company from the provider subaccount or metadata, and enqueues a company-scoped job.
    - Schedulers call a `SECURITY DEFINER` function that returns company ids only.
    - Platform admin dashboards read `SECURITY DEFINER` views that return aggregates, never rows.
    - Support access sets a company context only while an active, consented, time-boxed grant exists; every query under it is audited.
- **Defence in depth.** On journal lines, documents and tenants, a second RLS predicate limits scoped sessions (owner, caretaker, tenant) to their scope ids. Within a company, the policy layer is the primary control for owner, property and tenant scope.
- **CI checks.** Every table with `company_id` has forced RLS and a policy. An integration test, using the application role and raw SQL with company A's context, reads zero rows of company B from every table.

## Consequences

- Isolation does not depend on every query remembering a `WHERE` clause.
- All data access must go through the helper; a lint rule bans the raw client elsewhere.
- Each migration must add a policy for each new table; CI fails otherwise.
- Small per-query overhead from policy predicates; indexes lead with `company_id`.

## Alternatives considered

- **Schema per company.** Migrations run N times and connections multiply; hard at thousands of landlords.
- **Database per company.** Strongest isolation, highest cost and operational load.
- **Application-only scoping.** One missed filter leaks data; no defence in depth.

## Revisit when

- A single company's volume needs partitioning (partition by `company_id`, keeping RLS).
- Counsel requires physical separation for some customers.
