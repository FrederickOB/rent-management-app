# Incident response

- **Status:** M11. Alerts are stored and emailed (M1, M10), and the console's System health shows them. The M11 operations tools are built: replay, retry, queue-age alerts and the worker heartbeat. **Nobody is on call yet, and nothing pages anyone:** uptime monitoring and paging arrive with the first deployment (M12). The founder names the on-call people and confirms the severities below before the pilot.
- **Covers:** anything that stops landlords, agencies or tenants using the product, or puts money, evidence or personal data at risk. That runs from the first alert to the record kept afterwards.
- **Rules that never bend, in an incident as at any other time:**
  - never insert, edit or delete ledger, payment, allocation, receipt, notice, message or audit rows by hand;
  - never post money from a webhook body or a screenshot;
  - every fix goes through the product's own paths and is audited.

## Severities

These are proposed. The founder confirms them and sets the response times with the on-call rota.

| Severity | What it means | Examples |
| --- | --- | --- |
| **SEV1** | Money, evidence or personal data is wrong or exposed, or nobody can use the product | Any nightly ledger check failing (`billing.subledger_mismatch`, `reporting.fee_mismatch`, `subscription.subledger_mismatch`); a payment posted twice or to the wrong lease; a receipt number gap; `audit.chain_broken` or `audit.anchor_mismatch`; one company's data visible to another; a suspected personal data breach (also `breach-response.md`); `uploads.infected` on a file someone may already have opened; API, web or links down for everyone |
| **SEV2** | A main path is degraded for many, with no money wrong | A provider outage (`payments.provider_unavailable`; `provider-outage.md`); the worker down or queues backed up (`ops.queue_age_critical`, `/health/worker` unhealthy); `job.dead_lettered` on payments or receipts; reconciliation not run; WhatsApp, SMS or email failing for everyone |
| **SEV3** | One company, one person or one feature; or a warning | `payments.receipt_late`; `payments.reconciliation_unowned`; one dead-lettered message; a lost authenticator (`lost-authenticator.md`); a bad-signature webhook now and then |

**Start a level higher** when unsure, and lower it once you know more. A money doubt is SEV1 until shown otherwise.

## Who is on call

- **To be named by the founder:** a primary and a backup, with phone numbers kept outside this repository.
- **Until then, the founder.**
- **A platform admin account is needed** for the console's operations tools. That account signs in with a password and an authenticator (`pnpm platform:bootstrap --add-admin` adds a second admin).
- **Production database credentials** are needed for the incident commands. They are held only by named people, in the secrets manager (M12).

## Where alerts come from

**Every alert is raised through one port and goes three ways at once:**

- the log (redacted);
- the ops email address, `OPS_ALERT_EMAIL`;
- the `alert_event` table.

Alerts carry ids and counts, never personal data. The email and the stored row are scrubbed again anyway.

| Source | What you get | Notes |
| --- | --- | --- |
| **Ops email** (`OPS_ALERT_EMAIL`) | Subject `[CRITICAL] <code>: <message>`, the time in UTC, and the context (ids and counts) | Locally it lands in Mailpit (default `ops@rent.local`). Set a real, monitored address in M12. **Gap:** a single address; no paging or escalation until M12. |
| **Console → System health** (`/platform/health`) | The last 50 stored alerts (time, severity, code, message, company id), plus everything below | The alert's context isn't shown here; read it in the email. |
| System health: worker and queues | The worker's heartbeat, each queue's depth and oldest waiting job with its thresholds and level | Thresholds: 5 and 15 minutes for payments queues, 30 and 120 for the rest. Each queue alerts at most once an hour at warning and once per half hour at critical. |
| System health: failed webhooks, dead-lettered jobs | Lists with Replay and Retry, each with a reason (5 to 500 characters) and a confirmation | Audited in the platform's chain. The commands are `pnpm ops:replay-webhooks` and `pnpm ops:redrive` (`failed-webhooks.md`, `queue-backlog.md`). |
| System health: scheduled jobs, audit chains | The last run and state of each scheduled job; when the chains were last verified, and how many are broken | A nightly job that didn't run is an incident in itself. |
| **Health endpoints** | API: `/health/live`, `/health/ready` (database), `/health/worker` (503 when the worker hasn't beaten within 2 minutes). Web: `/health`. | For the uptime monitor (M12). Locally the API is on 3700 and the web app on 3701 (README). |
| **The company's own screens** | Reconciliation exceptions (`/payments/reconciliation`), approvals waiting, notices served too late | Platform admins can't see these without a support grant (`support-access.md`). The company's admin reports them. |
| **People** | Landlords, agency staff, tenants (through their landlord), providers | Ask for references and ids, not screenshots with tenants' data. |
| **Provider status pages** | Paystack, Meta, Hubtel, Postmark, Expo | |

## First steps

1. **Acknowledge.** Say in the team channel that you have it. Open the incident record (below) and note the time in UTC.
2. **Set the severity.** Name the incident lead: you, until someone takes it over.
3. **Stop the harm, without touching data:**
   - **Money being posted wrongly, or messages going out wrongly:** stop the worker. Every job is idempotent, and webhooks are stored before they are answered, so nothing is lost: work waits and resumes once restarted (`queue-backlog.md`).
   - **A provider failing:** let the platform fail over or show the manual instructions (`provider-outage.md`).
   - **A compromised staff or platform admin account:** sign them out everywhere and reset their two-factor (`lost-authenticator.md`). Remove their membership if needed (Settings → Users and roles).
   - **Personal data exposed or at risk:** also follow `breach-response.md` from now on.
4. **Keep the evidence before fixing anything:**
   - **A database snapshot:** in M12, an RDS snapshot; locally `pnpm db:backup`.
   - **The alert emails.**
   - **The `alert_event` rows of the period.**
   - **The worker's and API's logs.**

   Copies go only to restricted storage.
5. **Diagnose with the runbook for it** (below). Check money first on a copy: `scripts/drill-checks.ts` runs every nightly check (`payments-reconciliation.md`, `backup-restore.md`).
6. **Fix through the product:** a code fix with its test, a replay, a retry, a reversal approved by a second person. A data repair the product can't express is an engineering change, reviewed, never a hand-written statement.
7. **Confirm the recovery:**
   - the queues drained;
   - `/health/worker` is healthy;
   - the next nightly checks pass;
   - the next morning's reconciliation exceptions are explained.

## Communication

- **Inside the team:** one channel per incident. The lead posts what is known, what is being done and when the next update comes. Times are in UTC, with Accra time beside them.
- **Landlords and agencies affected:**
  - **Who:** the incident lead tells their admins by email, at the start of a SEV1 or SEV2, at each real change, and at the end.
  - **What:** what is affected, what they should do (for example: tell tenants card and MoMo may fail; cash and transfers still go through the usual approvals), and what isn't affected.
  - **What not to send:** a tenant's name, phone or amounts, or another company's details.
  - **Gap:** there is no in-product banner or status page for this.
- **Tenants:** through their landlord, who owns the relationship (and, under Act 843, the data). The platform has no tool to message a company's tenants itself, and must not use a company's broadcast for this.
- **Providers:** open a ticket with the provider's reference numbers and times. Never send tenants' personal data in a ticket.
- **Personal data breaches:** what is said, to whom and when follows `breach-response.md`. Counsel decides what the law requires there.

## The record

**Keep it outside this repository** (it may name people), in the place the founder chooses. Write it within a few days of the end.

```
Incident <date>-<n>   Severity: SEV_   Lead: <name>
Start (UTC):   Detected (UTC):   Contained (UTC):   Resolved (UTC):
How it was found: alert <code> / console / customer / provider
Impact: companies (ids), payments, receipts, messages or notices affected (counts), tenants affected (counts)
Personal data involved? yes / no / unknown -> breach-response.md
Timeline: what was seen and done, with times
Cause:
What fixed it: code change (commit), replays and retries (ops_action ids), reversals (ids)
Checks run afterwards and their results: drill-checks, reconciliation, audit chains
Customers told: who, when, what
Follow-ups: what, owner, due
```

- **For an outage:** add the payments affected and the alerts raised (`provider-outage.md`).
- **For a SEV1:** the founder reviews the record with the lead and agrees the follow-ups.

## Runbooks

| Situation | Runbook |
| --- | --- |
| Ledger checks, reconciliation exceptions, unowned charges, clearing (1050) | `payments-reconciliation.md` |
| The payment provider refuses, times out or stops sending webhooks | `provider-outage.md` |
| Webhooks failed, dead-lettered or lost; replay | `failed-webhooks.md` |
| The worker stopped, queues backing up, month end | `queue-backlog.md` |
| Restoring the database, point-in-time recovery | `backup-restore.md` |
| Personal data exposed, lost or at risk | `breach-response.md` |
| A notice that isn't acknowledged; physical service | `notice-escalation.md` |
| Reading a customer's company to help them | `support-access.md` |
| A lost authenticator; signing a person out everywhere | `lost-authenticator.md` |
