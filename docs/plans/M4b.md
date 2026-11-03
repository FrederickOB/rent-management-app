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

None expected: the Paystack adapter uses the existing HTTP client in `packages/integrations`, and the app cache uses Expo's AsyncStorage, which is part of the SDK.

## 8. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Paystack behaves differently from its documentation for Ghana MoMo | Failed or stuck charges | Fixtures from the documentation, the sandbox smoke test, verify-pending and reconciliation |
| A redirected settlement account | Rent stolen | Two people, 24 hours, owner alerts, name check (ADR-008) |
| A lost webhook | A payment missing | Verify-pending every 5 minutes and daily reconciliation |
| Licensing (OQ-03) | Cannot go live | Live keys refused without the explicit switch |
| The second provider is not confirmed (OQ-02) | No failover at launch | Manual payment instructions and an incident alert |
| The Expo web build grows past 1 MB | The tenant app is slow on 3G | The CI budget, and trimming libphonenumber metadata (M1 open item) |

## 9. Deviations

1. **No second real provider** until OQ-02 (decision 1).
2. **A minimal management agreement** arrives here for settlement destinations; fees wait for M9 (decision 6).
3. **Pay links are per invoice;** the page shows the lease's whole amount due, because payments go to the oldest debt first.

## 10. Deferred

- Flutterwave (OQ-02); Paystack "Pay with Transfer" (OQ-08); MoMo wallet settlement (OQ-01).
- WhatsApp and push delivery of links, receipts and reminders (M6).
- Bank and MoMo statement import (Phase 2).
- Store release (once the developer accounts exist, OQ-25).
