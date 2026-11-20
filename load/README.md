# Month-end load test

M11 decision 7 (plan 4.6): 5,000 units, 50 staff and a month-end peak, on the full payment path, against a stack of its own. NFR tags: `NFR-SCALE` and `NFR-PERF`.

## Run it

```bash
pnpm load:month-end                     # decision 7's profile: about 20 min of fixture, a 60-minute run, then the drain
LOAD_UNITS=400 LOAD_STAFF=10 LOAD_DURATION_MIN=3 LOAD_PAYMENTS=150 LOAD_PEAK_PAYMENTS=60 \
  LOAD_PEAK_MIN=1 LOAD_TENANT_PAGES=40 pnpm load:month-end    # a smoke run, minutes
```

- **Needs:** Compose's postgres, seaweedfs and mailpit running (`pnpm services:up`), Docker (k6 runs from the pinned `grafana/k6:2.3.0` image; no npm package), Chromium for the worker's PDFs (`pnpm exec playwright install chromium`).
- **Its own stack, never the development one:**
  - database `LOAD_DB` (default `rent_scratch_load`; only `rent_scratch_*` or `rent_load*`; refuses `rent`), created, migrated and dropped afterwards;
  - api on 3780, links on 3782, a second fake provider on 4180 (`LOAD_API_PORT`, `LOAD_LINKS_PORT`, `LOAD_FAKE_PORT`). It refuses 3700–3702, 4010 and 8081, and any port in use;
  - links is built into `apps/links/.next/load`, so other builds are untouched.
- **Already have a migrated scratch database** (agents make one with the guard script): `LOAD_DB=rent_scratch_load LOAD_DATABASE_READY=1 pnpm load:month-end`. It is then neither created, migrated nor dropped.
- **Results:** `LOAD_OUT` (default `load/results/<UTC time>/`, gitignored): `result.json`, `summary.md`, `k6-summary.json`, `report.json`, `checks.json`, `samples.jsonl` and `logs/`. The fixture file (session cookies and pay-link tokens) is deleted at the end.
- **CI:** `.github/workflows/scheduled.yml`, weekly and on demand. Profile `ci` is 2,000 units, 30 staff, 1,000 payments in 30 minutes (400 in the first 10) and 200 tenant pages, to fit a runner in about an hour. `full` is decision 7's profile and `smoke` the one above.

## What it does

1. **Fixture** (`packages/server/scripts/load-fixture.ts build`, extending `perf-fixture.ts`): an agency, built through the services:
   - `LOAD_UNITS` units in properties of 100, five owners with approved settlement accounts (set up with the fake provider) and agreements in force;
   - `LOAD_STAFF` staff (8% admins, 20% accountants, 32% caretakers each assigned a property, the rest managers), each with a signed-in session;
   - a tenant per unit, with a phone, SMS consent and a paper lease started 1 to 11 months ago:
     - one in ten is billed on the platform from its start (up to 11 months of invoices, allocations and accruals, a deposit on one in four of them). The lease balance reads use these, the month-end worst case;
     - the rest came onto the platform last month, so each has two invoices. At 5,000 units the worker renders some 12,000 invoice PDFs, not 32,000, and it starts first so they render while the fixture is built;
     - rent is paid up to last month (one in ten a month behind), so every lease has an invoice due today, the month end;
   - the platform company every deployment has.
2. **The stack starts** (fake provider, api, worker, links), and the fixture's own background work drains first.
3. **k6** (`load/month-end.js`) runs three scenarios at once:
   - **payments:** `LOAD_PAYMENTS` tenants pay in `LOAD_DURATION_MIN`, `LOAD_PEAK_PAYMENTS` of them in the first `LOAD_PEAK_MIN`. Each takes the whole path: the pay page and the MoMo charge (links, then the API, then the provider), the payer approving (the fake provider sends the signed webhook to the API), then the worker's verify, posting, receipt and SMS. The page follows the payment;
   - **staff:** every session works the dashboard, invoice, tenant and receipt lists, tenant pages and lease balances, with a few seconds between reads;
   - **tenant pages:** `LOAD_TENANT_PAGES` other tenants open their pay page.

   Each simulated tenant has an address of its own (links reads it from `x-load-client-ip` through its `CLIENT_IP_HEADER` setting), so the pay page's per-address limits apply per tenant, as they would per phone.

4. **Sampling** every 2 s throughout: jobs waiting, webhooks waiting, lock waiters and waiters on the audit chain head. Function statistics (`track_functions = 'pl'` on the scratch database) time `audit.append`.
5. **After the run:** wait for the queues to drain (up to 15 minutes), measure what the run left in the database (`load-fixture.ts report`), and run every nightly check (`scripts/drill-checks.ts`).
6. **The verdict** (`load/summarise.mjs`): exit 1 if a criterion fails.

## Pass criteria (decision 7)

| Criterion                                   | Measured by                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| No 5xx                                      | k6: every request it makes, and the API's answer to each webhook the fake sends       |
| No duplicate payment                        | database: payments per provider reference, intents per payment                        |
| Every approved payment posted once          | database: payments from intents, against k6's approvals                               |
| No duplicate receipt, numbers without gaps  | database: receipts per payment, numbers 1 to N per company                            |
| Webhook intake p95 < 500 ms                 | the fake provider times the API's answer to each webhook                              |
| Staff reads p95 < 1.5 s                     | k6                                                                                    |
| Payment to receipt sent p95 < 1 min         | database: `receipt_delivery.latency_ms` (confirmation to sent), every receipt sent    |
| Queues drain within 15 minutes of the peak  | samples: the first empty sample after the peak's end, or else the drain after the run |
| Every nightly ledger and audit check passes | `scripts/drill-checks.ts`                                                             |

Also measured, without a pass mark: month-end lease balance reads and dashboard reads (decision 7: "settles whether balance snapshots are needed", M4a), pay page and pay start times, tenant pay pages, audit chain head contention (M1), queue depths and lock waiters.

CI runners are small: their numbers are a regression check, not capacity. Production is measured in M12.
