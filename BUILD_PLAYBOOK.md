# Claude Code Build Playbook: Rent Management Platform

Prepared from the PRD dated 26 October 2026. Use this with `CLAUDE.md`.

## Why this is a set of prompts and not one prompt

A single "build this whole PRD" prompt fails in a predictable way. The PRD has about 150 requirements across 14 modules. Claude Code works inside a finite context window, so a mega-prompt produces a broad, shallow scaffold: screens that look finished, a ledger that does not balance, webhooks that drop payments, and notices that can be edited after issue. Those are exactly the failures that would sink this product with a landlord or before Rent Control.

What works is three layers:

1. **`CLAUDE.md`** at the repository root. Claude Code loads it automatically in every session. It carries the rules that must never be broken: integer money, an append-only double-entry ledger, Row Level Security, hash-chained audit, legal values in configuration, provider adapters, secure links.
2. **`docs/prd.md`**, the PRD itself, so every session can read the exact requirement IDs and acceptance criteria.
3. **A sequence of milestone prompts** (below). Each one is scoped to a set of requirement IDs, asks for a plan before code, names the tests that must exist, defines "done", and ends with a report. You review between milestones.

The sequence follows the PRD's own logic: the register first, then money, then the channels and notices that sit on top of money. Collection control is the wedge, so the ledger and payments get the most engineering care.

## One-time setup

1. Create an empty Git repository and open it in Claude Code.
2. Put `CLAUDE.md` at the repository root.
3. Export the PRD from the Claude Doc as Markdown and save it as `docs/prd.md`. The release plan diagram in section 18 does not survive export, so paste the text block below in its place.
4. Work through "Decisions to confirm" below. Where you disagree with a default, change `CLAUDE.md` before Prompt 0.
5. Start a fresh Claude Code session for each milestone (or run `/clear` between milestones). Context from milestone 3 is noise in milestone 7, and the plan files carry what matters forward.
6. Run planning prompts in plan mode (Shift+Tab in Claude Code) so nothing is written until you approve the plan.

**Release plan text to paste into `docs/prd.md` section 18**

```text
Phase 1 (MVP), "Collect, record, notify": property register; tenants, leases and e-sign;
billing, MoMo and receipts; advance rent engine; legal notices and reminders; WhatsApp and
unified inbox; rent tax tracker; core dashboards.

Gate 1, pilot proven: legal opinion on e-notices; 95% of payments auto-matched; 95%
collection rate in pilot.

Phase 2, "Protect and report": maintenance and inspections; utilities and service charge;
owner ledgers and statements; commercial tenant portal; caretaker field app; diaspora owner
view; compliance dashboard.

Gate 2, ready to scale: 70% weekly active managers; messaging costs recovered; commercial
demand confirmed.

Phase 3, "Grow and scale": vacancy and leasing; portal syndication; USSD channel;
local-language messages; fit-out, parking, visitors; direct debit payments.

Note: where this diagram and the requirement tables disagree, see docs/prd-issues.md.
```

## Decisions to confirm before Prompt 0

These are the choices that are expensive to reverse once code exists. Defaults are already written into `CLAUDE.md`.

| # | Decision | Default in CLAUDE.md | Why it matters |
| --- | --- | --- | --- |
| D1 | Does rent money pass through the platform, or settle straight to the landlord or agency? | Settles direct through provider subaccounts or splits; platform never holds rent | Holding client money likely needs a Bank of Ghana licence or a licensed partner structure. Direct settlement removes that and simplifies reconciliation. This is the single biggest architectural fork. |
| D2 | Payment providers | Paystack primary, Hubtel second | Your earlier notes lean to Paystack. Confirm Paystack supports subaccount settlement for Ghanaian MoMo at rent volumes, and the reference field length MoMo allows. |
| D3 | Tech stack | TypeScript, NestJS, Next.js, PostgreSQL | If your team is stronger in another stack (for example Laravel or Django), change it now. A stack your team can maintain beats a stack Claude prefers. |
| D4 | Tenant mobile app in MVP | Mobile-first PWA plus WhatsApp; native apps later | The PRD screen inventory says "tenant mobile app" for MVP. A PWA meets the 1 MB and 3G budgets, avoids app store delays and covers Android 8+. Native adds months. |
| D5 | Hosting region | ADR to choose AWS af-south-1 or an EU region | Act 843 and latency. Cape Town is closer; some services launch later there. |
| D6 | Advance rent policy | Warn, not block | Open in the PRD. Built as a switch either way. |
| D7 | Statutory notice periods | Placeholders marked unverified; composer shows a warning | Needs a Ghanaian property lawyer before Gate 1. Do not let Claude invent these. |
| D8 | Subscription occupancy rule | A unit is billable for a month if it had an active lease on any day of that month | PB-02 does not say. "Occupied on the 1st" is easy to game by ending and restarting leases around the 1st. |
| D9 | Rent tax basis on advance rent | Tax computed on cash received, including advances, per TX-01 | Confirm with a tax adviser whether GRA expects tax on the advance at receipt or as it is earned. |

## Issues found in the PRD

Fix these in the PRD, or accept the stated assumption. The kickoff prompt tells Claude to copy them into `docs/prd-issues.md`.

1. **Release plan contradicts the requirement tables.** The diagram puts maintenance, inspections, owner ledgers and statements in Phase 2. The tables mark MI-01 to MI-04, MI-06, MI-10, MI-11 and AC-01 to AC-05 as MVP, and the MVP screen inventory includes the maintenance board, inspections, owner statements and expenses. *Assumption: the tables and screen inventory win.* They have to: CM-04 (MVP) turns WhatsApp repair messages into maintenance tickets, TL-11 (MVP) needs move-out inspections, and AC-01 (MVP) is the ledger everything else posts to.
2. **TL-08 depends on MI-10.** The move-in condition report is an inspection. The milestones below build the inspection engine before completing move-in and move-out.
3. **Push alerts without a native app.** MI acceptance requires emergency alerts "by push and SMS". In the MVP that means web push through the PWA where the browser supports it, plus SMS. Confirm that is acceptable.
4. **PB-02 snapshot rule is undefined** (see D8).
5. **Rent tax on advance rent** (see D9).
6. **Caretaker tasks before the caretaker app.** The notice ladder (MVP) creates a caretaker task at day 5, but the field app is P2. The PRD already says these are handled in the manager web app until then; the milestones follow that.
7. **"Delivered" status for notices (LN-03)** depends on provider delivery receipts. WhatsApp and most SMS gateways provide them; email delivery is weaker. Status should record which channel confirmed delivery.

## Prompt 0: Architecture, data model and plan

Run in plan mode. Review the output carefully; most later quality comes from this step.

```text
You are a principal engineer with 10+ years building payments, ledgers and multi-tenant
SaaS. You are leading the build of the product described in docs/prd.md under the rules in
CLAUDE.md.

Read CLAUDE.md and all of docs/prd.md before writing anything. Do not write application code
in this step.

Produce these documents:

1. docs/prd-issues.md
   Copy the "Issues found in the PRD" list from BUILD_PLAYBOOK.md, then add any further
   contradictions, gaps or ambiguities you find, each with the requirement IDs involved and
   a recommended resolution.

2. docs/architecture.md
   - System context diagram (Mermaid): users, apps, API, worker, Postgres, object storage,
     and each external provider.
   - Module map: one NestJS module per PRD module, with the requirement IDs each owns and
     the dependencies between modules. No circular dependencies.
   - MVP data model as a Mermaid ER diagram, with notes on keys, company_id scoping, RLS,
     soft versus hard deletes, and which tables are append-only.
   - Chart of accounts for the ledger, and the posting rules (debit and credit lines) for:
     invoice raised, MoMo payment confirmed, partial payment, overpayment to credit, cash
     receipt approved, advance rent received, monthly recognition of advance rent, security
     deposit received, deposit deduction at move-out, deposit refund, early-termination
     refund of unearned rent, management fee, expense, owner remittance, rent tax accrued,
     rent tax paid to GRA, withholding tax deducted by a corporate tenant, WHT certificate
     confirmed, reversal.
   - State machines (Mermaid) for: unit status, lease, invoice, payment, approval request,
     notice (all LN-03 statuses), maintenance job, conversation, subscription.
   - Payment flow sequence diagram: tenant opens pay link, provider charge, webhook, verify
     call, ledger posting, allocation, receipt sent, with failure and retry paths and the
     daily reconciliation job.
   - Secure link and e-signature sequence diagram.
   - Job catalogue: every scheduled or async job, its trigger, idempotency key and retry
     policy.
   - Security model: authentication per user type (staff: password plus TOTP; tenants: phone
     one-time code; secure links: token plus one-time code), the policy layer, RLS approach,
     field encryption, secrets.

3. docs/decisions/ ADRs (short, one page each) for: stack, multi-tenancy and RLS, ledger
   design, money representation and rounding, job queue and outbox, PDF rendering and
   document fingerprinting, e-signature built in-house, payment settlement model (D1),
   hosting region, tenant PWA instead of native app in MVP.

4. docs/plans/roadmap.md
   Confirm or improve the milestone sequence in BUILD_PLAYBOOK.md (M1 to M11). For each
   milestone list requirement IDs, dependencies and the riskiest part. Flag any MVP
   requirement that no milestone covers.

5. docs/open-questions.md
   Every question that blocks or shapes the build, numbered OQ-01 onward, each with your
   recommended default.

When finished, stop and give me a summary: the five riskiest design points, any place you
disagreed with CLAUDE.md and why, and the decisions you need from me.
```

## Milestone prompts

Use the same opening line for each: start a fresh session, paste the prompt. Each one plans first, then builds once you approve.

### M1: Foundation

```text
Milestone M1: Foundation. Read CLAUDE.md, docs/architecture.md, docs/decisions/ and
docs/plans/roadmap.md.

Scope: AD-01, AD-03, AD-05, AD-06, AD-07, TX-08 (rules engine), the NFRs for security,
audit, localisation and backup, and the platform skeleton every later milestone depends on.

First write docs/plans/M1.md and wait for my approval. Then build:

- Monorepo per CLAUDE.md layout; strict TypeScript; lint, format and typecheck; Turborepo
  pipelines; GitHub Actions CI running lint, typecheck, unit, integration and e2e tests.
- Docker Compose for Postgres, MinIO, Mailpit and a fake provider server.
- Companies (landlord or agency) with branding (AD-01); users; roles (AD-03); the single
  policy service; RLS on every company-scoped table with a session variable set per request
  and per job.
- Auth: staff sign-in with password and TOTP two-factor, session timeout, device list with
  remote sign-out (AD-06). Tenant sign-in by phone one-time code. Use a maintained auth
  library chosen by ADR; do not hand-roll cryptography.
- Generic approvals engine for two-person approval (AD-05). Initiator can never approve.
- Hash-chained append-only audit log (AD-07) with a search API by user, record and date,
  and a nightly chain verification job.
- Rules tables with country and effective dates (TX-08), seeded per CLAUDE.md section 7.
- pg-boss queue with a transactional outbox; job base class with idempotency and retry.
- Integration interfaces and fakes for payments, WhatsApp, SMS, email, identity
  verification and address lookup. Real adapters come in later milestones.
- Object storage service with a write-once bucket for signed documents.
- PDF rendering worker and a document fingerprint utility (SHA-256 over final bytes).
- Field-level encryption utility and log redaction, with tests.
- Seed script for the Accra demo dataset described in CLAUDE.md.
- Update the Commands section of CLAUDE.md.

Tests that must exist:
- RLS blocks cross-company reads even when application scoping is bypassed.
- Audit chain detects an altered row.
- Approval cannot be granted by its initiator.
- Ledger-style append-only trigger rejects UPDATE and DELETE (use a test table now; the real
  ledger arrives in M4).
- Logs never contain a phone number, OTP, token or ID number.

Done when CI is green, `pnpm dev` runs all apps, a staff user can sign in with 2FA, and the
M1 report is written.
```

### M2: Portfolio and property register

```text
Milestone M2: Portfolio and property register. Read CLAUDE.md, PRD sections 5 and 21,
docs/architecture.md and docs/plans/M1.md.

Scope: PR-01, PR-02, PR-03, PR-04, PR-05, PR-06, PR-08, PR-09, AD-02, PB-01. Design the
schema so PR-07 (joint ownership splits) and PR-10 (asset register) can be added without
migration pain.

Plan first in docs/plans/M2.md, then build:

- Portfolio, property, block and unit hierarchy (PR-01) with unit types from PR-02 and each
  unit's billing band (PB-01). Map unit types to bands per the PRD section 21 table; allow
  override with an audited reason.
- Unit codes generated per the PRD pattern (for example ACC-LEG-B2-04): unique, stable,
  never reused, and suitable for payment references. Document the format and collision rule.
- Bulk unit creation by type and count, then edit one by one (user story: 12-room compound
  house in under 10 minutes).
- GhanaPost GPS address, region, district, MMDA and map pin (PR-03). Validate the GPS
  format; lookup through the address adapter, with manual entry if the API is unavailable.
- Documents and photos per property (PR-04), visible only to permitted users, opening on
  mobile.
- ECG and Ghana Water meter numbers and meter type per unit (PR-05); amenities (PR-09).
- Unit status with full history (PR-06). Status "vacant" and "occupied" are derived from
  leases once M3 lands (PB-09); for now enforce that only the lease module may set them.
- Excel import of properties and units (PR-08): template download, validation report with
  row-level errors, dry run before commit, idempotent re-import.
- Agency multi-owner setup: owners see only their properties (AD-02).
- Screens: portfolio list with filters by owner, location, type and status and live counts;
  property detail; unit detail.

Tests: every ID in scope; import of a malformed sheet; an owner in an agency cannot see
another owner's property; a caretaker sees only assigned properties.

Done when the acceptance criteria in PRD section 5 pass as automated tests and the M2 report
is written.
```

### M3: Tenants, leases and e-signature

```text
Milestone M3: Tenants, leases and the e-signature engine. Read CLAUDE.md sections 9 and 10,
PRD sections 6 and 17, and the M2 plan.

Scope: TL-01, TL-02, TL-03, TL-04, TL-05, TL-06, TL-07, TL-09, PB-09. TL-08 and TL-11 finish
in M8 once inspections exist; leave clean hooks for them.

Plan first in docs/plans/M3.md, then build:

- Tenant profiles for individuals and companies (TL-01, TL-04), guarantor, next of kin and
  employer reference (TL-03). Phone numbers normalised to E.164 (+233).
- Ghana Card capture and verification through the identity adapter; passport for foreign
  nationals (TL-02). ID numbers encrypted and masked; reveal is permissioned and audited.
- Lease templates (residential, commercial, short fixed-term) with editable clauses held as
  versioned structured content, not free HTML (TL-05).
- Lease terms (TL-06): start, end, rent, cycle, deposit, service charge, escalation schedule
  as effective-dated steps, break clauses. Validate dates and amounts in packages/domain.
- Generic e-signature engine used by leases now and notices in M7: signing requests per
  signer, secure links, one-time code, typed or drawn signature, final PDF with certificate
  page and SHA-256 fingerprint, write-once storage (TL-07). Lease activates only when every
  required signature is in.
- Occupancy derived from leases (PB-09): a unit is occupied whenever it has an active lease
  and cannot be set vacant while one is active. Every change logged.
- Advance rent compliance check on lease save (AR-05 flag) using the rules table and
  `advance_rent_policy`.
- Renewal reminders at 90, 60 and 30 days, configurable, plus an expiring-leases list
  (TL-09). Renewal offer goes out as a signable link.
- Screens: tenant list, tenant profile and timeline, lease builder, lease detail, secure
  signing page (under 1 MB, works on 3G).

Tests: lease does not activate with a missing signature; signed PDF hash matches stored hash;
altering one byte of a stored PDF is detected; expired or reused signing link is rejected;
OTP brute force is rate-limited; unit cannot be set vacant with an active lease.

Done when PRD section 6 acceptance criteria in scope pass and the M3 report is written.
```

### M4: Ledger, billing and payments

This is the milestone customers pay for. Give it the most review time.

```text
Milestone M4: Ledger, billing, payments and receipts. Read CLAUDE.md section 4 and 8 twice,
PRD sections 7 and 12, the chart of accounts and posting rules in docs/architecture.md, and
the payment ADRs.

Scope: AC-01, BC-01, BC-02, BC-03, BC-04, BC-05, BC-06, BC-07, BC-08, BC-09, BC-11, BC-12.

Plan first in docs/plans/M4.md. The plan must restate every posting rule you will implement
and the allocation algorithm in plain words. Wait for my approval.

Then build:

- Double-entry ledger per CLAUDE.md section 4: journal entries and lines, zero-sum enforced
  in the database, append-only, reversals only. Posting service in packages/domain; one
  posting function per business event; no other code writes journal lines.
- Invoice generation from lease terms per cycle (BC-01): a daily idempotent job keyed on
  (lease, period) that also applies escalation steps by effective date.
- Unique payment reference per tenant lease (BC-03) derived from the unit code with a check
  digit; respect the shortest reference length among supported MoMo networks.
- Payment links (BC-04): secure page showing amount due, allowing part payment, sent by
  WhatsApp, SMS and email through the channel interfaces (real channels arrive in M6; use
  fakes until then). The link carries the invoice and lease identifiers as provider
  metadata so matching is exact.
- Real Paystack adapter and a second provider adapter (BC-02), with failover on link
  creation. Webhook inbox, signature verification, verify call before posting, idempotent
  processing, daily reconciliation against provider transaction lists.
- Matching (BC-03, BC-12): auto-match only on exact reference or link metadata. Everything
  else goes to the unmatched queue with ranked suggestions (amount, phone, date, history).
  A person confirms each suggested match.
- Allocation (BC-07): oldest debt first across invoice lines; overpayment held as tenant
  credit; partial payments supported.
- Cash and cheque receipts (BC-05): receiver name, photo of receipt book or cheque, pending
  until a different user approves through the approvals engine; only then posted.
- Security deposits in their own liability accounts (BC-11), never in rent income.
- Digital receipt within 1 minute of confirmed payment (BC-06): event-driven, numbered
  sequentially per company with no gaps, PDF plus message. Record a latency metric.
- Arrears ageing 0-30, 31-60, 61-90, 90+ by tenant, property and owner (BC-08).
- Reminder ladder (BC-09): 7 days before due, due date, 3, 7 and 14 days overdue, each step
  configurable per company; stop as soon as the invoice is paid.
- Screens: invoices; payments and unmatched queue; arrears; receipts. Tenant PWA: home
  (balance, paid-until, next due), pay, payment history and receipts.

Tests that must exist:
- Property-based (fast-check): for any sequence of invoices and payments, the ledger sums to
  zero, no allocation exceeds the amount due, total allocated plus credit equals total paid,
  and replaying the same webhook twice changes nothing.
- A webhook with a tampered amount or bad signature posts nothing.
- A payment confirmed during a provider outage is picked up by reconciliation.
- Cash receipt cannot be approved by the person who recorded it.
- Receipt numbering has no gaps under concurrent payments.
- Deposit money never appears in rent income.
- End-to-end: tenant opens pay link, pays by MoMo (fake provider), balance updates, receipt
  arrives, within 1 minute.

Done when every BC acceptance criterion in scope passes, the auto-match rate on the seed
dataset is measured and reported, and the M4 report is written. Before finishing, spawn a
separate review subagent that has not seen your reasoning to audit the posting rules and
allocation code against PRD sections 7 and 12; include its findings in the report.
```

### M5: Advance rent engine, rent tax and withholding tax

```text
Milestone M5: Advance rent, rent tax and withholding tax. Read CLAUDE.md sections 4 and 7,
PRD sections 7 (advance rent engine) and 12 (tax and compliance), and the M4 plan.

Scope: AR-01, AR-02, AR-03, AR-04, AR-05, AR-06, TX-01, TX-02, TX-03, TX-04, TX-08.

Plan first in docs/plans/M5.md. State the recognition rule, the paid-until rule for partial
months, and the rent tax basis (cash received, including advances, per open decision D9).

Then build:

- Advance rent (AR-01, AR-03): a lump sum posts to unearned rent; a monthly recognition job
  moves each month's rent from unearned to income. Mid-cycle lease starts and escalations
  during an advance period are handled explicitly.
- Paid-until date (AR-02) shown to tenant, landlord and manager, computed in
  packages/domain from the ledger, never stored as a hand-edited field.
- Early termination refund (AR-04): unearned balance less approved deductions, raised as an
  approval request, posted as a refund on approval.
- Over-cap flag (AR-05) on the lease page and in compliance reports; behaviour follows
  `advance_rent_policy`.
- Renewal prompt when paid-until is 90 days away (AR-06).
- Rent tax per receipt (TX-01) at the rate for the unit's band from the rules table; rent
  tax payable account; due date of receipt date plus 30 days with alerts at 21 and 28 days
  (TX-02); GRA payment records with attachments and a per-owner rent tax report (TX-03).
- Withholding tax (TX-04): corporate tenant pays net; WHT receivable raised against the
  invoice; cleared when the certificate is uploaded and a landlord user confirms.

Tests that must exist:
- Property-based: recognised plus unearned always equals advance received; paid-until never
  moves backwards except on a reversal.
- A two-year advance shows the correct paid-until date and unearned balance every month.
- The rent tax on an owner report equals the sum of tax on each receipt in the period.
- Changing a tax rate with a future effective date does not alter past receipts or reports.
- A statement regenerated for a past month matches the original exactly.

Done when PRD acceptance criteria for AR and TX in scope pass and the M5 report is written,
including a list of every value still awaiting legal or tax confirmation.
```

### M6: WhatsApp, SMS, email and the unified inbox

```text
Milestone M6: Messaging and the unified inbox. Read CLAUDE.md section 8, PRD section 9, and
the M4 and M5 plans.

Scope: CM-01, CM-02, CM-03, CM-05, CM-06, CM-07, CM-08, CM-09, CM-10. CM-04 (repair to
ticket) creates a ticket stub now and is completed in M8. Record per-message cost now
(CM-12 is P2).

Plan first in docs/plans/M6.md, then build:

- Real adapters: Meta WhatsApp Cloud API, an SMS gateway and an email provider with inbound
  parsing. Support a WhatsApp number per company and a shared platform number for small
  landlords (CM-01).
- Inbound webhook to conversation: match by E.164 phone to tenant and unit; unknown numbers
  to a triage queue (CM-02). Download media to our storage immediately.
- One thread per tenant across WhatsApp, SMS, email and in-app (CM-05). Email replies thread
  back through a tokenised reply-to address (CM-10).
- Menu bot as an explicit state machine: balance and paid-until, receipt or statement as
  PDF, pay link, report a repair, talk to a person (CM-03). Handover is immediate and
  visible to staff.
- 24-hour window logic and a template registry with Meta approval status (CM-07). Templates
  for reminders, receipts, renewal offers and notice links.
- Assignment, tags, response time targets and overdue alerts (CM-06).
- Broadcast to a property, block or group with throttling and delivery stats (CM-08).
- Consent: opt-in captured at onboarding with timestamp and source; STOP and opt-out
  honoured on every channel; SMS fallback when WhatsApp is unavailable (CM-09).
- Wire the BC-09 rent reminders, TL-09 renewal reminders and BC-06 receipts to real channels.
- Live inbox updates by server-sent events so a tenant reply appears within 10 seconds.

Tests: a reply appears on the record within 10 seconds; a message cannot be deleted or
edited after sending; no message goes to a tenant without opt-in; outside the 24-hour window
only templates are sent; duplicate inbound webhooks create one message.

Done when PRD section 9 acceptance criteria pass against the fake provider and against a
sandbox number, and the M6 report is written.
```

### M7: Legal notices with e-sign acknowledgement

```text
Milestone M7: Legal notices. Read CLAUDE.md sections 6, 7 and 9, PRD section 8 in full, and
the M3 and M6 plans. Reuse the M3 e-signature engine; do not build a second one.

Scope: LN-01, LN-02, LN-03, LN-04, LN-05, LN-07, LN-09, and the in-app caretaker task for
CF-06 (manager web app until the field app ships).

Plan first in docs/plans/M7.md with the notice state machine and the effective date
calculation, then build:

- Templates for every notice type listed in PRD section 8 with mandatory fields (LN-01).
- Earliest lawful effective date computed from the rules table, the lease type and the
  issue date. Issue is blocked if the chosen date is earlier. While the rule is unverified,
  the composer shows a prominent warning.
- Approval by a user with notice authority; two-person approval for notices to quit.
- Issue: one secure link per recipient, sent by WhatsApp, SMS and email at the same moment;
  full notice stored as a fingerprinted PDF (LN-02). Link expires only after the notice
  period ends.
- Tracking: sent, delivered (with the confirming channel), opened, signed, reminded,
  escalated, served, closed, each timestamped (LN-03).
- Signed acknowledgement PDF with signature, verified phone, device details and fingerprint
  (LN-04). Page states that signing acknowledges receipt, not agreement.
- Reminder ladder at 24 hours, 72 hours, 5 days and 7 days, configurable per notice type,
  with pause and cancel (LN-05). Day 5 creates a caretaker task and alerts the manager.
  Day 7 generates the physical service pack: printable notice and service affidavit
  template. Manager records how, when and by whom it was served.
- Commercial tenants: notice to every authorised signatory; one signature acknowledges for
  the company (LN-07).
- Closure outcomes: complied, paid, vacated, disputed, referred to Rent Control or court.
- Notices dashboard by status and days outstanding (LN-09); every status change on the
  tenant timeline and in the audit log.

Tests: a notice to quit with a date before the lawful minimum cannot be issued; an issued
notice cannot be edited and a correction references the original; an unsigned notice still
progresses to escalation; a signed PDF verifies against its stored hash; the ladder stops
when the notice is signed.

Done when PRD section 8 acceptance criteria pass and the M7 report is written.
```

### M8: Maintenance, inspections, move-in and move-out

```text
Milestone M8: Maintenance, inspections, move-in and move-out. Read PRD sections 6 and 10,
and the M3, M4, M5 and M6 plans.

Scope: MI-01, MI-02, MI-03, MI-04, MI-06, MI-10, MI-11, CM-04 (complete), TL-08, TL-11.

Plan first in docs/plans/M8.md, then build:

- Repair requests from tenant PWA, WhatsApp, manager or caretaker with photos, video or
  voice note (MI-01); WhatsApp repair messages create tickets with media attached (CM-04).
- Priority levels with target response and completion times (MI-02); categories (MI-03).
- Emergency requests alert the manager and caretaker immediately by SMS and by web push
  where available.
- Assignment to staff or an external artisan, who receives the job by WhatsApp link and a
  no-login job sheet (MI-04).
- A job cannot close without at least one after photo and a completion note; the tenant
  confirms completion (MI-06). Owners see each job, its cost and photos from their view.
- Inspection engine: routine, move-in and move-out, room-by-room checklists with
  timestamped photos (MI-10).
- Move-in condition report signed by both parties through the e-signature engine (TL-08).
- Move-out (TL-11): notice, inspection, deposit deductions linked to findings with photo
  evidence (MI-11), final statement, refund through the approvals engine, ledger postings
  per the architecture document, and unit returns to vacant through PB-09.

Tests: job closure blocked without an after photo; deposit deduction cannot exceed the
deposit held; refund requires a second approver; final statement balances to zero.

Done when PRD section 10 acceptance criteria in scope pass and the M8 report is written.
```

### M9: Owner reporting, expenses and dashboards

```text
Milestone M9: Owner reporting and dashboards. Read PRD sections 12 and 14 (Module 13), and
the M4 and M5 plans.

Scope: AC-02, AC-03, AC-04, AC-05, DA-01, DA-02, DA-06, plus the rent tax report and
compliance list screens from the MVP screen inventory.

Plan first in docs/plans/M9.md, then build:

- Management fee posted automatically as a percentage of collections or fixed per unit
  (AC-02), configured per owner agreement with effective dates.
- Expenses with receipts attached, categorised and allocated to property or unit (AC-03).
- Monthly owner statement PDF: income, expenses, fees, net remittance, arrears, occupancy
  (AC-04). Generated from as-of ledger queries; regenerating any past month gives identical
  figures. Times shown in the owner's time zone.
- Owner remittance tracking (AC-05).
- Portfolio dashboard: occupancy, collection rate, arrears, rent roll, paid-until coverage
  (DA-01); lease expiry pipeline for 3, 6 and 12 months (DA-02); filters by owner,
  property, region and unit type with PDF and Excel export (DA-06).
- Instrument the Gate 1 metrics from PRD section 19: collection rate, digital payment share,
  auto-match rate, time to receipt, notice acknowledgement within 7 days.

Tests: statement regeneration is byte-for-byte identical in figures; dashboard figures
reconcile to the ledger; an owner never sees another owner's figures.

Done when PRD section 12 acceptance criteria pass and the M9 report is written.
```

### M10: Subscription billing and platform admin

```text
Milestone M10: Subscription engine and platform admin console. Read PRD section 21 in full,
AD-08 and AD-10.

Scope: AD-08, AD-10, PB-01, PB-02, PB-03, PB-04, PB-05, PB-07, PB-08, PB-10, PB-11.

Plan first in docs/plans/M10.md, then build:

- Rate card per tier and billing band with effective dates (PB-03). Rates are not set yet;
  seed obvious placeholders and make them editable in the admin console.
- Monthly snapshot of billable units by band, derived from leases (PB-02, PB-09), stored for
  audit and dispute. Use the occupancy rule from decision D8.
- Bill = sum over bands of billable units times rate, never below the tier minimum. Mixed-use
  buildings billed unit by unit.
- Tier entitlements (PB-04): locked features show what upgrading unlocks. Starter, Growth
  and Portfolio contents as in PRD section 21.
- Proration on upgrade, downgrade from next cycle, annual prepayment, discount codes (PB-05);
  free trial or guided onboarding with configurable length (PB-08).
- Subscription invoices and receipts in cedis, paid by MoMo or card, automatic monthly
  renewal until cancelled; cancellation at end of paid cycle with data export offered
  (PB-07, PB-10).
- Unpaid subscription tracked as arrears with reminders (PB-11). Read-only mode after a
  grace period is behind a config switch (open decision). Tenant payment links, receipts and
  notices are never switched off.
- Platform admin console (AD-10): companies, plans and billing, support access only with
  the customer's recorded consent (audited), usage and messaging costs, system health.

Tests: a unit with an active lease is always billed; vacant units are never billed; a
company in subscription arrears can still receive tenant payments and send receipts and
notices; support access without consent is refused.

Done when PB acceptance criteria pass and the M10 report is written.
```

### M11: Hardening and pilot readiness (Gate 1)

```text
Milestone M11: Hardening and pilot readiness. Read CLAUDE.md, PRD sections 4, 19 and 20,
and every milestone report in docs/plans/.

Plan first in docs/plans/M11.md, then:

- Security review: run a separate review subagent over authentication, authorisation, RLS,
  secure links, webhooks, file uploads and field encryption against the OWASP ASVS level 2
  checklist. Fix every high and medium finding. Produce docs/security-review.md.
- Performance: Lighthouse CI on tenant and secure link pages with a 3G profile and the 1 MB
  budget; load test an agency with 5,000 units, 50 staff and month-end payment peaks;
  fix every budget breach.
- Resilience: provider outage drill (primary payment provider down), webhook replay drill,
  queue backlog drill.
- Backups: daily backups, 30-day point-in-time recovery, and a scripted restore drill with
  a written runbook (NFR backup).
- Data protection: Act 843 checklist, retention configuration, consent records, data
  processing records, breach response runbook.
- Accessibility pass on tenant pages (WCAG 2.2 AA where practical).
- Pilot tooling: Excel onboarding of a real landlord's portfolio, tenant opening balances
  and existing advances as opening ledger entries, and a pilot metrics view for Gate 1.
- docs/runbooks/ for payments reconciliation, failed webhooks, notice escalation, support
  access and incident response.

Done when every MVP requirement ID has at least one passing test (produce a traceability
table: requirement ID, test files, status), all Gate 1 metrics are instrumented, and the
open legal and tax items are listed for sign-off.
```

## After every milestone: independent review prompt

Run this in a new session before you accept a milestone. A reviewer that did not write the code finds what the author cannot.

```text
Act as an independent senior reviewer. You did not write this code. Read CLAUDE.md,
docs/plans/<milestone>.md, the relevant PRD sections, and the diff for this milestone.

Check and report, with file and line references:
1. Every requirement ID in scope: implemented, tested, or missing.
2. Any breach of CLAUDE.md rules: floats or unrounded money, ledger writes outside the
   posting service, mutable financial or audit records, missing RLS, role checks outside the
   policy layer, provider SDKs outside adapters, invented legal values, personal data in
   logs.
3. Tests that pass without testing the behaviour they claim (weak assertions, mocked-away
   logic, skipped cases).
4. Concurrency and idempotency gaps: double webhooks, double clicks, job retries, race
   conditions on receipts and balances.
5. Security issues in anything reachable without login.

Do not fix anything. Give me a prioritised list: must fix before merge, should fix, note.
```

## When a session goes wrong

- **It drifts from the plan:** "Stop. Re-read CLAUDE.md and docs/plans/<milestone>.md. List what you have changed that is outside the plan, then revert or justify each item."
- **Tests are failing and it wants to change them:** "Do not edit any test. Explain why each failing test fails, then fix the code."
- **It is guessing a legal or tax value:** "That value is not in the PRD. Add it to docs/open-questions.md, use a config placeholder marked unverified, and continue."
- **The context is getting long:** finish the current task, make sure the plan file records progress, then start a new session with "Continue milestone <n> from docs/plans/<milestone>.md."

## What still needs people, not Claude Code

Claude Code can build all of this, but four things gate a real launch and sit outside the code: a Ghanaian property lawyer's opinion on electronic notices and notice periods (Gate 1 requires it), a tax adviser's confirmation of the rent tax basis and rounding, a signed agreement with the payment providers covering subaccount settlement, and Meta business verification for WhatsApp, which can take weeks. Start all four now so they are not on the critical path when M11 finishes.
