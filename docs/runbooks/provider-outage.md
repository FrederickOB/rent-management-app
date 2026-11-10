# Payment provider outage

- **Status:** M11. The behaviour below is built and drilled (`packages/server/test/drills/provider-down.int.test.ts`). The uptime monitor and paging arrive with the first deployment (M12).
- **Covers:** Paystack (or the second provider, once one is chosen under ADR-008) refusing, timing out or not sending webhooks while tenants pay rent (NFR availability; CLAUDE.md section 8).
- **Rule that never bends:** money is posted only from the provider's verify answer, never from a webhook body or a tenant's screenshot. An outage changes how long that takes, never how it is done.

## How you find out

- **`payments.provider_unavailable` (critical):** a tenant tried to pay and no provider could take the charge. The tenant was shown the landlord's own instructions (Settings → Company → manual payment instructions) and the intent failed cleanly. At most one goes per company (and set of providers tried) in 15 minutes, however many tenants are refused, so a repeat a quarter of an hour later means the outage goes on.
- **`payments.charge_unknown` (warning):** a charge request got no answer, and the provider could not say whether it exists. The intent stays with that provider (no failover, so no double charge) and `payments.verify-pending` keeps asking.
- **Webhooks stop arriving:** payments made on the pay page stay "checking" for more than 5 minutes. Look at the console's system health page (`/platform/health`), or locally:

  ```bash
  docker compose exec -T postgres psql -U postgres -d rent -c \
    "select provider, status, max(received_at) as last, count(*) from webhook_inbox
     where received_at > now() - interval '1 hour' group by 1, 2 order by 1, 2"
  ```

- **The provider's status page** (Paystack's), and the reconciliation exceptions of the next morning.

## What the platform does by itself

- **Down (503 or 429 before taking the request):** the next provider that settles directly is tried (BC-02, D1). With none left, the tenant sees the manual instructions and the intent is marked failed (`providers_unavailable`). Nothing is left half-made.
- **No answer (timeout):** the provider is asked whether the charge exists before anything else is tried. If it cannot say, the intent waits for verify-pending.
- **Webhooks late or lost:** `payments.verify-pending` (every 5 minutes) verifies every intent older than 5 minutes, and `payments.reconcile-transactions` (02:00 Africa/Accra, for the day before) posts anything paid that we never heard about, through the normal path, once. Late webhooks then find their payment posted and change nothing.
- **Receipts** follow each posting as usual; their numbers stay gap-free.

## What you do

1. **Confirm it is the provider:** its status page, and whether `webhook_inbox` is still receiving. If our API is the one failing, this is an incident under `incident-response.md`, not a provider outage.
2. **Tell landlords** whose tenants pay in the next hours that card and MoMo may fail, and that their own instructions are being shown. Check that each affected company has instructions set (Settings → Company); a company without them shows only "try again later".
3. **Do not post anything by hand.** A tenant who paid during the outage is found by verify-pending or the nightly reconciliation. Cash and transfers paid instead follow the usual two-person cash approval (BC-05).
4. **When the provider is back:** watch the waiting intents drain within 5 to 10 minutes:

   ```bash
   docker compose exec -T postgres psql -U postgres -d rent -c \
     "select status, count(*) from payment_intent where created_at > now() - interval '1 day' group by 1"
   ```

   If some stay `pending` or `initiated` after 15 minutes, check the worker is running (`/health/worker` on the API) and the queues (`queue-backlog.md`).
5. **The next morning:** read the reconciliation exceptions (Payments → Reconciliation, `/payments/reconciliation`). Anything unexplained goes to a person, as usual (`payments-reconciliation.md`).
6. **Afterwards:** record the outage (start, end, payments affected, alerts) in the incident log.

## The drill

The fake provider has an outage switch, so the drill runs without touching Paystack:

```bash
# A private fake (or the Compose one on 4010): down, slow, timeout, withhold, drop, normal.
curl -X POST localhost:4010/payments/_test/outage -H 'content-type: application/json' -d '{"mode":"down"}'
curl -X POST localhost:4010/payments/_test/outage -H 'content-type: application/json' -d '{"mode":"timeout","delayMs":15000}'
curl -X POST localhost:4010/payments/_test/outage -H 'content-type: application/json' -d '{"mode":"normal"}'   # releases withheld webhooks
curl localhost:4010/payments/_test/outage                                              # the current mode
curl -X DELETE localhost:4010/payments/_test/outage                                    # reset: normal, withheld webhooks discarded
```

- The automated drills run on every pull request, in CI's integration job:

  ```bash
  pnpm --filter @rent/server exec vitest run --project integration test/drills/provider-down.int.test.ts test/drills/webhooks-lost.int.test.ts
  ```

- **Run on 2026-11-10 (local):** both pass in 37 s. While the provider was down, the tenant saw the instructions and one alert went. Two payments approved just before the outage were posted by verify-pending once it was back, and their withheld webhooks then changed nothing. A provider that held its answers past 10 s got no failover; its charge posted once. With every webhook dropped, verify-pending and the daily reconciliation recovered all seven payments, an external one included, each once.
