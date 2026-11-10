# CLAUDE.md: Rent Management Platform

Rules for every Claude Code session in this repository. Read this file, then the PRD sections and plan your prompt names. If a prompt conflicts with a rule here, stop and ask.

## 1. What we are building

A Ghana-first platform for landlords and agencies to collect rent by MoMo, card and bank, control cash, keep owner ledgers, serve residential and commercial tenants over WhatsApp, SMS, email and an app, and issue legal notices that tenants open and e-sign.

- The PRD is `docs/prd.md`. Requirement IDs (PR-01, BC-07, …) are the unit of scope, tests and reporting.
- The build follows `BUILD_PLAYBOOK.md`, with the milestone sequence as amended in `docs/plans/roadmap.md`.
- Architecture: `docs/architecture.md`. Decisions: `docs/decisions/`. Open items: `docs/prd-issues.md` and `docs/open-questions.md`.
- The wedge is collection control. The ledger, payments and receipts get the most care: a wrong balance is worse than a missing feature.

## 2. How we work

- Plan before code. Each milestone starts by writing `docs/plans/<milestone>.md` (scope by requirement ID, design, tests, risks) and waiting for approval. Build only what is in scope; list anything else under "Deferred".
- End each milestone with a report at the bottom of its plan file: requirement IDs done, tests, deviations from the plan, open items.
- Never edit, skip or delete a test to make it pass. Explain the failure and fix the code. If you believe a test is wrong, say why and wait.
- Never invent a legal, tax or regulatory value. Add the question to `docs/open-questions.md`, use a rules-table placeholder marked `unverified`, and continue (section 7).
- Name tests after the requirement they prove, for example `describe('BC-07 allocation', …)`. The M11 traceability table is built from these names.
- Prefer boring, well-maintained libraries. Each new dependency gets one line of justification in the plan.
- When unsure, choose the option that is easier to reverse and record it in the plan.

## 3. Stack and repository layout

Decided in ADR-001, amended by ADR-012 (shared server package), ADR-013 (local object storage) and ADR-014 (API contracts). Changing any of it needs a new ADR.

- TypeScript (strict) everywhere. Node.js 24 LTS, pnpm workspaces, Turborepo.
- API and worker: NestJS. Web: Next.js (App Router). Tenant app: Expo SDK 58, building iOS (16.4 and above), Android and web from one codebase (ADR-010, OQ-26).
- PostgreSQL 17 or later, Drizzle ORM with SQL migrations for RLS policies, triggers and functions.
- Jobs: pg-boss with a transactional outbox (ADR-005). Auth: Better Auth (ADR-011). Files: S3-compatible storage (SeaweedFS locally, ADR-013; AWS S3 in production).
- Tests: Vitest, fast-check and Playwright; Jest with React Native Testing Library in the Expo app.

```
apps/
  api/             NestJS HTTP API, webhooks, OpenAPI
  worker/          NestJS standalone: jobs, outbox relay, schedulers, PDF rendering
  web/             Next.js: landlord and manager app, platform admin console
  links/           Next.js: no-login secure pages (pay, sign lease, sign notice, renewal offer, artisan job sheet)
  tenant/          Expo: tenant app for iOS, Android and web
  fake-providers/  local fakes for payments, WhatsApp, SMS, email, push, identity and address lookup
packages/
  domain/          pure business logic: money, posting rules, allocation, paid-until, tax, dates, state machines
  db/              Drizzle schema, SQL migrations, company-scoped transaction helper
  server/          NestJS modules shared by api and worker: core, identity, audit, rules, policy, approvals, companies… (ADR-012)
  integrations/    provider interfaces, adapters and fakes
  contracts/       zod schemas and the typed API client shared by web, links and tenant
  documents/       templates for leases, notices, receipts and statements; fingerprinting
  config/          shared tsconfig, ESLint and Prettier
infra/             infrastructure as code (added when we deploy)
docs/              PRD, architecture, ADRs, plans, runbooks
```

- `packages/domain` performs no I/O and imports nothing from `apps/*`, `db`, `integrations` or any provider SDK. Business rules live there and are tested without a database.
- One NestJS module per PRD module (module map in `docs/architecture.md`). Modules use each other's exported services or domain events, never each other's tables.

## 4. Money and the ledger

Money errors are the worst bugs this product can have. Reasoning: ADR-003 and ADR-004. Posting rules: `docs/architecture.md`, section 5.

Money
- Amounts are integer pesewas (GH₵1 = 100 pesewas) held in the `Money` type from `packages/domain/money`. Database columns are `bigint` with a `currency` column (`GHS` for now).
- Never use `float`, `real`, `double precision` or `numeric` for money. Never use `parseFloat`, `toFixed` or `Math.round` on amounts outside `packages/domain/money`.
- Rates are integer basis points (8% = 800). Rounding happens only in `packages/domain/money`: half up to the pesewa, once per calculated line. Splitting a total uses largest remainder, so the parts always add up exactly.
- API payloads carry integer minor units in fields ending `Minor` (for example `amountDueMinor`). Format for display only at the edge (`GH₵1,500.00`).

Ledger
- Double-entry. A journal entry has two or more lines. Each line has a book, an account, a signed amount (debit positive, credit negative) and dimensions (property, unit, lease, tenant, invoice line, payment, collector). Every entry sums to zero within each book; a deferred database constraint checks it at commit.
- Books: one per owner; one company book per company (unmatched receipts in the MVP, agency accounts in Phase 2); the platform's own book for subscriptions (M10). Rent never touches the platform book (decision D1).
- Append-only. Triggers and grants reject UPDATE and DELETE on journal entries and lines. A mistake is corrected by a reversal that negates the original and references it, followed by a correct entry.
- One posting function per business event in `packages/domain/ledger` (event in, lines out). The `LedgerModule` posting service is the only code that inserts journal rows. It writes them in the same transaction as the business record, with an idempotency key per entry (for example `payment:<id>:receipt`).
- Rent and service charge are income in the month they cover. Charge periods are monthly, anchored on the lease start, whatever the billing cycle. A daily job accrues every started line not yet accrued; each line draws first on its own advance allocations, then on surplus, first in first out by payment. Rent invoices are billing documents and post nothing themselves (AR-01, AR-03).
- Payments settle the oldest debt first; withholding is pinned to the lines it was withheld on; whatever is left stays as the payment's surplus in 2010 (BC-07). Every allocation records its source (payment, deposit, withholding, credit note, write-off).
- A payment reversal is built from the current state of the payment's allocations, never by mirroring the original entry (P21).
- Security deposits sit in their own liability account and never pass through income (BC-11).
- Every balance a user sees (amount due, paid-until, unearned rent, deposit held, arrears) is derived from the ledger and sub-ledgers. None is stored as an editable field.
- Entries and allocations carry a value date (when it happened) and an accounting date (the period it is reported in). A period locks when its owner statement is issued. Anything recorded later keeps its true value date but takes an accounting date in the open period. Statements select by accounting date, which keeps regenerated statements identical (AC-04).
- Nightly checks assert that receivables equal their sub-ledger per invoice line, and prepayments and deposits per lease, and alert on any difference.

## 5. Multi-tenancy and access control

- Every company-scoped table has `company_id NOT NULL`, Row Level Security enabled and forced, and a policy on `current_setting('app.company_id')`. The application connects as a role that does not own the tables and has no `BYPASSRLS`.
- Foreign keys between company-scoped tables include `company_id`, so a row can never reference another company's row.
- The `db` helper sets company context per transaction with `set_config(…, true)` for every request and every job. Never use session-level `SET`. A query outside a company-scoped transaction is a bug.
- Jobs carry `company_id` in their payload and run through the same helper. Cross-company work (schedulers, webhook intake, platform admin) uses the narrow system paths in ADR-002, never a BYPASSRLS application role.
- All authorization goes through the single `PolicyService` (`can(actor, action, resource)`). No role checks anywhere else; a lint rule enforces this. Owner, property and tenant scope inside a company are applied by the policy layer and covered by tests (AD-02; a caretaker sees only assigned properties).
- Two-person rules (notices to quit, refunds, write-offs, cash receipts, settlement account changes) go through the approvals engine. The initiator can never approve; the database enforces it. A company with a single user follows the cooling-off rule in OQ-29.
- Tenants sign in as people: one phone, possibly with several landlords. A landlord never sees what a tenant holds with another landlord (TL-12).

## 6. Audit, evidence and immutability

- The audit log is append-only and hash-chained per company: each event stores the previous event's hash. A nightly job verifies every chain; a daily job anchors each chain head in write-once storage.
- Audited: financial records, lease and notice changes, role and permission changes, sign-ins, ID number reveals, support access and approvals. Database triggers capture row changes, taking actor and request id from transaction settings; services add semantic events (`notice.opened`, `id_number.revealed`).
- A permission change records who made it, when, and the before and after values (AD-07).
- These are immutable once created: journal lines, payments, allocations, receipts, issued notices, sent messages, signatures, signed documents and audit events. A correction is a new record that references the old one (a new notice, a reversal, a credit receipt). No delete exists for them, for staff or for platform admins.
- Evidence timestamps come from the server, in UTC. Never trust a client clock.

## 7. Legal, tax and compliance values

Law and tax rates change; code should not have to (TX-08).

- Every legal, tax or regulatory value comes from the rules table: country, key, value, effective from and to, source, verification status (`verified`, `from_prd`, `unverified`) and who verified it. Never hard-code one in application code.
- Calculations read rules as of the business date and record the rule version they used, so past receipts, notices and reports never change when a rule does.
- A new value is a new row with its own effective date. Existing rule rows are never edited.
- An `unverified` value that affects a legal outcome shows a visible warning to staff where it is used (for example in the notice composer).
- Seed values for Ghana (M1):

| Key | Value | Status | Source |
| --- | --- | --- | --- |
| `rent_tax.rate.residential` | 800 bps | from_prd | TX-01; GRA rent income tax page |
| `rent_tax.rate.commercial` | 1500 bps | from_prd | TX-01 |
| `rent_tax.due_days_after_receipt` | 30 | from_prd | TX-02 |
| `rent_tax.alert_days` | 21, 28 | from_prd | TX-02 |
| `rent_tax.base` | rent received, including advances | unverified | D9; tax adviser to confirm |
| `rent_tax.rounding` | half up, per receipt | unverified | tax adviser to confirm |
| `rent_tax.includes_service_charge` | true | unverified | Act 896 definition of rent; tax adviser to confirm |
| `withholding_tax.rate.*` | same as rent tax, by band | unverified | TX-04; tax adviser to confirm |
| `vat.commercial_rent` | 1500 bps VAT + 250 NHIL + 250 GETFund | unverified | Act 1151; GRA guidance AG/26/001; tax adviser to confirm |
| `advance_rent.max_months.monthly_or_shorter` | 1 | unverified | Act 220 s.25(5), all premises; counsel to confirm |
| `advance_rent.max_months.over_six_months` | 6 | unverified | Act 220 s.25(5), all premises; AR-05; counsel to confirm |
| `rent_control.registration_days` | 14 | unverified | PNDCL 138 s.4; counsel to confirm |
| `notice_to_quit.statutory_min_days.*` | null | unverified | D7; Act 220 sets none (research); counsel must confirm |
| `data_retention.financial_and_notices` | 6 years | unverified | Act 915 s.27; counsel to confirm |
| `data_retention.other.*` | null | unverified | Act 843 s.24; counsel must supply |

- Product settings that are not law live in company settings with the PRD defaults: rent reminders at −7, 0, +3, +7 and +14 days (BC-09); notice reminders at 24 hours, 72 hours, 5 days and 7 days (PRD section 8); renewal reminders at 90, 60 and 30 days (TL-09).
- `advance_rent_policy` is a company setting: `off` (default, founder decision OQ-28), `warn` or `block`. Under `off`, an advance over the cap is recorded like any other and nothing warns or flags it; months paid ahead are still computed, so turning on `warn` needs no data change. Under `warn`, it is flagged on the lease and in compliance reports. Under `block`, it is refused. The product never describes an advance as compliant.
- Notice periods (D7): until counsel verifies a statutory minimum, the earliest effective date uses the lease's contractual notice period and the composer warns that the statutory minimum is unverified. Notices to quit stay disabled for a company until its admin records an acknowledgement of that risk (OQ-16), and each one needs two-person approval.
- A notice to quit never ends a tenancy by itself: possession needs a court or Rent Control order (Act 220 s.17). The product never supports lockouts, utility cut-offs or other pressure on a tenant to leave (s.27).

## 8. Integrations: payments, messaging and providers

- Provider SDKs and HTTP calls live only in `packages/integrations` adapters, behind interfaces. Every adapter has a fake, used in tests and by `apps/fake-providers`.
- Settlement (D1): rent settles directly into the landlord's or agency's account through provider subaccounts or splits. The platform never holds rent. Every provider used for rent, the failover included, must support this (ADR-008).
- Providers (D2): Paystack first, settling to landlords' bank accounts; MoMo wallet destinations only once Paystack confirms them in writing (OQ-01). The second provider is chosen only after it is confirmed against D1. Flutterwave is the candidate; Hubtel cannot carry rent (OQ-02).
- No live rent collection until counsel's written opinion on Bank of Ghana licensing (Act 987) is in hand (OQ-03).
- Inbound webhooks: store the raw request in `webhook_inbox` (unique on provider and event id), verify the signature, return 2xx, then process in a job. Never post money from a webhook body alone: call the provider's verify endpoint and compare amount, currency, status and reference exactly.
- Outbound side effects (messages, provider calls, PDF rendering) go through the transactional outbox. Never call a provider inside a database transaction.
- Every job and handler is idempotent (keys in the job catalogue, `docs/architecture.md`) and retried with backoff. Failures go to a dead-letter queue and raise an alert.
- Daily reconciliation compares provider transactions and settlements with our records. Missing payments are processed through the normal path; anything unexplained is flagged for a person.
- Channels: WhatsApp (Meta Cloud API), SMS gateway, email, and Expo push for tenant app users. Outside WhatsApp's 24-hour window, only approved templates are sent.
- Consent (CM-09): a business-initiated message goes out on a channel only if the contact has consent recorded for that channel. One-time codes the person asked for are exempt. For legal notices, the lease's electronic-service clause is the consent; without it, service is physical. STOP and other opt-outs are honoured on every channel.
- Messages are never edited or deleted. Delivery status and cost are recorded per message.
- Inbound messages are matched to tenants by E.164 phone number; unknown numbers go to triage. Inbound media is copied to our storage at once.

## 9. Secure links, one-time codes and e-signature

- A secure link carries a random 256-bit token; only its SHA-256 hash is stored. Each token serves one recipient and one purpose, expires according to that purpose (a notice link only after the notice period ends, LN-02), and is rate-limited.
- Secure pages live in `apps/links`. They are server-rendered, carry no staff cookies, use a strict CSP, stay under 1 MB and work on 3G and a 5-inch screen.
- One-time codes: 6 digits, stored hashed, valid for 10 minutes, at most 5 attempts. Sends are rate-limited per link, phone and IP. Codes go only to the phone (or, failing that, the email) on record, never to one typed on the page.
- One e-signature engine serves leases, notices, move-in reports and renewal offers (ADR-007). A document is frozen before anyone signs: template version plus data snapshot, rendered to PDF, fingerprinted with SHA-256 and stored write-once. Signers see that exact document.
- Signing records the typed or drawn signature, the consent text, the server timestamp, the verified phone, IP, user agent and the document hash. When the last required signer is done, a certificate page is appended, the final PDF is fingerprinted and stored write-once, and both hashes go into the audit chain.
- Notice pages say plainly that signing acknowledges receipt, not agreement. An unsigned notice is never blocked; the ladder escalates to physical service (PRD section 8).

## 10. Personal data and security

- Data Protection Act 2012 (Act 843): collect only what a requirement needs, record consent where the PRD requires it, and keep retention configurable (values unverified, section 7).
- Field-level encryption (AES-256-GCM with envelope keys from KMS) protects Ghana Card and passport numbers and bank and MoMo account numbers. Values are masked by default. Revealing one needs a permission and a reason, and is audited. Equality lookups use a keyed hash (blind index).
- Never request, photograph, scan or store an image of a Ghana Card. Identity checks are real-time biometric matches against NIA records through the identity provider (NIA, L.I. 2523; counsel to confirm its scope, OQ-39).
- Never log phone numbers, emails, ID numbers, one-time codes, tokens, signatures or full request bodies. The logger redacts them, and a test proves it.
- Secrets live in the secrets manager, never in the repository. Commit `.env.example` only.
- Owners, agency admins, managers, accountants, advisers and platform admins sign in with a password plus TOTP. Tenants and caretakers sign in with a phone one-time code. Sessions time out and can be revoked from the device list (AD-06).
- Uploads go straight to storage through short-lived presigned URLs, with type and size limits. Documents are served through short-lived links issued after a policy check.
- A caretaker cannot see owner statements, other properties or tenant ID numbers (PRD section 15).

## 11. Time, dates and localisation

- Store instants as `timestamptz` in UTC. Store business dates (due dates, rent periods, effective dates) as `date` in the company's time zone, `Africa/Accra` by default. Show the time zone wherever a time appears (DO-04).
- Business date arithmetic goes through `packages/domain/dates` only, never raw `Date` arithmetic.
- Rent periods are monthly and anchored on the lease start date (the 15th to the 14th, for example), whatever the billing cycle. Only a short final period is prorated, by days.
- Phone numbers are E.164 (`+233…`). Country, currency, ID types, address format and tax rules come from configuration, so another West African market needs no code fork.

## 12. Testing

- Unit tests for everything in `packages/domain`. Property-based tests (fast-check) for money, posting, allocation, paid-until and advance rent.
- Integration tests run against real PostgreSQL in Docker with RLS on. Never mock the database in ledger, RLS, audit or approvals tests.
- End-to-end tests: Playwright for `web` and `links`. The fake provider server stands in for every external service.
- Required wherever a milestone touches them: cross-company isolation, idempotent replay, gap-free receipt numbers under concurrency, and log redaction.
- Expo app: Jest and React Native Testing Library for components and flows.

## 13. Commands

Confirmed in M1. Run them from the repository root with Node 24 and Corepack's pnpm. The README has first-time setup, ports and the demo accounts.

```
pnpm install
pnpm services:up      # PostgreSQL, SeaweedFS, Mailpit and fake-providers in Docker
pnpm dev              # services, then api, worker, web, links and the tenant app
pnpm db:migrate       # SQL migrations and the job-queue schema, as the owner role
pnpm db:seed          # Accra demo dataset (companies, users and the property register); local databases only
pnpm test             # unit and integration (real PostgreSQL with RLS)
pnpm test:unit
pnpm test:e2e         # Playwright for web, links and the tenant web build; needs the stack running
pnpm lint && pnpm typecheck
pnpm format:check
pnpm db:backup        # pg_dump to ./backups; pnpm db:restore <dump> [database]
pnpm rules:add        # add a rules-table row (see packages/server/scripts/rules-add.ts)
pnpm platform:bootstrap  # new deployment: platform company, its book, first platform admin's invite (M10)
```

## 14. Demo dataset (Accra)

`pnpm db:seed` loads fictional data that exercises every MVP flow. Every name, phone number and ID number is fake, every contact is flagged as a test contact, and only fake providers are configured.

- Companies: an agency managing two owners (one lives in London, time zone `Europe/London`) and a self-managing individual landlord.
- Properties: a compound house in Legon (`ACC-LEG`, 12 rooms: chamber and hall, single rooms), an East Legon block of 8 flats (1 to 3 bedrooms), a mixed-use building in Osu (`ACC-OSU`, shops on the ground floor, offices above) and a gated-estate house in Tema.
- Tenancies: a monthly payer; a one-year advance; a two-year residential advance (over the 6-month cap; flagged only when a company sets `advance_rent_policy` to `warn`); a commercial company tenant that withholds tax; a tenant 45 days in arrears; a tenant 95 days in arrears; a lease expiring in 60 days; a partial payment; an overpayment held as credit; deposits held.
- Units: one vacant, one under repair, one not lettable.
- Users: agency admin, two managers, an accountant, two caretakers (each assigned to one property), owner users, a read-only adviser and a platform admin.
- Unit codes follow the PRD pattern `ACC-LEG-B2-04`: area, property, block, unit.

## 15. Decisions in force

| # | Decision | Status |
| --- | --- | --- |
| D1 | Rent settles directly to the landlord or agency through provider subaccounts or splits; the platform never holds rent | Confirmed 2026-10-28 |
| D2 | Paystack first; the second provider must also settle directly | Default; provider confirmation pending (OQ-01, OQ-02) |
| D3 | TypeScript, NestJS, Next.js, PostgreSQL | Confirmed 2026-10-28 |
| D4 | Tenant app in Expo (iOS, Android, web) plus WhatsApp; no-login pages stay in `apps/links` | Confirmed 2026-10-28; replaces the playbook's PWA default |
| D5 | Hosting region | ADR-009 (proposed, decided by a latency test) |
| D6 | Over-cap advance rent: recorded without warning for now (`advance_rent_policy = off`); `warn` and `block` stay available | Decided 2026-10-28 by the founder, and re-confirmed after the legal research (OQ-28) |
| D7 | Statutory notice periods stay unverified until counsel confirms | Default |
| D8 | A unit is billable for a month if it had an active lease on any day of that month | Decided 2026-10-28 by the founder |
| D9 | Rent tax on rent received, including advances | Default; tax adviser to confirm |

Product decisions taken on 2026-10-28 are recorded in `docs/open-questions.md`. They cover provider fees, single-user approvals, notices to quit, tenant login, the management fee base, the app publisher, subscription terms, Rent Control tracking and commercial landlords in the pilot.
