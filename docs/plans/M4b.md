# M4b: Provider payments and receipts

- **Status:** approved by the founder on 2026-10-30 with every recommendation in section 2; decision 9 added on 2026-11-03 from the founder's answer. It is built after M4a, and builds on M4a's ledger (`docs/plans/M4a.md`).
- **Inputs:**
    - `BUILD_PLAYBOOK.md` (the M4 prompt, second half) and `docs/plans/roadmap.md` (the M4b row and prompt amendment);
    - `CLAUDE.md` sections 4, 8, 9 and 10;
    - PRD sections 7, 16 and 17;
    - `docs/architecture.md` sections 5, 6, 8 (payment flow), 9 (secure links) and 10 (jobs);
    - ADR-005, ADR-008 and ADR-010;
    - prd-issues 9, 34 and 35;
    - OQ-01 to OQ-08, OQ-25, OQ-41 and OQ-42.
- **Scope:**
    - BC-02, BC-03 (matching), BC-04, BC-06, BC-09 and BC-12;
    - posting rules P03 to P05 for real providers, P21(b) for chargebacks, P22, P23 for provider payments and P31;
    - settlement accounts and destinations (ADR-008);
    - the pay page in `apps/links`;
    - the tenant app's money screens;
    - size budgets in CI.
- **Branch:** `m4b-payments`, stacked on `m4a-ledger`.

## 1. Done when

1. **Every BC acceptance criterion in scope passes as an automated test.** The PRD's story: a tenant opens a pay link, pays by MoMo through the fake provider, the balance updates and the receipt arrives within one minute (★ e2e).
2. **The playbook's M4 tests pass** (★ in section 6).
3. **The auto-match rate on the seed** is measured and reported, for provider payments; direct transfers are counted separately (prd-issues 35).
4. **Size budgets:** the pay page in `apps/links` and the first load of the Expo web build are each under 1 MB, enforced in CI.
5. **Build checks:** CI is green, and the playbook's review subagent, which has not seen my reasoning, has audited the posting rules and allocation against PRD sections 7 and 12. Its findings are in the report, with no open "must fix".
6. **Report:** the M4b report is at the bottom of this file.

## 2. Decisions needed before I build

| # | Decision | Finding | Recommendation | Files changed on approval |
| --- | --- | --- | --- | --- |
| 1 | The second provider and failover (BC-02) | **The playbook:** it asks for a second adapter with failover.<br>**D1:** every provider that carries rent must settle directly into landlord and agency accounts.<br>**OQ-02:** Flutterwave is the candidate but unconfirmed; Hubtel cannot carry rent. | **Build the failover seam:** a provider registry, a per-company order, and failover when creating a charge, tested with a second fake provider.<br>**The Flutterwave adapter waits** for OQ-02's written confirmation. | none |
| 2 | Where MoMo payments settle (OQ-01) | Paystack documents bank-account subaccounts. MoMo wallets as destinations need written confirmation. | **Settlement accounts are bank accounts only** until Paystack confirms MoMo wallets in writing. Tenants still **pay** by MoMo. | none |
| 3 | Live rent collection (OQ-03) | `CLAUDE.md` section 8: no live rent collection until counsel's written opinion on Bank of Ghana licensing is in hand. | **Live keys need an explicit switch.**<br>• The API refuses to start with a live Paystack key unless `LIVE_RENT_COLLECTION=enabled`.<br>• The startup log records who enabled it, from the deployment's configuration.<br>• Everything in M4b runs on test keys and the fakes. | `.env.example` |
| 4 | Testing against Paystack itself | The adapter can be built from Paystack's documentation and tested on recorded responses. A real check needs a Paystack test account, whose keys are secrets. | **Contract tests run on recorded fixtures.** An optional sandbox smoke test runs only when `PAYSTACK_TEST_SECRET_KEY` is set, locally or in a manual CI job.<br>**From you, if you can:** a Paystack test account, with its keys kept in the secrets manager, never in the repository. | none |
| 5 | The email Paystack requires (OQ-06) | Paystack needs a customer email, and many tenants have none. | A per-tenant address on a platform-owned domain, never derived from the phone number, set by `PAYMENTS_CUSTOMER_EMAIL_DOMAIN`. Checkout shows the tenant's name. **From you:** the domain. | `.env.example` |
| 6 | Where an agency-managed owner's rent goes (ADR-008) | Settlement is resolved from lease → unit → property → owner → management agreement. No management agreement exists yet. | **A minimal management agreement per owner** in an agency, effective-dated:<br>• rent goes to the owner's account or to the agency's client account;<br>• the agency chooses for each owner, and there is no default: links cannot be sent for that owner's leases until it is set.<br>**A landlord company** always uses its own account.<br>Fee terms arrive with AC-02 (M9). | none |
| 7 | What the pay link lets a tenant pay (BC-04) | BC-04: "shows amount due and lets the tenant pay part". It does not say whether a tenant may pay ahead. | **Pre-filled** with the amount due now.<br>**Accepted:** any amount from GH₵1 up to the rent remaining to the end of the term. More than is due becomes credit (P05), recorded as months paid ahead (AR-05 under the company's setting). | none |
| 8 | Store builds (M1 deferred them to M4b) | They need the Apple and Google developer accounts, after a D-U-N-S number (OQ-25). | **EAS profiles for internal testing,** submitted only once the accounts exist. If they do not exist yet, the report says so and nothing is blocked. | none |
| 9 | How a payment pays a multi-month invoice (M4a open item 1; decided 2026-11-03) | **M4a:** within one invoice, every rent line is paid before any service charge. A part payment on an annual invoice with service charge then covers rent for every month and service charge for none, and paid-until shows no whole month.<br>**The founder:** "rent in Ghana is paid monthly, bi-annually, annually and two years in advance; handle it as such." | **Month by month within an invoice:** each month's rent, then that month's service charge, with VAT and levies straight after their line, before the next month. Across invoices, the oldest due date still goes first (BC-07).<br>**Rent cycles:** monthly, six-monthly ("bi-annually", twice a year), annual, and a new **two-yearly** cycle (24 months), on the lease form, the lease document, the tenant app and the API. Quarterly stays for leases that use it.<br>**Advance checks:** a two-yearly cycle is 24 months paid ahead, so `warn` flags it and `block` refuses it under `advance_rent_policy` (AR-05); `off`, the default, records it. | `packages/domain` (allocation order, lease terms); `packages/contracts`; lease form, document template and tenant app labels |

## 3. Scope by requirement ID

| ID | M4b delivers | Later |
| --- | --- | --- |
| BC-02 | **Payment methods:** MTN MoMo, Telecel Cash, AT Money and card through Paystack.<br>**Settlement:** direct to the landlord's or agency's bank account through a subaccount; the fee is borne by the subaccount (OQ-07).<br>**Failover:** the seam, with a second fake. | The Flutterwave adapter (OQ-02); "Pay with Transfer" (OQ-08). |
| BC-03 | **Automatic matching** only on the pay link's intent metadata or an exact lease payment reference (M4a). Anything else goes to the queue. | |
| BC-04 | **Pay links:** one secure link per invoice (purpose `pay`), sent by SMS and email where consent is recorded, with each reminder and from the tenant app.<br>**The pay page** (`apps/links`) shows what is due, pre-filled, and accepts part payment.<br>**Expiry:** when the invoice is settled, or after 60 days. | WhatsApp delivery (M6). |
| BC-06 | **Receipts within a minute:** on `payment.posted`, the M4a receipt PDF is sent on the tenant's channel, with a link to download it. The time from confirmation to send is recorded per receipt, with an alert past 60 seconds. | Push and WhatsApp (M6). |
| BC-09 | **The reminder ladder:** 7 days before due, on the due date, and 3, 7 and 14 days after, from company settings. Each step goes once per invoice, stops as soon as the invoice is paid, needs consent, and carries the pay link. | WhatsApp (M6). |
| BC-12 | **The unmatched queue:** provider payments with no intent or reference, and direct receipts with no lease. Suggestions are ranked by amount, phone, date and history; a person confirms each match (P23). A receipt can be refunded to the payer with approval (P31). | Statement import (Phase 2). |
| Reconciliation | **Daily:** provider transactions against our payments; missing ones go through the normal path; unexplained ones are flagged. Then settlement reports against payments, posting P22, with any difference raised as an exception. | |
| Settlement accounts (ADR-008) | **Bank accounts** for owners and agencies: the number encrypted and masked, a name check with the provider where available, two-person approval, 24 hours before first use, and an SMS and email alert to the owner. Each becomes a Paystack subaccount. | MoMo wallets (OQ-01). |
| Tenant app (roadmap) | **Home** shows each tenancy's balance, paid-until and next due date.<br>**Pay** opens the pay page.<br>**History and receipts** with downloads.<br>**An offline cache** shows the last figures with the time they were fetched. | |
| NFR budgets (roadmap) | `apps/links` pages and the Expo web first load under 1 MB, in CI. | Lighthouse (M11). |

## 4. Design

### 4.1 Modules

- **`payments` (layer 6):**
    - providers and the failover registry;
    - payment intents, pay links and the pay page API;
    - the webhook inbox, verification and matching;
    - the unmatched queue;
    - receipt delivery;
    - reconciliation and settlement.

    It posts through M4a's billing allocation and the ledger's posting service.
- **`companies`:** settlement accounts and management agreements (ADR-008), with their approvals.
- **`messaging`:** sends receipts, pay links and reminders through M3's outbound core (SMS and email now).

### 4.2 Settlement accounts and destinations

- **`settlement_account`:**
    - the owner or the agency it belongs to;
    - bank code and branch, and the account number (AES-256-GCM, blind index, masked);
    - the account name returned by the provider's check;
    - status (waiting for approval, approved and waiting 24 hours, active or retired);
    - the Paystack subaccount code.
- **Changes** go through `settlement_account.change`: a second person approves, the account is usable 24 hours later, and the owner is alerted by SMS and email. Redirecting rent is the most likely fraud against this product (ADR-008).
- **`management_agreement`** (minimal, decision 6): owner, rent destination (the owner's account or the agency's client account), and the date it takes effect.
- **Destination per charge:** lease → unit → property → owner → agreement → active settlement account → subaccount. A lease with no usable destination cannot be sent a pay link, and the lease page says why.

### 4.3 Pay links and the pay page (BC-04)

- **The link:** a pay link is a `secure_link` with purpose `pay`, for one tenant and one invoice:
    - 256 random bits, of which only the hash is stored;
    - it expires when the invoice is settled, or after 60 days;
    - it is rate-limited.
- **What the page shows** (`apps/links`):
    - what is due now (this invoice, and any older balance, since payments go to the oldest debt first);
    - the unit and the payment reference;
    - paid-until.
- **Paying:**
    - **MoMo:** the tenant enters the MoMo number to charge and its network, then sees "Approve the payment on your phone". The page checks the status with a plain refresh, so it works without JavaScript.
    - **Card:** a redirect to Paystack's checkout, which returns to our page; our page then verifies.
- **The page itself** is server-rendered, has no cookies, a strict nonce CSP and no third-party scripts, and must work on 3G and a 5-inch screen within the 1 MB budget.
- **`payment_intent`:**
    - the invoice, lease and amount, the channel and provider, our charge reference, and the link;
    - status: initiated, pending, confirmed, failed or abandoned;
    - a unique idempotency key, so a double tap creates one charge.
- **Each charge** carries the company, lease, invoice and intent ids as provider metadata, so matching is exact, and names the subaccount, which bears the fee.

### 4.4 Webhooks and verification

- **Intake** (`POST /webhooks/paystack`, outside the contracts, through the ADR-002 system path):
    1. store the raw request in the global `webhook_inbox`, unique on provider and event id;
    2. verify the HMAC-SHA512 signature;
    3. answer 200;
    4. queue `payments.process-webhook`.

    A bad signature is stored as rejected, posts nothing and raises a security alert.
- **Processing:**
    1. find the intent by our reference, through a narrow system function that returns only the company and intent ids;
    2. call the provider's verify endpoint;
    3. compare amount, currency, status and reference exactly;
    4. post in one transaction: the payment, its allocations (P03 to P05, accruing first), the receipt number and the outbox event.
- **Edge cases:**
    - if the verified amount differs from the intent, the verified amount (the money received) is posted and flagged for review;
    - a duplicate webhook is a no-op;
    - the money is never posted from a webhook body.
- **`payments.verify-pending`** checks intents pending over 5 minutes, so a lost webhook is caught within minutes. Reconciliation catches anything left the next day.

### 4.5 Matching and the unmatched queue (BC-03, BC-12)

- **Automatic matching** only on intent metadata or an exact lease payment reference.
- **Everything else** waits in suspense (P23):
    - in the owner's book when the money settles to the owner's account;
    - in the company book when it settles to the agency's.
- **The queue:**
    - lists provider payments and direct receipts with no lease;
    - suggests leases ranked by an exact open amount, the payer's phone against tenants' phones, the date against due dates, and earlier payments from the same payer;
    - a person confirms each match, which allocates it (P23, across books where needed).
- **Refunds (P31):** a payment that belongs to no one can be refunded to the payer, with approval: through Paystack's refund for provider payments, or recorded with proof for transfers.

### 4.6 Receipts (BC-06)

- **Trigger:** `payment.posted` queues `payments.issue-receipt`.
- **The receipt:** the M4a receipt PDF, rendered and stored.
- **Sending:** a message with a link (purpose `receipt`, a 5-minute download behind a 30-day link) goes on the tenant's channel: SMS or email now, push and WhatsApp in M6. A failed send is retried, then tried on the next channel.
- **The latency metric:** each receipt records the time from confirmation to send, with an alert past 60 seconds.
- **The receipt also stays** in the app and on the lease page.

### 4.7 Reminders (BC-09)

- **The job:** `billing.rent-reminders`, daily at 08:00 in the company's time zone.
- **Which steps:** the company's offsets (−7, 0, +3, +7 and +14 days by default).
- **For each step:** every invoice with an open amount gets one reminder: one `reminder_sent` row per invoice and step.
- **The message:** the amount due, the due date and the pay link. The first step (7 days before the due date) also carries the invoice's PDF link, so it is how an invoice reaches the tenant.
- **Rules:**
    - consent per channel (CM-09);
    - test contacts never receive anything;
    - the ladder stops as soon as the invoice is paid.

### 4.8 Reconciliation and settlement

- **`payments.reconcile-transactions`** (02:00) lists the previous day's provider transactions:
    - a successful one we do not have goes through the normal path (verify, then post or queue);
    - a local payment the provider does not list is flagged.
- **`payments.reconcile-settlements`** (02:30) matches each settlement report to its payments and posts P22:
    - one entry per settlement per book;
    - Dr 1010 or 1070 with the net amount, Dr 5200 with the fees, Cr 1050 with the gross;
    - lines carry the settlement id.

    A difference raises a reconciliation exception, shown to managers.
- **Chargebacks and provider refunds** are payment reversals (P21b, from M4a): Cr 1050 when the money is deducted from a later settlement, a credit receipt, and a manager alert.
- **A provider debit after payout** is recovered from the landlord's next settlements (OQ-41).

### 4.9 Failover (BC-02, decision 1)

- **The registry** holds each company's provider order.
- **When creating a charge fails** with the first provider:
    - the next provider is tried only if it is configured and settles directly (D1);
    - otherwise the page shows "Try again shortly" with the landlord's own payment instructions, and an incident alert is raised.
- **Tests** use two fakes.

### 4.10 The tenant app (`apps/tenant`)

- **Home:** for each landlord's tenancy, the balance due, paid-until and the next due date and amount.
- **Pay:** asks the API for a fresh pay link and opens the pay page, as M3's "To sign" does.
- **History:** payments with their receipts, downloaded through 5-minute links.
- **Offline cache:** the last figures, with the time they were fetched and "may be out of date" when offline. No link or token is ever cached.
- **New tenant endpoints:** `GET /me/leases/:id/billing`, `GET /me/payments` and `POST /me/leases/:id/pay-link`.

### 4.11 Permissions

| Action | Who |
| --- | --- |
| `payments.view` (queue, intents, reconciliation exceptions) | Owners (own company), agency admins, managers, accountants |
| `payments.match` (confirm a match) | Agency admins, managers, accountants |
| `settlement_account.change` (request) | Owners, agency admins; approval by a second eligible person |
| `payment.refund_unmatched` (P31, request) | Agency admins, accountants; two-person approval |

### 4.12 Jobs

| Job | Trigger | Idempotency key | Retries |
| --- | --- | --- | --- |
| `payments.process-webhook` | inbox row stored | provider + event id | 10, 1 min to 1 h, then dead letter |
| `payments.verify-pending` | every 5 min | intent id + 5-minute window | 3 per run |
| `payments.issue-receipt` | `payment.posted` | payment id | 5; SLA alert at 60 s |
| `billing.rent-reminders` | daily 08:00 | invoice id + ladder step | 3 |
| `payments.reconcile-transactions` | daily 02:00 | provider + date | 5 |
| `payments.reconcile-settlements` | daily 02:30 | provider + settlement id | 5 |
| `companies.settlement-account-ready` | 24 hours after approval | account id | 5 |

### 4.13 Fakes, budgets and seed

- **Fakes:** `apps/fake-providers` refines its payments shapes to Paystack's: MoMo approval, card checkout, webhooks, transaction lists, settlements, refunds and subaccounts. A second fake provider tests failover.
- **Budgets in CI:** a check loads the pay and sign pages and the Expo web build's first screen and fails over 1 MB. M1 measured the Expo web build at about 534 KB gzipped.
- **Seed:**
    - settlement accounts for each owner and the agency, already past their 24 hours;
    - the agency's management agreements;
    - provider payments through the fake, some with intent metadata and some without, so the queue and the auto-match rate have data;
    - one settlement with its P22 entry;
    - one reconciliation exception.

## 5. Build order

0. Decision 9: month-by-month allocation within an invoice, and the two-yearly rent cycle. The domain's property tests, the reference model and the differential test change with it; existing allocation tests whose expected order changes are listed in the report.
1. Settlement accounts and management agreements, with their approvals.
2. Paystack adapter on fixtures; the second fake; the registry.
3. Payment intents, pay links and the pay page.
4. Webhook inbox, processing, verify-pending.
5. Matching, the queue, P23 and P31.
6. Receipt delivery and the latency metric.
7. Reminders.
8. Reconciliation and settlement (P22), chargebacks.
9. The tenant app's screens and cache.
10. CI budgets, seed, the review subagent, the report.

### Progress

**2026-11-03, the backend: steps 0 to 8 and the seed (step 10).** Everything outside `apps/web`, `apps/links` and `apps/tenant`; those screens are built alongside, against the contracts below.

- **Step 0, decision 9:**
    - **Allocation order** (`packages/domain/src/billing/lines.ts`): due date first, so the oldest invoice still goes first; then the deposit, the charge periods month by month (each month's rent, then its service charge), and one-off charges; each VAT or levy line straight after its line. `docs/architecture.md` section 6 says so.
    - **The two-yearly cycle:** `two_yearly` (24 months, "Every two years") in `RENT_CYCLES` and `CYCLE_MONTHS`, and so in the contracts, the API, the lease document template and the advance check (`warn` flags it and `block` refuses it; `off` records it).
    - **The reference model** checks month by month (`monthByMonthBreak`, `LeaseLedgerModel.checkMonthByMonth`), in the domain's property tests and against the database in the differential test.
    - **Existing tests:** none failed under the new order, so no expectation changed. Two shared generators were widened to draw the two-yearly cycle as well (with a two-year term): the domain's `leaseArbitrary` (`packages/domain/src/billing/testing/scenarios.ts`) and the differential test's (`packages/server/test/billing-properties.int.test.ts`, used by AC-01, BC-07, BC-11 and AR-01). AR-01's database test gained one assertion: no month-by-month break.
- **Step 1, settlement accounts (ADR-008; decisions 2 and 6):**
    - bank accounts only; the number encrypted (field cipher), with a blind index and a mask; reveal needs `settlement_account.reveal`, a reason, and is audited;
    - adding and retiring go through the approvals engine (`settlement_account.change`, `settlement_account.retire`), owners and agency admins approve, and the initiator never can; usable 24 hours after approval (`cooling_off`), then a subaccount with each provider that settles directly;
    - the owner is told by SMS and email at each step (purpose `settlement_alert`, sent without channel consent: OQ-55);
    - management agreements per owner in an agency, effective-dated, with no default; the destination is resolved lease → property → owner → agreement → active account → subaccount, and the reason a link cannot go is shown to staff.
- **Step 2, providers:**
    - **Paystack** (`packages/integrations/src/payments/paystack.ts`) on fixtures built from Paystack's documentation, not recorded from a live account. **Fixture assumptions, to confirm in writing (OQ-01):** the Ghana MoMo provider codes `mtn`, `vod` and `atl` come only from third-party sources; the charge endpoint taking `subaccount` and `bearer`; settlements naming their subaccount with deductions; account-name checks failing with 422 for Ghanaian banks.
    - **Live keys:** the adapter, and so the API, refuses an `sk_live_` key unless `LIVE_RENT_COLLECTION=enabled`; the startup log names `LIVE_RENT_COLLECTION_ENABLED_BY`, never the key. The sandbox smoke test runs only with `PAYSTACK_TEST_SECRET_KEY`.
    - **The registry and failover:** each provider says whether it settles directly; one that does not is never tried. The company's order (`paymentProviderOrder`) or the deployment's. A second in-memory fake proves failover. `apps/fake-providers` speaks Paystack's shapes: MoMo charges, checkout, verify, lists, settlements, refunds, subaccounts, chargebacks and signed webhooks.
- **Step 3, pay links and the pay page API:** one link per invoice (`/p/{token}`), expiring when the invoice is settled or after 60 days; the page shows the lease's amount due now, pre-filled, and accepts GH₵1 up to the rent left in the term (decision 7). A double tap finds the same intent (`submissionId`). Error codes carry the families the page matches (`AMOUNT_TOO_SMALL`, `AMOUNT_TOO_LARGE`, `MOMO_PHONE`, `RATE_LIMITED`, `LINK_*_NOT_USABLE`, `LINK_SETTLED`, `PAYMENTS_UNAVAILABLE`). Limits: 120 opens per link an hour and per address in 10 minutes, 240 status checks per link an hour, 10 starts per link and 60 per address an hour. Staff send links from an invoice; tenants get theirs from the app (`/me/leases/{id}/pay-link`).
- **Step 4, webhooks:** the raw request is stored in `webhook_inbox`, the signature checked, 200 or 401 returned. A bad signature is stored as rejected, raises a security alert and never takes an event id from a valid event. Processing calls the provider's verify endpoint and compares amount, currency, status and reference exactly; nothing is ever posted from the body. `payments.verify-pending` checks intents pending over 5 minutes.
- **Step 5, matching and the queue:** automatic matching only on the intent's reference or an exact lease reference (BC-03); anything else is P23 suspense with ranked suggestions (amount, phone index, date, history). A person confirms each match, across books where the money settled into the agency's account. P31 refunds of unmatched money need a second person and go to the provider through a job.
- **Step 6, receipts:** on `payment.posted` the receipt goes on the tenant's consented channels with a 30-day receipt link (`/r/{token}`, PDF downloads of 5 minutes); the delivery records channel, time sent and the latency from confirmation, with an alert past 60 seconds.
- **Step 7, reminders:** the ladder from company settings (−7, 0, +3, +7, +14 days), each step once per invoice, the latest due step only (earlier missed steps are recorded as skipped, so a tenant never gets a burst), stopping when nothing is left to pay; each carries the pay link, the first one the invoice.
- **Step 8, reconciliation and settlement:** daily transaction reconciliation posts missing payments through the normal path and flags the unexplained; settlement reconciliation posts P22 per settlement and book, each 1050 credit on its payment, with fees shared by gross per book; a difference raises an exception. Chargebacks post P21(b) from current allocations with a credit receipt and an alert to everyone who sees payments; the next settlement's deductions clear them.
- **Step 10, the seed:** active settlement accounts and agreements for both agency owners (one to the owner's account, one to the agency's client account) and the landlord; provider payments through the fake, two without intent metadata (queue suggestions); one reconciliation exception (a verified amount that differs); one settlement with its P22 entries; SMS consent for Kofi Arrears-45; a two-yearly lease for the demo tenant. **Auto-match rate on the seed:** provider payments 3 of 5 (60%); direct transfers recorded against a lease 4 of 5 (80%), counted separately (prd-issues 35). The rate is low by design: the seed puts two payments without metadata in the queue to exercise it.
- **Design details settled while building** (none changes a decision):
    1. **The webhook inbox is its own queue.** `webhook_inbox` is global, so the API stores the row alone and a relay in the worker claims rows and enqueues `payments.process-webhook` in one transaction (LISTEN and a 1-second poll), rather than writing a company outbox event as section 8's diagram shows.
    2. **The receipt job takes its event's name** (`payment.posted`), as the outbox relay names queues, not `payments.issue-receipt`. The settlement-account job is `settlement_account.approved`, and refunds run as `payments.refund-unmatched`.
    3. **Chargebacks need no approval:** the provider has already taken the money back; a person cannot refuse it.
    4. **Staff alerts go to whoever the policy allows,** not to a list of roles: chargebacks to those with `payments.view`, settlement-account requests to those with `settlement_account.change`. The landlord contact on the pay and receipt pages is the first person who may change settlement accounts.
    5. **A verified amount that differs** from the intent posts the money actually received, allocates it normally and raises a reconciliation exception.
- **Not in this step:** the tenant app (step 9), the CI size budgets and the review subagent (step 10) belong to the screens and the report. The fake-providers Docker image must be rebuilt (`docker compose up -d --build fake-providers`) before the e2e tests use the new endpoints.

**2026-11-03, review fixes (the playbook's posting-rules audit at 207c740 and the general review of 5f2b391..4c21fda).** Each fix has a regression test named after its requirement, in `packages/server/test/payments-review.int.test.ts` unless another file is named. Migrations `0020_payments_review` (generated) and `0021_payments_review_security` (hand-written).

- **Must fix:**
    1. **Management agreements** (ADR-008; CLAUDE.md section 5):
        - every agreement, the first included, is a request (`management_agreement.change`) that owners or agency admins approve, the initiator never;
        - the owner is told by SMS and email when it is asked and when it is approved;
        - on approval it is written to take effect on the day asked or, if later, the first day that starts at least 24 hours after the approval; a day before today is refused;
        - the database refuses an agreement without such a request (`RA056`).
    2. **P31 refunds:**
        - posted only once the provider says `processed`;
        - `pending` leaves the refund `sent`, followed by its webhook or a check every 10 minutes;
        - `failed` marks it failed and posts nothing;
        - every run asks the provider first (`reversals`), so a retry never sends a second refund;
        - a refund event about our own refund is followed, never treated as a chargeback;
        - the in-memory fake now refuses a second refund and can keep one pending (`pendingRefunds`, `completeRefund`).
    3. **P22 counts P31 deductions** as it counts P21 ones, so the settlement debits the account with the real net and 1050 clears.
    4. **No reversal of refunded money:** a payment with a refund asked for, pending or done cannot be reversed, by the service or by the database (`RA055` on `payment_reversal`).
    5. **Reversing a settled provider payment:** once P22 has paid it out, the reversal's only option is the account it settled to (1010 or 1070, P21b); before that, provider clearing (1050). The wrong-lease flow (reverse, then record it again as a transfer into that account on the right lease) is tested. A payment reversed by staff before it settles still settles into 1050 later; recording it again there is not built (see notes).
    6. **The Paystack adapter's settlements:**
        - every page of a settlement's charges is read;
        - `deductedReferences` comes from the refunds that name the settlement (`settlement`, `deducted_amount`), looked up to 90 days back;
        - **assumption, in the fixtures and OQ-01:** a dispute the payer won is deducted as a refund with `dispute` set; Paystack does not document how chargebacks appear in a settlement;
        - a test runs the job path end to end through the adapter.
    7. **Currency:** the intent path, money with no intent, and transaction reconciliation all compare it exactly. A charge in another currency is never posted; it becomes an exception (shown as `amount_differs`, its detail naming the currency).
    8. **Negative-net settlements:** `provider_settlement.net_minor` may be below zero; the settlement posts and raises an exception. Each book's P22 posts in a savepoint, so one that cannot post is raised and the rest still post.
- **Should fix:**
    9. **Credit pays reopened debt:** after a reversal or a credit note, spare credit, oldest payment first, pays any accrued rent or service-charge period left owing, by a P02 credit draw (`P02:<line>:redraw:<n>`), in the engine and the reference model alike. Domain tests: `packages/domain/src/billing/reopened.test.ts`, including a property test.
    10. **The invoice list counts credit** as the walk and ageing do: `outstandingMinor` and `overdue` come from what remains after the walk.
    11. **Invariant 11:** after the settlements run, provider clearing (1050) per settlement account is compared with what the provider still holds unsettled for its subaccount (charges not paid out, less refunds and chargebacks not deducted, over 14 days). Any difference is raised once a day.
    12. **Failover after a lost answer:** only a clear "down" (503, 429) moves to the next provider. A timeout or any other ambiguous error first asks the same provider for the charge: it exists → it is followed; 404 → the next provider may take it; no answer → the intent stays with that provider for verify-pending.
    13. **The webhook flood:**
        - bad-signature and oversized requests keep only their size, a SHA-256 of the body, three headers and the sender's address as a keyed hash;
        - 20 per address per 10 minutes, then 429 with nothing stored;
        - one alert per provider per 15 minutes;
        - bodies over 64 KB are refused with 413.
    14. **The card return page** carries no pay-link token: `callback_url` is `${LINKS_ORIGIN}/p/return?reference=<charge reference>`. The page calls `POST /links/pay/return` with `{ reference, client }` and gets `{ status, receiptNumber, message, failureCode }` only. A pending payment is checked with its provider. Rate-limited per address and per reference.
    15. **`advance_rent_policy` on the pay page:** the rule for the term (`advance_rent.max_months.*`, unverified) as of today gives a cap: what is due now, plus the limit's months of rent and service charge, less what is already held ahead.
        - `block` stops the amounts at the cap;
        - `warn` shows it, accepts more, and records `advance_over_limit` with the limit and rule on the intent, for the compliance report (M5);
        - `off` is unchanged.
    16. **Reconciliation catches reversals:** charges the provider lists as reversed, and refunds and disputes made that day (`listReversals`), go through the chargeback path. A payment posted after its settlement was reconciled is settled when it appears (`P22:<settlement>:payment:<id>`, from the references now stored on `provider_settlement`).
    17. **Part refunds and disputes:** a payment is reversed only when what the provider took back equals it; a part is an exception for a person.
    18. **The fake provider in production:** the configuration already refused `FAKE_PROVIDERS_URL` in production; building the providers now refuses it too.
    19. **Charge status:** a `failed` charge fails the intent with `PROVIDER_CHARGE_FAILED`. A next step we do not support (`send_otp`, `send_pin` and the like) fails it with `PROVIDER_STEP_UNSUPPORTED` (OQ-01). The intent view carries `failureCode`.
    20. **Chargeback alerts** go only to people whose scope covers the payment's property or owner.
    21. **CI:** the backup job starts `fake-providers` with the other services, because the seed takes its demo payments through it.
- **Tests strengthened** (new tests; the old ones are unchanged):
    - TL-12: the intruder is a tenant of another lease in the same company;
    - BC-07: the webhook, the status poll, verify-pending and reconciliation race on one charge, then a second event id;
    - ADR-008: an account waits its 24 hours (the database holds it whatever the application's clock says), and the pay link is refused until the ready job activates it.
- **Recorded rather than fixed** (the review's notes):
    - **Fees on a settlement that names a payment we have not posted:** the settlement's fees are shared over the payments we have. A payment posted later settles in full with no fee share, so the totals are right but that payment's fee is on the others.
    - **The VAT rule date for invoices issued by a back-dated advance:** fixed. The rule is read as of the tax point (the payment's value date), in `issueCycle` and `issueForAdvance`.
    - **M4a plan 4.9, "reverse and record again":** for a provider payment, recording it again means a transfer into the account it settled to. Before it settles, a staff reversal credits 1050 and the later settlement leaves 1050 short, which invariant 11 raises. Re-matching unsettled provider money to another lease is not built.
    - **Raw webhook bodies** have no retention rule: added `data_retention.other.webhook_bodies` as `unverified`, with no value (0021).
    - **`suggestions()`** loads every lease's full state on each request, and the invoice list now loads each listed lease's state for the walk. Both are fine at pilot volumes; they need a summary query before many hundreds of leases.
    - **Many pay links per invoice:** see deviation 4.
- **Existing tests changed with the founder's approval** (2026-11-03):
    - `payments.int.test.ts` (item 1): the setup and the "says why a pay link cannot go" test set agreements through `agreementInForce` (asked 49 hours ago and approved by a second admin). No assertion changed.
    - The Paystack settlement test (item 6): its replay adds the refunds that name the settlement (`refunds.json`, which carries the deduction assumption) and serves the second charge from a second page, keeping the settlement's totals. `deductedReferences: []` became the one deduction of 20,000 pesewas. The references list is unchanged; it now needs the second page to be complete.
    - `corrections.test.ts` "restores every line and the credit exactly" (item 9). The P21 claim is now asserted on the reversal's own rows (they take back exactly the payment's share). What the later payment's credit redrew is allowed for in the outstanding; the 2100 and 1050 assertions are unchanged.
    - `billing.int.test.ts` P29 carry-over (item 9). The arrears are now an unpaid one-off charge of 100,000 raised before the credit note, with all twelve months paid; the 70,000 credit still carries to the renewal. No service raises one-off charges yet, so the test issues it through the engine.
    - `rls.int.test.ts` fixture (item 1). The agreement names a `management_agreement.change` request approved by the fixture's second person. No assertion changed.

**2026-11-03, links and tenant e2e fixes.**

- **Tenant receipt downloads** (BC-06): migration `0022_tenant_receipt_documents` lets a tenant session read the render requests and documents of its own receipts. Before it, `GET /me/receipts/{id}/download` always answered 404. Receipts are tenant-scoped, so a neighbour's stay invisible. No tenant route serves invoice PDFs, so invoices were not added. Tests:
    - "BC-06 a tenant downloads their own receipt, never a neighbour's": the service and RLS directly;
    - "BC-06 a tenant downloads their own receipt over HTTP": the API.
- **The fake provider's reset:** `DELETE /messages` now clears captured messages only, so a test that clears its inbox keeps the seed's subaccounts and charges. The new `DELETE /_reset` resets every store.
    - **Existing test changed with the founder's approval:** `apps/fake-providers/src/server.test.ts`, formerly "DELETE /messages resets every store, not only messages", now calls `DELETE /_reset` and is titled to match. Every assertion is unchanged.
    - New test: "DELETE /messages clears captured messages only: subaccounts and charges stay".
- **CI:** `pnpm test:e2e` brings services up with `--no-recreate`, so it never recreates the fake provider the seed filled. Locally the compose configuration hash is the same in a plain shell and under pnpm, so the cause in CI was not reproduced. `pnpm dev`, `pnpm test` and `services:up` are unchanged.

## 6. Tests

★ marks the tests the playbook requires for M4.

| Test | Level | Proves |
| --- | --- | --- |
| ★ `BC-07 any sequence of invoices and payments keeps the ledger whole` (fast-check) | integration | Provider payments, webhooks and reversals mixed into M4a's sequences: zero-sum, no over-allocation, allocated plus credit equals paid, and replaying the same webhook twice changes nothing. |
| ★ `BC-02 a tampered amount or bad signature posts nothing` | integration | A bad signature is rejected; a webhook whose verified amount, currency, status or reference differs is never posted from its body. |
| ★ `BC-02 a payment confirmed during an outage is picked up by reconciliation` | integration | No webhook and no verify; the next day's reconciliation posts it once. |
| ★ `BC-05 a cash receipt cannot be approved by the person who recorded it` | integration | M4a's test, rerun here, as the playbook lists it. |
| ★ `BC-06 receipt numbers have no gaps under concurrent payments` | integration | Concurrent webhooks and cash approvals: numbers with no gaps or duplicates. |
| ★ `BC-11 deposit money never appears in rent income` | integration | Across provider payments too. |
| ★ `BC-04 and BC-06 the tenant pays by MoMo and gets a receipt within a minute` | e2e | Open the pay link, pay through the fake, see the balance update, and receive the receipt within 60 seconds. |
| `BC-03 automatic matching only on metadata or an exact reference` | integration | Near-misses go to the queue; a person confirms each match. |
| `BC-12 the unmatched queue` | integration and e2e | Ranked suggestions; matching across books keeps each book balanced; P31 refund with approval. |
| `BC-09 the reminder ladder` | integration | Each step once, by the clock; stops when paid; consent and test contacts respected. |
| `P22 settlement` | integration | Gross, fees and net per book; a difference raises an exception (invariant 11). |
| `P21 chargeback` | integration | A reversal from current allocations, deducted from the next settlement, with a credit receipt. |
| `ADR-008 settlement account changes` | integration | Two people, 24 hours before use, the owner alerted, the number encrypted and masked. |
| `BC-02 failover` | integration | The second fake takes the charge only when configured; otherwise the page offers manual instructions and an incident is raised. |
| `BC-02 the Paystack adapter` | contract | Initialise, charge, verify, list, settlements, subaccounts, refunds and the signature, on recorded responses; the optional sandbox smoke test. |
| `NFR-PERF size budgets` | CI | The pay page, the sign page and the Expo web first load are each under 1 MB. |
| `TL-01 and BC-04 the tenant app's money screens` | Jest and e2e | Balance, paid-until, pay, history, receipts and the offline cache. |
| `NFR-SEC payments isolation` | integration | New tables pass M1's isolation and coverage tests; the webhook system path returns ids only. |

## 7. New dependencies

The Paystack adapter uses the existing HTTP client in `packages/integrations`.

- `@react-native-async-storage/async-storage` 2.2.0 in `apps/tenant`: the offline cache (4.10). The plan assumed it was part of the SDK; it is a separate package, the version Expo SDK 58 bundles, maintained under the React Native community and the standard choice for Expo apps.
- `@rent/domain` (a workspace package, not a new dependency) in `apps/links`: the pay page parses and formats amounts through `packages/domain/money`, as `CLAUDE.md` section 4 requires.

## 8. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Paystack behaves differently from its documentation for Ghana MoMo | Failed or stuck charges | Fixtures from the documentation, the sandbox smoke test, verify-pending and reconciliation. The MoMo provider codes (`mtn`, `vod`, `atl`) come only from third-party sources and are fixture assumptions until Paystack confirms them (OQ-01). |
| A redirected settlement account | Rent stolen | Two people, 24 hours, owner alerts, name check (ADR-008) |
| A lost webhook | A payment missing | Verify-pending every 5 minutes and daily reconciliation |
| Licensing (OQ-03) | Cannot go live | Live keys refused without the explicit switch |
| The second provider is not confirmed (OQ-02) | No failover at launch | Manual payment instructions and an incident alert |
| The Expo web build grows past 1 MB | The tenant app is slow on 3G | The CI budget, and trimming libphonenumber metadata (M1 open item) |

## 9. Deviations

1. **No second real provider** until OQ-02 (decision 1).
2. **A minimal management agreement** arrives here for settlement destinations; fees wait for M9 (decision 6).
3. **Pay links are per invoice;** the page shows the lease's whole amount due, because payments go to the oldest debt first.
4. **Many pay links per invoice** (review): the plan says one link per invoice, but tokens are stored only as hashes, so a link cannot be sent again. Each reminder, staff send and tenant-app request mints a new link for the same invoice. Each expires when its invoice is settled, or after 60 days.

## 10. Deferred

- Flutterwave (OQ-02); Paystack "Pay with Transfer" (OQ-08); MoMo wallet settlement (OQ-01).
- WhatsApp and push delivery of links, receipts and reminders (M6).
- Bank and MoMo statement import (Phase 2).
- Store release (once the developer accounts exist, OQ-25).
