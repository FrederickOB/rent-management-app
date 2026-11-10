# Queue backlog

- **Status:** M11. Drilled in `packages/server/test/drills/queue-backlog.int.test.ts` and measured under the month-end load (`pnpm load:month-end`). The queue-age alerts, the worker heartbeat and the console's queue list are the backend's M11 work (decision 9). Paging arrives with M12.
- **Covers:** pg-boss queues in PostgreSQL (ADR-005): webhooks waiting to be processed, receipts, messages, lease events and the nightly jobs. The worker is stopped, crashed, slow, or swamped by month end.
- **Why it is safe to let work wait:** every job is idempotent and every webhook is stored before it is answered. A backlog delays receipts and messages; it never loses or doubles money. The drill proves it: a month end's work queued with no worker, then cleared with one invoice per lease, one payment and one receipt per charge (numbers 1 to N), and each message sent once.

## How you find out

- **Queue-age alerts:** a queue's oldest job passes 5 minutes (warning) or 15 (critical) for payments queues, 30 or 120 for the rest.
- **The worker heartbeat:** `/health/worker` on the API answers unhealthy when the worker has not beaten for 2 minutes.
- **`job.dead_lettered` (critical):** a job used up its retries (see `failed-webhooks.md` for webhooks).
- **Tenants waiting for receipts:** M9's "time to receipt" on the dashboard climbs; receipts are due within a minute (PRD section 19).

## Look

The console's system health page (`/platform/health`) lists each queue's depth and oldest job. Locally, or on a restored copy:

```bash
# Jobs waiting now, per queue, with the oldest's age.
docker compose exec -T postgres psql -U postgres -d rent -c \
  "select name, state, count(*), max(now() - created_on) as oldest from pgboss.job
   where state in ('created', 'retry', 'active') and start_after <= now()
   group by 1, 2 order by 4 desc"

# Webhooks stored but not processed yet, and outbox events not yet published.
docker compose exec -T postgres psql -U postgres -d rent -c \
  "select count(*) as webhooks_waiting from webhook_inbox where status = 'received'"
docker compose exec -T postgres psql -U postgres -d rent -c \
  "select type, count(*) from outbox_event where published_at is null group by 1 order by 2 desc"
```

## What you do

1. **Is the worker running?** Check `/health/worker`, then its logs. If it has stopped, start it: work resumes where it left off (the relays publish what was stored meanwhile, and each job runs once).
2. **Is one job failing over and over?** A queue in `retry` with the same error is a bug or a provider problem, not load. Fix the cause; the retries continue with backoff (up to an hour for webhooks), then go to the dead-letter queue.
3. **Is it just volume (month end)?** Let it drain and watch the oldest job's age fall. Expect:
   - receipts, messages and lease events: hundreds a minute each (the drill: 200 messages in 8 s);
   - webhooks: since M11 a draining queue as well. Until then `payments.process-webhook` waited out pg-boss's 1-second polling interval after each job, one webhook a second; the drill caught it (120 webhooks in 120 s), and decision 7's peak of 1,000 payments in 10 minutes would have outrun it.
4. **A second worker** is safe at any time: pg-boss hands each job to one worker, the relays publish each event once however many run, and every job is idempotent.
5. **Never delete or edit jobs or webhook rows by hand** to "clear" a queue. A job that will never succeed goes to the dead-letter queue, where it can be retried (`pnpm ops:redrive`, or the console) once its cause is fixed.
6. **Afterwards:** the nightly checks (`billing.subledger-check`, `audit.verify-chain` and the rest) confirm nothing went wrong. To run them at once on a copy: `bash scripts/drill-restore.sh <copy>`, or the checks alone:

   ```bash
   cd packages/server && DATABASE_URL=... DATABASE_OWNER_URL=... \
     node_modules/.bin/tsx --tsconfig tsconfig.runtime.json --env-file-if-exists=../../.env scripts/drill-checks.ts
   ```

## The drill

```bash
pnpm --filter @rent/server exec vitest run --project integration test/drills/queue-backlog.int.test.ts
# Bigger: DRILL_BACKLOG_LEASES=1000 DRILL_BACKLOG_PAYMENTS=600 (default 200 and 120)
```

- **Run on 2026-11-10 (local):** 200 leases with their lease events, 200 reminders and 120 webhooks (plus 30 sent twice by the provider) were queued with no worker, then a worker was started.
    - **First run:** receipts cleared in 0.6 s, lease events in 5 s, messages in 8 s, and webhooks in 120 s (one a second), 121 s in all.
    - **With the webhook queue draining** (the backend's fix the same day): webhooks cleared in 8 s, everything in 10 s.

    Either way nothing ran twice, every unpaid tenant got their reminder once, and the books still matched their sub-ledgers.
