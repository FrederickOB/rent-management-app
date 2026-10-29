# ADR-005: Job queue and transactional outbox

- **Status:** Accepted, 2026-10-28
- **Job list:** `docs/architecture.md`, section 10

## Context

The PRD requires payment callbacks to be "retried and never lost", receipts within one minute of a confirmed payment, and many timed ladders (rent reminders, notice reminders, renewals, tax alerts). A message must never go out for a payment whose transaction rolled back. We want no infrastructure beyond PostgreSQL in the MVP.

## Decision

- **Queue:** pg-boss on the same PostgreSQL database, with cron schedules in Africa/Accra time.
- **Outbox:** business transactions write domain events to an `outbox_event` table in the same transaction. A relay in `apps/worker` publishes them to pg-boss. It wakes on LISTEN/NOTIFY, with a one-second poll as fallback. The outbox doubles as the domain event log.
- **Idempotency, twice.** Each job has a pg-boss singleton key. Each business effect has a unique constraint: journal idempotency keys, one receipt per payment, one reminder row per (invoice, step), one webhook per (provider, event id).
- **Retries:** exponential backoff per job type. Exhausted jobs go to a dead-letter queue and raise an alert.
- **Company context:** every job payload carries `company_id`, and the runner sets it through the `db` helper before any query (ADR-002).
- **No provider calls inside transactions.** Handlers read state, call the provider, then write results in a new transaction.

## Consequences

- One stateful dependency to run, back up and monitor.
- Delivery is at least once, and effects happen exactly once, because every effect is idempotent.
- Queue traffic shares the database. At MVP scale this is small; monitor it and split later if needed.
- The relay adds about a second of latency, well inside the 60-second receipt target.

## Alternatives considered

- **BullMQ with Redis.** Fast and popular, but another stateful service, and no transactional enqueue with business data.
- **Enqueue pg-boss jobs directly in the business transaction.** Also transactional, but couples producers to job names, and we would lose the event log that consumers and the audit trail use.
- **Cloud queues (SQS).** Managed, but no transactional enqueue; still needs an outbox.

## Revisit when

- Queue load measurably affects database latency at month-end peaks (move the queue to its own database, or relay the outbox to SQS).
