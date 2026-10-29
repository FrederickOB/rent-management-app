# ADR-003: Ledger design

- **Status:** Accepted, 2026-10-28
- **Details:** `docs/architecture.md`, sections 4 to 6 (accounts, posting rules P01 to P33, allocation, accrual, paid-until)
- **Reviewed:** an independent review on 2026-10-28 found eight defects in the first draft (payment reversals, per-line accrual draw, paid-until with service charge, statement dates, early termination, matching after settlement, invariants). All are corrected in the rules and decisions below.

## Context

Collection control is the wedge, and the ledger is what every report, statement and receipt rests on. The PRD needs a double-entry ledger per owner and property (AC-01), unearned rent tracked as a liability (AR-03), advances spread month by month (AR-01), deposits never mixed with income (BC-11), and owner statements that regenerate identically for any past month (AC-04). Under D1 the platform never holds rent, so the ledger records the owner's money wherever it sits: with a provider, in a caretaker's hand, with the agent or in the owner's account.

## Decision

- **Books.** Owner books (one per owner), a company book per company (unmatched receipts in the MVP, agency accounts in Phase 2) and the platform's own book (subscriptions). Every entry sums to zero within each book, checked by a deferred constraint trigger at commit.
- **Accounts and dimensions.** One global chart of accounts. Lines carry dimensions (property, unit, lease, invoice line, payment, collector, provider); there are no per-tenant accounts.
- **Journal.** `journal_entry` (rule, value date, accounting date, `posted_at`, unique idempotency key, unique `reverses_entry_id`) and `journal_line` (book, account, signed amount, dimensions including provider, settlement account and settlement).
- **Two dates.** The value date is when the event happened; the accounting date is the period it is reported in. They differ only when the value date falls in a locked period. Statements select by accounting date; bank reconciliation, ageing and tax due dates use the value date.
- **Append-only.** Triggers reject UPDATE and DELETE; the application role has neither privilege. Corrections are reversals plus new entries.
- **One write path.** The `LedgerModule` posting service runs pure posting functions from `packages/domain/ledger` and inserts under `SET LOCAL ROLE ledger_writer`, the only role with INSERT on journal tables. A CI check flags any other code that writes them.
- **Accrual by month.** Rent and service charge are income in the month they cover. Charge periods are monthly, anchored on the lease start date, whatever the billing cycle. A daily job accrues every started line not yet accrued, one transaction per lease. Each line draws on its own advance allocations and then on surplus, first in first out by payment, so one charge never consumes another's prepayment. Rent invoices are billing documents and post nothing.
- **Allocations.** Payments settle the oldest debt first; withholding is pinned to the lines it was withheld on. Every allocation records its source (payment, deposit, withholding, credit note, write-off) and carries both dates. Whatever a payment does not allocate stays as its surplus in 2010.
- **Payment reversals** are built from the current state of the payment's allocations (1100 for started lines, 2010 for the rest), not by mirroring the original entry.
- **Sub-ledgers.** Invoice lines and allocations are the receivables sub-ledger. A nightly check proves 1100 equals its sub-ledger per invoice line, and 2010 and 2100 per lease.
- **Period locks.** Issuing an owner statement locks that company and month. Anything recorded later keeps its true value date but takes an accounting date in the open period.
- **Balances** are aggregated on demand with indexes led by `(company_id, book_id, account_code)`. Monthly balance snapshots come later if needed.

## Consequences

- The unearned-rent liability (AR-03) is an exact account balance; paid-until and arrears are derived, never typed.
- Statements regenerate identically because posted history never changes and locked periods take no new entries.
- One accrual entry per lease per period: about 60,000 entries a year for a 5,000-unit agency, well within PostgreSQL's comfort zone.
- For a multi-month invoice, the contractual amount overdue (from invoice lines) can exceed the earned receivable (1100) until the later months start. Reports label these "overdue invoices" and "earned and unpaid" so accountants are not surprised.
- "Invoice raised" has no ledger effect. This is deliberate and documented in P01.

## Alternatives considered

- **Receivable at invoice, deferred income for future months.** The unearned liability would then mix paid and unpaid amounts, so AR-03 would need side calculations.
- **Cash-basis ledger.** Simpler, but it cannot meet AR-01 or AR-03.
- **External ledger engine** (TigerBeetle, Formance and similar). Strong guarantees, but extra infrastructure and a second source of truth for an MVP. Reconsider at much larger scale.

## Revisit when

- Agency books arrive with client money accounting (AC-06, Phase 2).
- Balance queries exceed the performance budget at month end (add snapshots).
- The tax adviser's answers (OQ-17 to OQ-19) change when tax is recognised.
