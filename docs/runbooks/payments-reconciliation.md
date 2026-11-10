# Payments reconciliation

- **Status:** M11. Daily reconciliation, the exceptions list and the clearing check have been built since M4b (`packages/server/src/payments/reconciliation.service.ts`). M10 added the platform's own charges. The webhooks-lost drill exercises them (`packages/server/test/drills/webhooks-lost.int.test.ts`). The nightly checks are the ones `scripts/drill-checks.ts` runs. Paging arrives with the first deployment (M12); until then alerts go to the ops email and the console.
- **Covers:**
  - the nightly comparison of the provider's transactions and settlements with our records (CLAUDE.md section 8);
  - the Reconciliation screen and each kind of exception;
  - provider charges that belong to no company;
  - the provider clearing check (account 1050);
  - the nightly sub-ledger checks and their alerts (CLAUDE.md section 4).
- **Rules that never bend:**
  - money is posted only through the normal path: verify with the provider, then post;
  - nobody inserts, edits or deletes `payment`, `allocation`, `journal_entry` or `journal_line` rows by hand;
  - a wrong posting is corrected by a reversal and a new entry, which a second person approves.

## What runs, and when

All times are Africa/Accra (UTC+0), the time zone the scheduler uses (`SCHEDULE_TIME_ZONE`). Each job covers the Accra day before.

| Time | Job | What it does |
| --- | --- | --- |
| 02:00 | `payments.reconcile-transactions` | See "Transactions" below. Runs once for each configured provider. |
| 02:30 | `payments.reconcile-settlements` | Matches each payout report to its payments and posts it (P22). Then runs the clearing check (1050). |
| 03:00 | `billing.subledger-check` | Ledger against the billing sub-ledgers, per company. |
| 03:15 | `reporting.fee-check` | Management fees against their rate and base, and against the ledger. |
| 03:30 | `ledger.agent-cash-check` | No owner's agent-held cash (1070) below zero. |
| 03:30 | `subscription.subledger-check` | The platform book (1100 and 2020) against the subscription sub-ledger. |

**Transactions (02:00), for each charge the provider lists for the day:**

- **Ours, same amount and status:** matched, nothing to do.
- **Not ours yet:** processed through the normal path (`processReference`): verified, then posted to its lease or put in Unmatched receipts. This recovers payments whose webhook never came.
- **Taken back at the provider** (refund or chargeback) but not reversed here: checked with the provider and reversed through the chargeback path.
- **The platform's own subscription charges** (references starting `SUB-`): handed to the subscription module, never matched to rent.
- **Anything it can't explain:** an exception, below.

**Settlements (02:30):**

- **Each payout:** posted once, keyed on the provider's settlement id. That is P22, per book: 1050 to the owner's or agency's cash account, with each payment's share of the fee.
- **Deductions** for chargebacks and refunds are taken from the reversed payments the report names.
- **A difference** in gross, arithmetic or deductions is raised as an exception. It is never absorbed.
- **A payment posted after its payout was reconciled** is settled on the next run, by its own entry.

**Every job is idempotent:**

- exceptions are kept once per key;
- settlements once per provider and settlement id;
- postings once per key.

Running a day twice changes nothing.

## Confirm it ran

- **Console:** System health (`/platform/health`) lists the last run and state of each scheduled job.
- **Failure:** a job that used up its 5 retries (5 minutes apart, rising) is dead-lettered. That raises `job.dead_lettered` (critical). Once the cause is fixed, retry it from System health ("Jobs that failed for good"), or during an incident with `pnpm ops:redrive --operator <platform admin email> --reason "…" --queue payments.reconcile-transactions` (add `--dry-run` first). See `queue-backlog.md` and `failed-webhooks.md`.
- **Gap:** there is no command or console action to re-run reconciliation for a chosen day after a run that succeeded. The job accepts a `day`, but nothing sends it one. Only a dead-lettered run can be retried.

## Reading the Reconciliation screen

**Where:** Payments → Reconciliation (`/payments/reconciliation`).

**Who:**

- people with `payments.view` see it: the landlord, agency admins, managers and accountants;
- people with `payments.match` may resolve: the same roles.

Platform admins don't see it: it is company data (`support-access.md`).

**What it shows:**

- **Order:** open exceptions first, oldest first, then resolved ones if you tick "Show resolved ones too".
- **Each row:** a title, the detail, what to check, the amount, the provider, the reference or settlement id, and when it was found (company time zone).
- **"Resolve":** you say what you found, in 5 to 500 characters. **Resolving records your note and moves no money.** If money must move, use a reversal, a match or a refund, each approved by a second person.
- **Empty:** "Nothing to look into: the provider's records and settlements match ours."

## Exceptions, and what to do with each

| Title on the screen | Kind | Comes from | What to do |
| --- | --- | --- | --- |
| Paid at the provider, missing here | `missing_here` | Transactions | The provider lists a successful charge, and processing it did not record it. Check Unmatched receipts (`/payments/unmatched`; the row links there). If it isn't there either, check the charge in the provider's dashboard, then report it as an incident: the normal path failed. |
| Recorded here, not listed by the provider | `missing_at_provider` | Transactions | We have a payment the provider doesn't list for that day. It was already asked directly (a charge started before midnight and paid after is cleared that way), so this one remains. Check it with the provider. If the money never arrived, reverse the payment; a second person approves. |
| The amount or currency differs | `amount_differs` | Transactions, or a charge in another currency | The detail gives both amounts, or the foreign currency. Only cedis are ever posted, so a charge in another currency posted nothing. Check it with the provider. Correct a wrong amount by a reversal and a new payment, never an edit. |
| Not successful at the provider | `not_successful_at_provider` | Transactions | We recorded it, but the provider shows it failed or pending. If the money never arrived, reverse it (two-person approval). |
| A settlement does not add up | `settlement_difference` | Settlements, or the clearing check | Compare the provider's settlement report with the bank statement of the account it paid into. The detail says which part differs. A clearing difference reads "Provider clearing does not agree with the provider…" (below). |
| Paid a different amount than asked | `verified_amount_differs` | The verify step, at payment time | The amount received was posted, not the amount asked. Check that the tenant's balance is right and tell the tenant what was received. Nothing to reverse. |
| A receipt went out late | `receipt_late` | The receipt job | The receipt was sent more than a minute after confirmation (BC-06). Check that messages are flowing (`queue-backlog.md`). |

**For every row:**

- **Before resolving,** write down what you checked and with whom, and any provider ticket number.
- **Never put personal data in the note:** no phone numbers, ID numbers or account numbers. Use the payment reference.
- **Open exceptions wait for a person;** nothing reminds anyone. The company's admin should check the screen every morning after the 02:00 and 02:30 runs. **Gap:** no alert, task or dashboard count tells staff that exceptions are waiting.
- **Money that left a tenant and reached no one** makes the exception an incident (`incident-response.md`).

## Unowned charges

A provider transaction that no company owns raises an alert, not an exception, because no company's screen can show it.

| Alert | Severity | Meaning |
| --- | --- | --- |
| `payments.reconciliation_unowned` | warning | Reconciliation found a provider transaction that matches no payment, no payment intent and no known subaccount. |
| `payments.settlement_unowned` | warning | A payout report names a subaccount we don't know. |
| `payments.unknown_subaccount` | warning | A payment (webhook or verify) arrived for a subaccount we don't know. |
| `payments.platform_unreconciled` | warning | Platform (`SUB-`) transactions or payouts arrived and nothing took them: the subscription module was not registered. A deployment problem; report it to engineering. |

**What to do (platform admin):**

1. **Find the transaction.** Open the provider's dashboard for the day and compare it with what we hold. **Gap:** the alert carries only the provider and the kind of difference, not the reference, so the comparison is by hand. The alert's context is in the ops email; the console's recent alerts show only the code and message.
2. **A subaccount we don't know** means the provider has a subaccount that no settlement account of ours names. This happens when it was made outside the product, or for a settlement account changed or retired at the provider first. Work out whose it is with the provider. Never attach it to a company by hand: settlement accounts are added through Settings → Settlement, with approval and the 24-hour wait (ADR-008).
3. **Money paid to the platform's own account that isn't a subscription** must not stay there (D1: the platform never holds rent). Refund it through the provider to the payer, and record the incident.
4. **Nothing is posted** for an unowned charge. Once its company is known and its subaccount is set up properly, the next run processes it.

## The clearing check (1050)

**What it compares** (invariant 11), for each settlement account the provider shows activity for:

- **Our side:** our 1050 balance for that provider and settlement account. That is confirmed payments not yet paid out, less refunds and chargebacks not yet deducted.
- **The provider's side:** what it still holds unsettled for that subaccount. That is successful charges of the last 14 days not yet in a payout, less refunds and chargebacks not yet deducted.

**When they differ:**

- a `settlement_difference` exception is raised in that company, once a day per account;
- its detail reads "Provider clearing does not agree with the provider: our books hold GH₵X not yet paid out to this account, the provider GH₵Y (invariant 11)";
- for the platform's own provider account, the critical alert `subscription.clearing_difference` is raised instead.

**Likely causes, in order:**

1. **A payment confirmed more than 14 days ago and still not paid out.** The provider side looks back 14 days only, so the payment stays in our 1050 and drops out of the provider's figure. Ask the provider why it hasn't settled. A first payout to a new or changed subaccount waits for verification (OQ-42).
2. **A refund or chargeback the provider made that we haven't reversed yet.** The next transactions run catches it. If it persists, check the reversal at the provider.
3. **A settlement we haven't reconciled yet**, for example one paid out late in the day. It clears on the next run.
4. **None of these:** treat it as a money incident (`incident-response.md`). Don't resolve it with a note until the two figures agree on a later run.

## Nightly sub-ledger checks and their alerts

Every check reads in one read-only snapshot, so a payment committing midway can't raise a false alarm.

| Job | Alert (all critical) | It proves |
| --- | --- | --- |
| `billing.subledger-check` | `billing.subledger_mismatch` | Every entry balances in each book. 1100 per invoice line equals what is outstanding. 2010 per lease equals advances to lines not yet started plus the credit held. 2100 per lease equals deposits held. No payment is allocated beyond itself, and a reversed one allocates nothing. 1060 per collector and book equals approved cash not yet banked. 2090 per payment equals unmatched money still waiting. |
| `reporting.fee-check` | `reporting.fee_mismatch` | Each management fee equals its rate on its base, and fees equal the ledger. |
| `ledger.agent-cash-check` | `ledger.agent_cash_negative` | No owner's 1070 is below zero. A chargeback can't be refused, so it can take it negative. |
| `subscription.subledger-check` | `subscription.subledger_mismatch` | The platform book's 1100 and 2020 against subscription invoices and credit. |
| `audit.verify-chains` (01:00) | `audit.chain_broken` | Each company's audit chain recomputes, and its anchors still match. See `incident-response.md`. |

**What the alert tells you:**

- **`billing.subledger_mismatch`:** the company id, the number of mismatches and the first five as `check:subject`. The subject is an invoice line, lease, payment or collector id; the check is one of `receivable`, `prepayment`, `deposit`, `deposit_unfunded`, `payment`, `cash`, `suspense` or `entry`.
- **`reporting.fee_mismatch`:** the fee keys that differ.
- **Where to read the context:** the ops email carries it. The console's recent alerts show only the code, the message and the company.

**What to do:**

1. **Treat any of these as a money incident** of the highest severity (`incident-response.md`). A wrong balance is worse than a missing feature.
2. **Don't touch the data.** Take a snapshot first, if one isn't already taken (M12: an RDS snapshot; locally `pnpm db:backup`).
3. **Get the full list on a copy,** never on the live database. Restore the snapshot to a database not called `rent`, then:

   ```bash
   cd packages/server
   DATABASE_URL=postgres://rent_app:…@<copy>/rent_restore_<date> \
   DATABASE_OWNER_URL=postgres://rent_owner:…@<copy>/rent_restore_<date> \
     node_modules/.bin/tsx --tsconfig tsconfig.runtime.json --env-file-if-exists=../../.env \
     scripts/drill-checks.ts --json checks.json
   ```

   It refuses a database called `rent` and `NODE_ENV=production`. It reads only, with alerts off, and prints ids and counts, never personal data.
4. **Find the cause.** It is almost always code: a posting rule, an allocation or a job that ran twice without its key. Fix the code with a test named for the requirement it proves.
5. **Repair through the product:** reversals, credit notes and new entries, each approved as usual. A repair that the product's actions can't express needs an engineering change, reviewed like any posting rule. Never hand-written SQL.
6. **`ledger.agent_cash_negative`** is usually a chargeback on money the agency already remitted. The owner's book shows the agency holding less than nothing for them. The agency recovers it from the owner's next collections or by agreement. Record what was agreed. No data change is needed: the balance recovers as new rent arrives.
7. **Afterwards:** the next night's run must pass for that company. Record the incident.

## Locally

```bash
# Reconciliation exceptions by kind, open and in total (no personal data).
docker compose exec -T postgres psql -U postgres -d rent -c \
  "select kind, provider, count(*) filter (where resolved_at is null) as open, count(*) as total
   from reconciliation_exception group by 1, 2 order by 3 desc"

# Recent alerts, as the console lists them.
docker compose exec -T postgres psql -U postgres -d rent -c \
  "select occurred_at, severity, code, message from alert_event order by occurred_at desc limit 20"
```

In production, use the console and the company's Reconciliation screen, never a database shell.
