# Failed webhooks and replay

- **Status:** M11. Intake, retries, the dead letter, verify-pending and the daily reconciliation are built (M4b) and drilled (`packages/server/test/drills/webhooks-lost.int.test.ts`, `webhook-replay.int.test.ts`). The replay and retry tools (console, `pnpm ops:replay-webhooks` and `pnpm ops:redrive`) are built (M11 decision 9); their flags are below.
- **Covers:** payment provider webhooks (`charge.success`, disputes, refunds) and the messaging providers' webhooks, from arrival to processing (NFR "payment callbacks retried and never lost"; CLAUDE.md section 8).
- **Why replay is safe:** a webhook never carries money by itself. Processing asks the provider's verify endpoint and posts what it says, once per payment (keyed postings, one intent per payment). The drill replays a whole day of webhooks twice, both by the provider resending and by processing every stored row again; payments, receipts, allocations, messages and the journal come out identical.

## How a webhook moves

1. **Intake** (`POST /webhooks/:provider` on the API): stores the raw request in `webhook_inbox` (one row per provider and event id), checks the signature, answers 200. A replayed event is answered 200 and stored nothing (`duplicate`). A bad signature is stored as `rejected` without its body, answered 401 and alerted once per 15 minutes (`payments.webhook_bad_signature`).
2. **Relay** (worker): queues each stored row once as `payments.process-webhook`.
3. **Processing:** verifies with the provider and posts through the normal path. Outcomes such as `posted`, `posted_flagged` (the verified amount differs: an exception for a person), `already_posted` or `unmatched` are recorded on the row (`status` `processed` or `ignored`).
4. **Failure:** retried 10 times, from 1 minute up to an hour apart. Then the dead letter: the row becomes `failed` (`dead_lettered`) and `job.dead_lettered` is raised.
5. **Safety nets:** `payments.verify-pending` (every 5 minutes) and `payments.reconcile-transactions` (02:00 Africa/Accra) find any payment whose webhook never came or never got processed.

## Look

```bash
# The last day's webhooks by status and outcome (no bodies).
docker compose exec -T postgres psql -U postgres -d rent -c \
  "select provider, status, outcome, count(*) from webhook_inbox
   where received_at > now() - interval '1 day' group by 1, 2, 3 order by 4 desc"

# Failed or rejected ones, newest first (ids, types and references only).
docker compose exec -T postgres psql -U postgres -d rent -c \
  "select id, provider, event_type, reference, status, outcome, received_at from webhook_inbox
   where status in ('failed', 'rejected') order by received_at desc limit 50"
```

In production use the console (system health: failed and dead-lettered webhooks), never a database shell.

## What you do

- **`rejected` (bad signature):**
  - one or two: someone probing the endpoint; nothing to do;
  - every webhook rejected: the provider's secret key changed, or ours did. Fix the key (secrets manager, M12) and ask the provider to resend. Rejected rows have no body to replay, and none is needed: verify-pending and the reconciliation post the payments meanwhile.
- **`failed` (dead-lettered):** find the cause first (the worker's log for that job: a provider outage, a bug). Once fixed, replay it:
  - console: system health → failed webhooks → Replay, with a reason (audited in the platform's chain);
  - command line, during an incident. `--operator` is your platform admin email and `--reason` is required; the OS user and host are recorded too. `--dry-run` lists what would be replayed and changes nothing:

    ```bash
    # Named webhooks.
    pnpm ops:replay-webhooks --operator you@platform.example --reason "Paystack outage, fixed" \
      --id <webhook id> --id <webhook id>
    # Every failed or dead-lettered webhook in a window (add --provider paystack to narrow it;
    # --all also takes rows that did not fail; --limit caps the count, default 1,000).
    pnpm ops:replay-webhooks --operator you@platform.example --reason "Worker down 02:00-02:40" \
      --from 2026-11-10T02:00:00Z --to 2026-11-10T02:40:00Z --dry-run
    ```

  - a dead-lettered job, not a webhook: `pnpm ops:redrive` takes the same `--operator`, `--reason`, `--id`, `--from`/`--to`, `--limit` and `--dry-run`, plus `--queue <name>`. A dead letter can be retried once; if it fails again it comes back as a new dead letter.
  - both commands refuse the development database `rent` unless `--allow-rent-database` is given.

  A replay runs the same processing again. Replaying twice changes nothing.
- **Stuck `received` for more than a few minutes:** the worker or the queue, not the webhook (see `queue-backlog.md`).
- **The provider says it sent webhooks we never stored:** nothing to replay. Check the reconciliation of the next morning, or run the day's reconciliation again: `pnpm ops:reconcile --day YYYY-MM-DD --operator … --reason …` (it changes nothing already reconciled). Then ask the provider to resend if it can; resent events that were already processed are answered `duplicate`.
- **Never** insert, edit or delete `webhook_inbox`, `payment` or journal rows by hand. Never post a payment from a webhook body or a screenshot.

## The drills

```bash
pnpm --filter @rent/server exec vitest run --project integration \
  test/drills/webhooks-lost.int.test.ts test/drills/webhook-replay.int.test.ts
```

- **Lost webhooks (2026-11-10, local):** with the fake provider dropping every webhook (`{"mode":"drop"}` on `/payments/_test/outage`), three payments were posted by verify-pending and four (one from outside the pay page) by the daily reconciliation. Running both again changed nothing, and six receipts (1 to 6) and six receipt messages went once.
- **Replay (2026-11-10, local):** a day of seven webhooks (four payments, one short payment, one chargeback, one external payment), replayed twice both ways. Fourteen resent events were answered `duplicate`, and fourteen reprocessings posted nothing. Everything was as before, and the books still matched their sub-ledgers.
