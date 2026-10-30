# M4a: Ledger core and billing

- **Status:** approved by the founder on 2026-10-30 with every recommendation in section 2. Being built: progress notes are in section 5.
- **Inputs:**
    - `BUILD_PLAYBOOK.md` (the M4 prompt, first half) and `docs/plans/roadmap.md` (the M4a row and prompt amendment);
    - `CLAUDE.md` sections 4 to 8 and 11;
    - PRD sections 7 and 12, and section 13 for CT-04;
    - `docs/architecture.md` sections 3.4, 4 (books and accounts), 5 (posting rules and invariants), 6 (allocation, accrual and paid-until), 7 (invoice and payment states) and 10 (jobs);
    - ADR-003 (ledger), ADR-004 (money), ADR-005 (jobs and outbox), ADR-008 (settlement);
    - prd-issues 10, 11, 15 to 17, 19, 23, 24, 35, 36 and 41;
    - OQ-05, OQ-17 to OQ-20, OQ-29;
    - the M2 report (deferred S5 and S8) and the M3 report.
- **Scope:**
    - AC-01, BC-01, BC-05, BC-07, BC-08, BC-11, AR-01, AR-02 and AR-03;
    - cash banking (P07, prd-issues 10), per-lease payment references (prd-issues 15), and VAT on commercial invoices (CT-04, P32);
    - posting rules P01 to P10, P21, P23, P24, P27, P28, P29 and P32.

    Money arrives in three ways: cash and cheques approved by a second person, transfers straight into an owner's or agency's account (recorded with proof), and a test harness standing in for payment providers. M4b connects Paystack.
- **Branch:** `m4a-ledger`, stacked on `m3-tenancy` (PR #3), which is stacked on `m2-register` (PR #2). Merging #2 and #3 first keeps the stack short; it is not required.

## 1. Done when

1. **PRD section 7's acceptance criteria in scope pass as automated tests:**
    - **A two-year advance.** The lease page shows the paid-until date and the remaining unearned rent in cedis. A test walks a two-year advance month by month and checks both every month.
    - **Billing and collection:**
        - invoices are generated from lease terms for each cycle, with escalation steps;
        - part payments and overpayments are handled, and credit is held;
        - payments settle the oldest debt first;
        - cash and cheques post only after a second person approves;
        - arrears are aged;
        - deposits never reach rent income.
2. **The roadmap's M4a tests pass** (★ in section 6).
3. **Every balance on screen comes from the ledger and its sub-ledgers:** amount due, paid-until, unearned rent, deposit held, credit, arrears and collectors' cash. The nightly sub-ledger check passes on the seed.
4. **Build checks:** CI is green, and an independent review of the posting rules, allocation and accrual has no open "must fix" item. The playbook asks for this review at the end of M4; I will run one here too, because these rules are the core.
5. **Report:** the M4a report is at the bottom of this file.

## 2. Decisions needed before I build

Approving the plan approves these recommendations, unless you say otherwise.

| # | Decision | Finding | Recommendation | Files changed on approval |
| --- | --- | --- | --- | --- |
| 1 | Where billing starts for a lease recorded on paper | **The problem:** a paper lease records a tenancy that may have started years ago (M3 decision 7). Billing from its start date would invoice every past month and show the tenant years in arrears.<br>**What exists:** opening balances (P25) bring past arrears and prepayments in with the pilot import, in M11. | **Each lease has a billing start date.**<br>• An e-signed lease bills from its start date.<br>• A paper lease bills from the first rent period that starts on or after the day it is recorded. Staff can choose an earlier period start to bring recent arrears in.<br>• Anything before that arrives with opening balances (P25, M11).<br>• A paper lease billed from a later date gets no deposit invoice: its deposit was paid before the platform, and arrives with opening balances too. | none |
| 2 | When invoices are raised, and what each one covers | **The PRD:** BC-01 says only "for each rent cycle". The ladder starts 7 days before the due date, so invoices must exist earlier (prd-issues 23). | **Timing:** 14 days before the due date, as a company setting.<br>**Grouping:**<br>• each invoice covers one billing cycle: 1, 3, 6 or 12 monthly charge periods;<br>• the first invoice covers the lease's initial advance, when it has one;<br>• the due date is the first day of the cycle.<br>**Deposits:** a deposit invoice is issued when the lease is signed, due on the start date.<br>**Holding over:** each month is invoiced as it starts. | none |
| 3 | Who approves corrections | `CLAUDE.md` requires two people for cash receipts, refunds and write-offs. P27 says credit notes need approval. Nothing says who approves a payment reversal, such as a bounced cheque or a wrong entry. | **Two-person approval for every financial correction:**<br>• payment reversals;<br>• credit notes;<br>• write-offs.<br>All go through the approvals engine, with the single-user rule of OQ-29. | none |
| 4 | VAT on commercial invoices (CT-04) | **Tax point:** the invoice or the payment, whichever comes first (P32). An advance paid before its invoices exist has no lines to carry the VAT.<br>**Order:** section 6 orders lines as deposit, rent, service charge, one-off; VAT lines have no place in that order. | **Advance payments:** for a VAT-registered owner's commercial lease, a payment that reaches beyond the invoices already issued issues the invoices it pays for at once, up to the lease end. The tax point is then the payment.<br>**Order:** VAT and levy lines come straight after the line they are charged on.<br>**Rates:** each rate applies to the line's net amount, as the seeded rules row reads. VAT on service charge is a new unverified rules row, on by default. The tax adviser confirms both (OQ-20). | rules (new row); `docs/open-questions.md` (OQ-20 sub-questions) |
| 5 | A property with more than one owner | **M2:** ownership rows carry shares, so a property can have two owners at 50% each.<br>**The ledger:** it keeps one book per owner, and joint ownership (PR-07) is P2. prd-issues 24 says a joint owner is one owner entity whose statements split by share. | **A property posts to its single owner's book.** A property with more than one owner on a date is not billed, and the lease page says why: record joint owners as one owner (PR-07 splits statements later). | none |
| 6 | Changing a property's owner | **M2's risk table:** from M4a, a change of owner is refused once the property has ledger entries, until a transfer flow exists.<br>**M2's deferred S5:** there is no same-day correction for a property filed under the wrong owner. | **Same-day correction:** before a property has any ledger entry, its ownership can be corrected on the same date (S5).<br>**After the first entry:** owner changes are refused until a transfer flow exists (Phase 2). | none |
| 7 | Cash recorded by a landlord who works alone | **The rule:** `CLAUDE.md` puts cash receipts under two-person approval. A company with one user follows OQ-29: a nominated approver, otherwise self-confirmation by TOTP after 24 hours.<br>**The consequence:** a sole landlord who records cash waits 24 hours before it posts and the receipt is issued. | **Keep the rule.** The payment shows as "recorded, waiting for confirmation" until then. A nominated second approver, such as a family member, removes the wait. | none |
| 8 | Payment references (BC-03, OQ-05) | prd-issues 15 proposes a short reference per lease, opaque and not derived from the unit code. The narration limits of MoMo networks and banks are unconfirmed (OQ-05). | **Format:** 7 characters: 6 Crockford base32 characters plus a Luhn mod 32 check character from the same alphabet, so a reference is letters and digits only.<br>**Scope:** unique across the platform, so a typed reference identifies its company.<br>**Issued** when the lease is signed. | none |

## 3. Scope by requirement ID

| ID | M4a delivers | Later |
| --- | --- | --- |
| AC-01 | **The ledger:** a double-entry ledger with one book per owner and one per company, and property, unit, lease, invoice line, payment and collector on every line.<br>**Rules:** zero-sum per book, append-only, reversals only, one posting service.<br>**Rules covered:** P01 to P10, P21, P23, P24, P27 to P29 and P32. | Fees (P14) and expenses (P15) with AC-02 and AC-03 (M9); rent tax (P17 to P20, M5); provider settlement (P22, M4b). |
| BC-01 | **Invoices** generated from lease terms for each cycle, by a daily job keyed on lease and cycle start. Escalation steps apply by effective date (they are already in the M3 schedule). Invoices are issued 14 days ahead and rendered as PDFs. | Sending invoices to tenants, with pay links, from the reminder ladder's first step (M4b). |
| BC-05 | **Cash and cheques** recorded with the receiver's name, a photo of the receipt-book page or the cheque, the payer and the date. Nothing posts until a second person approves.<br>**Banking:** cash banked or handed to the agent, with the slip photo and approval (P07).<br>**Undeposited cash** shown per collector. | Field app (CF-03, P2). |
| BC-07 | **Allocation:** oldest debt first; part payments; overpayments held as the payment's credit; withholding pinned to its lines (the hook for M5). Every allocation records its source. | Withholding itself (M5). |
| BC-08 | **Arrears ageing:** 0–30, 31–60, 61–90 and 90+ days from the due date, by tenant, property and owner, as of any date. | Dashboards (M9). |
| BC-11 | **Deposits** in their own liability account per lease, never in income. They are received against deposit lines and carried over to a renewal (P29). | Deductions and refunds at move-out (P11, P12, M8). |
| AR-01 | **Advances:** an advance is recorded as a prepayment and drawn month by month as each charge period starts (P02 and P09). | |
| AR-02 | **Paid-until:** derived from the ledger by the forward walk, never stored, and shown on the lease page and to owners. Partial cover shows as "plus GH₵X towards the month starting …". | Tenant app (M4b); renewal prompt (AR-06, M5). |
| AR-03 | **Unearned rent:** the rent share of the lease's prepayments, shown in cedis. | |
| P07 (prd-issues 10) | Recording cash banked, with second-person approval. | |
| BC-03 references (prd-issues 15) | **A payment reference per lease,** shown on invoices, receipts and the lease page. | Matching payments by reference (M4b). |
| CT-04 | **Commercial invoices for a VAT-registered owner:** VAT, NHIL and GETFund lines (P32), and invoices and receipts that show the tenant's company name and TIN. Rates come from the unverified rules row, with the warning staff see. | VAT returns (P33, M5). |
| Also | **Corrections:** payment reversals (P21), credit notes (P27) and write-offs (P24).<br>**Unmatched receipts:** transfers recorded before anyone knows the lease (P23, minimal list).<br>**Renewals** carry prepayments and deposits forward (P29).<br>**Period locks** and the two dates (statements arrive in M9).<br>**Idempotent requests** for every money write (M2 S8).<br>**Receipt numbers and PDFs** (the numbering half of BC-06). | The unmatched queue with suggestions (BC-12, M4b); sending receipts (BC-06, M4b). |

## 4. Design

### 4.1 Modules

- **`ledger` (layer 1):** books, the chart of accounts, journal entries and lines, the posting service, period locks and balance queries.
    - The posting service is the only code that inserts journal rows.
    - It runs the pure posting functions in `packages/domain/ledger`.
    - It writes under `SET LOCAL ROLE ledger_writer`, the only role with INSERT on the journal (ADR-003).
- **`billing` (layer 5):**
    - invoices, invoice lines and the accrual job;
    - payments and allocation;
    - cash records, direct receipts and cash banking;
    - corrections: reversals, credit notes and write-offs;
    - receipt numbers and PDFs;
    - arrears, paid-until and unearned rent;
    - payment references and the sub-ledger check.
- **Between tenancy and billing:** tenancy sits below billing, so it reports lease events through the outbox: `lease.signed`, `lease.activated`, `lease.ended` and `lease.cancelled`. Billing reacts to each one:
    - on signing, it issues the payment reference, the deposit invoice and the invoices already due;
    - when a lease ends, it cancels the invoice lines of periods that start after the end;
    - on a renewal, it carries prepayments and deposits over (P29).
- **Receipts:** the module map puts receipts in `payments` (M4b). The receipt number has to be taken in the posting transaction, which is billing's, so **billing owns the receipt record and its PDF**. Payments (M4b) and messaging deliver it.

### 4.2 Books, accounts and the journal

| Table | Kind | Holds |
| --- | --- | --- |
| `ledger_account` | Global, seeded, read-only | The chart in `docs/architecture.md` section 4: code, name, type, and the books it may appear in |
| `book` | Company-scoped | One per owner (made with the owner) and one per company. The platform book arrives with M10. |
| `journal_entry` | Append-only | Rule (P01…), value date, accounting date, `posted_at` (server time), idempotency key (unique per company), `reverses_entry_id` (unique), the business record it belongs to, and who caused it |
| `journal_line` | Append-only | Entry, book, account, signed amount (debit positive) and currency; dimensions: property, unit, lease, tenant, invoice line, payment, collector, provider, settlement account, settlement |
| `period_lock` | Append-only | Company and month, written when owner statements are issued (M9). M4a builds the rule and tests it with locks made directly. |

- **Enforced in the database:**
    - **Zero-sum:** a deferred constraint trigger checks at commit that every entry sums to zero within each book and has at least two lines.
    - **Accounts:** each account is allowed only in its kind of book; the currency is GHS.
    - **Append-only:** triggers and grants reject UPDATE and DELETE on both journal tables.
    - **Write access:** `rent_app` may SELECT; only `ledger_writer` may INSERT.
    - **Isolation:** forced RLS on company, with property and owner scope applied as in M2. Journal tables are kept from tenant sessions entirely.
    - **References:** foreign keys include `company_id`.
- **Enforced in CI:** a lint rule (`rent/ledger-writes`) fails any code outside `packages/server/src/ledger` that inserts into the journal tables.
- **Audit:** one semantic audit event per journal entry (`ledger.entry_posted`: rule, key, books and totals), not per line (M1 left this open). Business records (payments, allocations, cash records, credit notes) keep row-level audit.
- **Balances** are summed on demand, with indexes led by `(company_id, book_id, account_code)` and by lease.

### 4.3 The posting rules, in plain words

"The cash side" means wherever the money now sits:
- 1050, with a payment provider;
- 1060, in a collector's hand;
- 1010, in the owner's own account;
- 1070, held by the managing agent.

Every rule posts in the same transaction as its business record, with an idempotency key of `<rule>:<record id>`; accruals use the invoice line's id.

| Rule | In plain words |
| --- | --- |
| P01 Invoice raised | **Rent, service-charge and deposit lines post nothing:** an invoice is a bill, not income.<br>**One-off lines** (an agreed charge) post when issued: the tenant owes it (Dr 1100) and it is income (Cr 4200).<br>**VAT lines** post at their tax point (P32). |
| P02 Charge period starts | On the first day of each monthly charge period, that month's rent or service charge becomes income (Cr 4000 or 4100).<br>**What pays for it:**<br>• first, money the tenant already paid towards that exact line (its advance allocations);<br>• then any unapplied credit, oldest payment first;<br>• the rest becomes money owed (Dr 1100).<br>Both prepaid parts come out of prepayments (Dr 2010). The daily job catches up any day it missed, lease by lease, in period order, rent before service charge. |
| P03 Provider payment | The money is with the provider (Dr 1050). It is shared out by the allocation rules (4.5):<br>• started lines and one-off lines reduce what is owed (Cr 1100);<br>• deposit lines become deposits held (Cr 2100);<br>• lines whose period has not started, and anything left over, become prepayments (Cr 2010).<br>In M4a a test harness stands in for the provider; M4b makes it real. |
| P04 Part payment | As P03. The line stays partly owed. |
| P05 Overpayment | As P03. What is left over stays as that payment's credit in prepayments until a later period uses it (P02). |
| P06 Cash or cheque approved | As P03, but the money is in the collector's hand (Dr 1060, with the collector named). Nothing posts while the record waits for the second person. |
| P07 Cash banked | The collector no longer holds it (Cr 1060). It is in the owner's account (Dr 1010) or with the agent (Dr 1070). The slip photo and a second person's approval are required. |
| P08 Advance received | Any payment that covers periods not started yet. The covered part is a prepayment (Cr 2010). Months paid ahead are recorded; the AR-05 flag shows only under `warn` or `block` (OQ-28). |
| P09 Advance recognised | Not a separate entry: it is the prepayment part of P02. |
| P10 Deposit received | Money against a deposit line becomes a deposit held (Cr 2100), never income. |
| P21 Reversal | **(a) Correction:** an entry nothing has used since is reversed line for line, signs flipped.<br>**(b) Payment reversal** (bounced cheque, wrong entry; later, a chargeback):<br>• built from what the payment pays for now, not from its original entry;<br>• every current allocation is reversed: started lines are owed again (Dr 1100), unstarted lines and credit go back out of prepayments (Dr 2010), deposit lines out of deposits (Dr 2100);<br>• the cash side is credited where the money sits now.<br>The receipt stays, and a credit receipt is issued. A reversal is never itself reversed. |
| P23 Unmatched receipt | **On arrival:** money that arrives before anyone knows its lease waits in suspense (Cr 2090) in the book of whoever received it: the owner's book for the owner's account, the company book for the agency's.<br>**On matching:** when a person matches it, the suspense clears (Dr 2090) and the money is allocated as P03. A match from the company book into an owner's book moves the money between the books so each one balances. |
| P24 Write-off | Two people agree a debt will not be paid. It becomes an expense (Dr 5900) and stops being owed (Cr 1100). |
| P27 Credit note | A line was wrong or is cancelled.<br>• **Accrued and unpaid:** its income is reversed (Dr 4000 or 4100) and it is no longer owed (Cr 1100).<br>• **Accrued and paid:** the income is reversed, and the payment's money returns to its credit (Cr 2010).<br>• **Not yet accrued:** it is cancelled with no entry; any money allocated to it returns to credit.<br>Approval required (decision 3). |
| P28 Direct receipt | A transfer straight into the owner's account (Dr 1010) or the agency's (Dr 1070), recorded with proof and a second person's approval. It is allocated as P03, or held as unmatched (P23). |
| P29 Renewal carry-over | When a renewal starts, the old lease's prepayments and deposit move to the new lease within the owner's book. Debts stay on the old lease's invoices. Each payment keeps its place in the first-in, first-out order. |
| P32 VAT on a commercial invoice | **Who:** VAT-registered owners, commercial leases only; dwellings are exempt.<br>**When:** at the tax point (the invoice, or the payment if it comes first; decision 4), the tenant owes the VAT and levies (Dr 1100) and the owner owes them to GRA (Cr 2210).<br>**How:** each is rounded half up, once per line, with the rule version recorded. |

**Not in M4a:** P11 and P12 (deposits at move-out, M8), P13 (early termination, M5), P14 to P16 (fees, expenses and remittances, M9), P17 to P20 (rent tax and withholding, M5), P22 (provider settlement, M4b), P25 (opening balances, M11), P26 (subscriptions, M10), P30, P31 (M4b) and P33 (M5).

### 4.4 Invoices (BC-01)

- **Tables:**
    - **`invoice`:** number, lease, tenant, unit, property, owner's book, kind (cycle, deposit, one-off), issue and due dates, the period covered, and snapshots of the tenant's and owner's names and TINs for CT-04.
    - **`invoice_line`:** type, charge period, period dates, due date, amount, the line it is charged on (for VAT and levies), and the rule version for VAT.
    - **Status is derived**, never stored: issued, part paid, paid, voided or written off. "Overdue" is derived too.
- **The daily job** (`billing.generate-invoices`, 00:10):
    - It runs for every lease that is signed, active, ending or holding over.
    - For each billing cycle whose due date is within the company's lead days (14 by default), it issues one invoice with that cycle's rent and service-charge lines, taken from the M3 schedule, which already applies escalation steps.
    - The key is lease plus cycle start, so a rerun changes nothing.
- **Signing** issues the deposit invoice, then runs the same generation at once for any cycle already due.
- **Holding over:** M3 adds each held-over month to the schedule as it starts; it is invoiced that day.
- **When a lease ends:**
    - no period that starts after the end is invoiced;
    - lines already issued for those periods, and not yet started, are cancelled by a system credit note that names the lease's end. No income has been recognised on them, so nothing else posts, and their money returns to credit. (This closes M3's "schedule rows after an early move-out" item for billing.)
- **Who is billed:** only the billing start date onwards is invoiced (decision 1). A property with more than one owner is not invoiced (decision 5).
- **PDFs:** each invoice is rendered through the documents service: company branding, the tenant, the unit with its code, the payment reference and the lines; for CT-04, the names and TINs and the VAT.

### 4.5 Allocation (BC-07), in plain words

1. **Sources.** Money is allocated from:
    - payments (provider, cash, cheque, direct transfer and, later, opening balances);
    - deposits (M8);
    - withholding (M5);
    - credit notes;
    - write-offs.

    Each allocation row records its source, the line, the amount, a value date and an accounting date. A correction adds negative rows; nothing is updated.
2. **Order.** A payment pays the lease's open lines oldest debt first:
    - by due date;
    - then by type: deposit, then rent, then service charge, then one-off charges, with each VAT or levy line straight after the line it is charged on;
    - then by period start.

    A pay link for one invoice does not change the order. Withholding (M5) is pinned to the lines it was withheld on and skips the order.
3. **Accrue first.** Before it allocates, a payment accrues any started line of the lease that the daily job has not reached yet, so a line is always income before it is paid.
4. **Credit.** Anything left over is that payment's credit (its unallocated remainder), held in prepayments.
5. **Deposits first.** A deposit line exists from signing, so an early deposit always finds it and never becomes credit.
6. **Limits.** No line is ever allocated more than it owes. A payment's allocations, net of reversals, plus its credit always equal the payment.

### 4.6 Accrual and advance rent (AR-01, AR-03)

1. **Periods.** Charge periods are monthly, anchored on the lease start, whatever the billing cycle; an annual invoice bundles twelve of them.
2. **The daily job** (`billing.accrue-periods`, 00:20) takes, lease by lease, every rent and service-charge line whose period has started and has no P02 entry yet. It works in period order, rent before service charge, in one transaction per lease, so a missed day catches up.
3. **Each line** draws first on its own advance allocations, then on the lease's credit, first in, first out by payment (each draw is a new allocation row), and the rest becomes owed. P02 then posts.
4. **Unearned rent (AR-03)** is the rent share of the lease's prepayments (2010): the rent part of the advance allocations to lines not started yet, plus the credit the forward walk (4.7) would apply to future rent lines within the term.

### 4.7 Paid-until (AR-02), in plain words

1. **Walk** the lease's rent and service-charge lines in accrual order. A started line is covered when its allocations equal its amount. A future line is covered by its advance allocations plus the credit applied forward, in the same order P02 will use.
2. **Paid-until** is the last day of the last month whose lines are all covered, in an unbroken run from the billing start. If the next month is partly covered, the lease shows "plus GH₵X towards the month starting …" (prd-issues 17).
3. **Shown on** the lease page, the invoices and the receipts. It is computed in `packages/domain`, never stored, and moves backwards only through a reversal, a credit note or a change to the schedule (invariant 9).

### 4.8 Cash, cheques, direct transfers and banking

- **`cash_record` (BC-05):**
    - **Fields:** lease, payer, amount, date received, method (cash or cheque, with the cheque's number and bank), the collector who received it, and a photo of the receipt-book page or the cheque (presigned upload, type and size limits, as M2).
    - **Who records:** caretakers may record cash for their assigned properties.
    - **Approval:** the record opens an approval request (`payment.cash_receipt`). On approval, in the same transaction, the payment row is created, allocated and posted (P06), and the receipt number is taken. A rejection posts nothing.
- **`direct_receipt` (P28):**
    - **Fields:** a transfer straight into the owner's account or the agency's, with the date, amount, the sender's reference and a proof file (screenshot or statement line).
    - **No lease known:** it can be recorded without one, and is then held as unmatched (P23).
    - **Approval:** `payment.direct_receipt`.
- **`cash_banking` (P07):**
    - **Fields:** a collector's cash banked into the owner's account or handed to the agency, with the amount, the slip photo and the date.
    - **Limit:** it can never exceed what the collector holds.
    - **Approval:** `cash.banking`.
- **Collectors' cash:** each collector's undeposited cash comes from 1060 with the collector dimension, per owner book.
- **Idempotent requests:** every money write takes an `Idempotency-Key` header (4.15), so a retry on 3G never records the payment twice.

### 4.9 Corrections and unmatched receipts

- **Payment reversal (P21b):** `payment.reversal`, with the reason (bounced cheque, wrong entry, wrong lease) and two-person approval. It produces negative allocations, the entry, and a credit receipt. To move a payment to the right lease, reverse it and record it again.
- **Credit note (P27):** `invoice.credit_note`, for a whole line or part of one, with the reason and two-person approval. A system credit note, for the periods after a lease ends (4.4), needs no approval: it releases only lines whose income was never recognised.
- **Write-off (P24):** `invoice.write_off`, for started lines still owed, with two-person approval.
- **Unmatched receipts (P23):** M4a lists direct receipts with no lease, and a person matches one to a lease, which allocates it. M4b adds provider payments and ranked suggestions (BC-12).

### 4.10 Receipts and invoice numbers

- **One receipt per payment**, numbered in the same transaction that posts the payment: `RC-000123`, from a per-company counter row locked `FOR UPDATE`. A failed transaction rolls the number back with it, so there are no gaps.
- **A reversal** keeps the original receipt and gets a credit receipt with its own number.
- **Invoice numbers** (`INV-000123`) use the same mechanism, one counter per company.
- **PDFs:** each receipt is rendered through the documents service:
    - the allocations by line;
    - paid-until after the payment;
    - for cash, the receiver;
    - for CT-04, the names, the TINs and the VAT.

    Staff see and download it. M4b sends it to the tenant within a minute (BC-06).

### 4.11 Deposits (BC-11)

- **Where they sit:** in 2100 per lease, received only against deposit lines (P10). They never reach income.
- **Renewals:** carried to a renewal (P29). A renewal that asks for a deposit has its deposit line settled first from the carried deposit, and the tenant pays any difference.
- **Proved in tests:** a property test checks that no posting path moves deposit money into 4000 to 4300 (`★ deposits never reach income`).

### 4.12 Arrears ageing (BC-08)

- **What counts:** invoice lines past their due date with an amount outstanding, as of any accounting date (allocations up to that date).
- **Buckets:** 0–30, 31–60, 61–90 and 90+ days from the due date.
- **Grouped** by tenant, property and owner.
- **Labels:** following ADR-003's consequence, screens say "overdue invoices" for the contractual amount and "earned and unpaid" for 1100, so a multi-month invoice does not confuse anyone.

### 4.13 VAT on commercial invoices (CT-04, P32)

- **When:** for a lease whose use is commercial, on a property whose owner is VAT-registered (the M3 owner tax fields). Each rent line, and each service-charge line while `vat.applies_to_service_charge` is on, gets VAT, NHIL and GETFund lines.
- **Rates:** from `vat.commercial_rent`, as of the invoice date. Each is applied to the net amount and rounded half up once, with the rule version recorded.
- **Tax point:** the invoice, or the payment when it comes first (decision 4).
- **Unverified:** both rows are unverified, so the invoice screens show staff the warning (`CLAUDE.md` section 7). The rates, tax point, service charge, compounding, numbering and GRA's E-VAT invoicing are questions for the tax adviser (OQ-20).

### 4.14 Payment references (BC-03, prd-issues 15)

- **Format:** 7 characters: 6 Crockford base32 characters, then a Luhn mod 32 check character (decision 8). It catches every single-character slip and most swapped neighbours.
- **Uniqueness:** a global unique index, so a reference typed in a transfer finds its company through a narrow system function (M4b).
- **Issued** at signing, and shown next to the unit code on the lease page, invoices and receipts.

### 4.15 Period locks, the two dates, and idempotent requests

- **The two dates:** every entry and allocation has a value date (when it happened) and an accounting date (the period reported). They are equal unless the value date falls in a locked month; then the accounting date is the first open day. Statements (M9) select by accounting date; ageing and, later, tax due dates use the value date.
- **Idempotent requests (M2 S8):**
    - **Mechanism:** a stored `(company, key)` with a hash of the request and the response. A replay returns the same response; the same key with a different body is refused (422).
    - **Required on** money writes: cash records, direct receipts, banking, reversals, credit notes, write-offs and matches.
    - **Available to** any other write.

### 4.16 Sub-ledger check and invariants

- **`billing.subledger-check`** (nightly, 03:00) proves, per company:
    - 1100 equals the open amount of each started line (invariant 2);
    - 2010 equals each lease's advance allocations plus credit (invariant 3);
    - 2100 equals each lease's deposits received, less what they settled (invariant 4);
    - 1060 equals each collector's approved cash, less what was banked.

    A mismatch raises an alert with the line or lease. On the seed it must pass.
- **Property-based tests** cover invariants 1 to 5 and 7 to 9 (section 6).

### 4.17 Permissions

Every check goes through `PolicyService`, and the matrix test covers every new action.

| Action | Who |
| --- | --- |
| `billing.view` (invoices, payments, receipts, arrears, balances) | Owners (own company), agency admins, managers, accountants, advisers (read-only); client owners for their owners. Not caretakers, who see only their own cash records and balance. |
| `billing.manage` (request credit notes and write-offs, match receipts) | Agency admins, managers, accountants |
| `payment.record` (cash, cheque, direct receipt) | Owners, agency admins, managers, accountants; caretakers for cash and cheques on their assigned properties |
| `cash.bank` (record banking) | The same, for the collector's own cash, or anyone's for admins and accountants |
| Approve any money action | Owners, agency admins, managers and accountants, never the person who started it (database-enforced) |

### 4.18 API

Contract-first (ADR-014), with integer pesewas in `…Minor` fields:
- **Invoices:**
    - `GET /invoices` with filters;
    - `GET /invoices/:id` with its lines, allocations and status;
    - `GET /invoices/:id/document`;
    - `GET /leases/:id/billing` for the money summary: due, overdue, paid-until, unearned rent, deposit held, credit and the reference.
- **Payments and receipts:** `POST /cash-records`, `POST /direct-receipts` and `POST /cash-bankings`; `GET /payments` and `GET /payments/:id`; `GET /receipts/:id/document`; `GET /collectors/cash`.
- **Corrections and matching:** `POST /payments/:id/reversal-requests`, `POST /invoice-lines/:id/credit-notes`, `POST /invoice-lines/:id/write-offs`, `GET /unmatched-receipts` and `POST /unmatched-receipts/:id/match`.
- **Arrears:** `GET /arrears?asOf=…&by=tenant|property|owner`.

### 4.19 Screens (web)

- **Lease page:**
    - **money card:** due now, overdue, paid until (with partial cover), unearned rent, deposit held, credit and the payment reference;
    - its invoices and payments;
    - "Record a payment".
- **Invoices:** a list (status, property, owner, overdue) and a detail with lines, allocations, VAT and the PDF.
- **Payments:**
    - "Record cash or cheque" (photo from the phone camera) and "Record a transfer" (proof upload);
    - a payment's detail, with its allocations, receipt and reversal request.
- **Cash on hand:** each collector's undeposited cash, and "Record banking".
- **Unmatched receipts:** the minimal list with "Match to a lease".
- **Arrears:** ageing by tenant, property or owner, as of a date.
- **Receipts:** a list and the PDF.
- **Approvals:** the new action types show their summaries on the existing approvals screen.
- **Caretakers** (phone sign-in): record cash and see their own cash on hand.

Every screen has loading, empty and error states, and tables scroll sideways on a phone.

### 4.20 Jobs

| Job | Trigger | Idempotency key | Retries |
| --- | --- | --- | --- |
| `billing.generate-invoices` | daily 00:10, and on `lease.signed` | lease id + cycle start | 5 |
| `billing.accrue-periods` | daily 00:20, and before a payment allocates | invoice line id (the P02 key) | 5, alert |
| `billing.lease-events` | events: `lease.signed`, `lease.ended`, `lease.cancelled`, renewal started | event id | 5 |
| `billing.subledger-check` | nightly 03:00 | company + date | 3, alert on mismatch |
| `documents.render-pdf` | invoice or receipt issued (exists) | document id | 5 |

### 4.21 Seed

The seed extends the M3 paper leases with money that exercises every flow, all through the real services:

| Kind | Money |
| --- | --- |
| A monthly payer | Paid up, by cash approved by a manager |
| A one-year advance | One cash payment covering twelve months |
| A two-year advance | GH₵36,000 as a direct transfer; paid-until 24 months out, unearned rent falling monthly |
| The commercial company tenant | A VAT-registered owner, so its invoices carry VAT lines |
| 45 and 95 days in arrears | Billing starts months back; partly paid, then nothing |
| A part payment and an overpayment | The second held as credit |
| Deposits held | On several leases |
| A caretaker's cash | One record banked, one still in hand |
| One transfer with no lease | In the unmatched list |

## 5. Build order

1. **Domain:**
    - posting functions and entry checks;
    - allocation, accrual, the forward walk (paid-until and unearned) and ageing;
    - invoice cycles and VAT lines;
    - payment references.

    Property-based tests first, against an in-memory model of the books.
2. **Database:**
    - the journal tables with their triggers, grants and zero-sum check;
    - books, invoices, lines, allocations, payments, receipts and counters;
    - cash records, direct receipts and banking;
    - period locks and idempotency keys;
    - the new rules row.
3. **Ledger module:** the posting service, period locks and balance queries; the lint rule.
4. **Billing:**
    - invoice generation and the lease events;
    - accrual, allocation and the provider harness;
    - cash, transfers and banking with their approval handlers;
    - corrections, receipts, VAT, references, arrears and the sub-ledger check.
5. **API and contracts.**
6. **Web screens.**
7. **Seed,** then the independent review, then the report.

### Progress

**2026-10-30, groundwork (committed on `m4a-ledger` with the approved plans).**
- **Domain (`packages/domain/src/ledger`, `packages/domain/src/billing`):**
    - the chart of accounts; entry checks (two lines or more, non-zero, each account in its kind of book, zero per book); one posting function per rule (P01 one-offs, P02, P03 to P06, P07, P08, P10, P21a and b, P23 arrival and match, P24, P27, P28, P29, P32); accounting dates under locks;
    - line balances and derived invoice status; allocation oldest debt first; accrual drawing the line's advance, then credit first in, first out; reversals from current allocations; credit notes and write-offs; the forward walk (paid-until, partial cover, unearned rent, what is due and overdue); ageing; invoice cycles, billing start, deposits due and VAT lines; payment references.
    - **Tests:** an in-memory model of a lease's books runs the same planning and posting functions as the service. Property tests over random leases and random sequences of invoices, payments, accruals, reversals, credit notes and write-offs prove invariants 1 to 5, 7 and 9 and that deposits never reach income (2,000 runs locally: about 8 payments, 10 accruals and 3 corrections per lease; 150 runs in CI). The two-year advance is walked month by month. 527 domain tests pass.
- **Contracts:** `packages/contracts/src/billing.ts` (plan 4.18), and `billingStartDate` on `POST /leases/paper`.
- **Documents:** invoice and receipt templates (`billing.invoice`, `billing.receipt`, version 1).
- **Policy (4.17):** the matrix gains `billing.view`, `billing.manage`, `payment.record` (cash and cheques, caretakers in scope), `payment.record_transfer` (transfers, not caretakers), `cash.bank` (one's own cash), `cash.bank_others` and `cash.view_own`. The plan's table left landlord owners out of `billing.manage`; they are in, because a self-managing landlord is their own company's admin.
- **Settings and rules:** `invoiceLeadDays` (14 by default); the `vat.applies_to_service_charge` key (its row comes in the migration). OQ-20 lists what the VAT lines assume.
- **Design details settled while building** (none changes a decision):
    1. **Billing start:** staff may also choose a later period start than the default, for a tenant who paid ahead before the platform: those months are never invoiced. Without it, recording a two-year advance paid in cash last year would invoice months already paid.
    2. **Renewal deposits:** a renewal's deposit invoice asks only for what the carried deposit does not cover (`depositDue`); P29 moves the deposit itself when the renewal starts.
    3. **Credit notes:** a deposit is credited only where unpaid (money held as a deposit leaves only through move-out, M8). VAT and levy lines are credited with the line they are charged on, keeping each at its rate of the line's net amount, so the system credit note for periods after a lease ends posts a P27 entry for its VAT lines (their P32 charge is reversed); its rent and service-charge lines still post nothing.
    4. **Released money:** a credit note releases payments' money latest payment first, so older payments stay applied.
    5. **Prepayments carry their dimensions:** an advance allocation sits in 2010 on its line and payment; credit sits on its payment with no line. P02 clears both, so 2010 reconciles per lease, per line and per payment.
    6. **References** are drawn again whenever 0 and Z would be neighbours, the one swap Luhn mod 32 cannot detect.
    7. **For you to look at in the report:** within one invoice the approved order pays every rent line before any service charge. A part payment on an annual invoice with service charge therefore covers rent for every month but service charge for none, and paid-until shows no whole month. Allocating month by month would fix that, but changes the approved order.

**2026-10-30, the backend: steps 2 to 5 and 7 (in the working tree for review, not committed).** The web screens (step 6) are being built separately.

- **Database (step 2):** three migrations; `docs/architecture.md` sections 3.4 and 11 list the tables and policies.
    - **`0012_ledger_billing`,** generated from the Drizzle schema:
        - the ledger and billing tables;
        - `lease.billing_start_date`;
        - `property_ownership_correction` (M2 S5).
    - **`0013_ledger_billing_security`,** written by hand:
        - **The chart of accounts:** the 28 accounts, read-only.
        - **Books:** triggers make one with each owner and with each landlord or agency company. Existing ones were backfilled.
        - **Billing start:** backfilled by decision 1: an e-signed lease bills from its start; a paper lease from the first period starting on or after the day it was recorded. From then on it is set once, at signing (`RA046`).
        - **Row Level Security:** forced, with property, owner and tenant scope.
        - **Append-only:** 20 tables.
        - **The journal's checks:**
            - only `ledger_writer` writes (`RA040`);
            - each entry has two lines or more (`RA041`) and is zero in each book at commit (`RA042`);
            - each account stays in its kind of book (`RA043`);
            - nothing posts into a locked month (`RA044`);
            - lines are written only in their entry's transaction (`RA048`).
        - **Owners and books:**
            - an owner change is refused once the property has an invoice, a payment or a journal line (`RA045`);
            - a lease's invoices stay in one book (`RA047`).
        - **Locks:** advisory locks per lease and per collector and book.
        - **Audit:** row-audit triggers on 18 business tables.
    - **`0014_rules_m4a`:** `vat.applies_to_service_charge` = true, `unverified`, effective from the same date as `vat.commercial_rent` (decision 4; OQ-20).
    - **`bootstrap.sql`:** `GRANT ledger_writer TO rent_app WITH INHERIT FALSE, SET TRUE`. The application role holds no journal privilege until it switches role. It is applied to the local cluster too.
    - **Checked:** the migrations were run on two copies of the dev database. The backfill was right, and every audit chain still verified.
- **Ledger (step 3):**
    - **`PostingService`** is the only code that inserts journal rows:
        - it runs the domain's entry checks;
        - it switches to `ledger_writer` for the insert, then back;
        - it writes one `ledger.entry_posted` audit event per entry.
    - **Replays:** the idempotency key is unique per company, so posting it again returns the existing entry and writes nothing.
    - **It also provides:** accounting dates under locks (the first open day across the entry's books), correction reversals (P21a), month locks and balance queries.
    - **The lint rule** `rent/ledger-writes` fails any other code that writes the journal. Its test is `AC-01 only the posting service writes the journal`.
- **Billing (step 4).** `BillingEngine` runs the domain's planning and posting functions against the database, step for step as the `LeaseLedgerModel` reference does.
    - **BC-01 and P32:**
        - **What is issued:** cycles from the M3 schedule, 14 days ahead by the company setting, keyed on lease and cycle start. The deposit invoice comes at signing, due on the start date, for a lease billed from its start. Held-over months are invoiced as they start.
        - **When a lease ends early or is cancelled:** nothing after the end is billed. System credit notes cancel the lines already issued.
        - **Not billed:** a property with two owners on the day (`notBilledReason: joint_owners`).
        - **VAT:** VAT, NHIL and GETFund lines follow each rent and service-charge line on a VAT-registered owner's commercial lease. Each rate is read in the transaction and its rule id kept on the invoice and the line. A payment beyond the issued invoices issues the invoices it pays for (decision 4).
        - **P01 one-off lines** post when issued, but nothing raises a one-off charge yet: plan 4.18 has no endpoint for one. The domain tests cover the rule.
    - **AR-01 to AR-03 (P02, P09):**
        - **Accrual:** each started line accrues once (`P02:<line id>`). It draws first on its own advance, then on credit, oldest payment first. The value date is the period start; the accounting date moves to the first open day if that month is locked.
        - **Payments accrue first:** a payment accrues the lease's started lines before it allocates.
        - **Derived on every read, never stored:** paid-until, partial cover, unearned rent, what is due and overdue, earned and unpaid, deposit held and credit.
    - **BC-07 and BC-11 (P03 to P05, P08, P10):**
        - **Allocation:** oldest debt first, with every allocation's source.
        - **Credit:** what is left stays on the payment.
        - **Deposits:** money for a deposit line goes to 2100 per lease, never to income.
        - **The test harness** (`MoneyService.recordProviderPayment`) posts P03 to 1050, standing in for a payment provider.
    - **BC-05, P06, P07 and P28:**
        - **Cash and cheques** are recorded with a photo, then wait for approval (`payment.cash_receipt`). Approval writes the payment, its allocations, the P06 entry and the receipt in one transaction; a rejection writes nothing.
        - **Transfers** need proof and approval (`payment.direct_receipt`). They go into the owner's account (1010) or, for an agency, the agency's (1070).
        - **Banking** needs the slip and approval (`cash.banking`). It never exceeds what the collector holds, checked under the collector's lock both when asked and when approved. It is split by property, oldest cash first.
    - **Corrections:**
        - **P21b reversals** (`payment.reversal`, `billing.manage`) are built from current allocations. They credit the cash side where the money is now and issue a credit receipt.
        - **P27 credit notes and P24 write-offs** (`invoice.credit_note`, `invoice.write_off`, `billing.manage`) are checked against the domain before the request opens, and again on approval.
    - **P23 unmatched transfers:** held in suspense (2090) in the receiver's book, and matched by `billing.manage`. Money in an owner's account matches only that owner's leases. Money in the agency's account moves into the owner's book.
    - **P29:** when a renewal starts, each payment's credit and the deposit move to the new lease, which keeps first-in, first-out order. A started renewal is carried over before any other billing on it, and by the daily accrual if the event was missed.
    - **BC-08:** lines due before the as-of date, whatever day they were invoiced, less allocations accounted up to it. Rows by tenant, property or owner.
    - **BC-03:** one reference per lease at signing, unique across the platform.
    - **Numbers (the numbering half of BC-06):**
        - receipts `RC-000001` and invoices `INV-000001`, per company;
        - taken in the posting transaction from `company_counter` with `INSERT … ON CONFLICT DO UPDATE … RETURNING`;
        - the row lock orders concurrent takers, and a rollback gives the number back.
    - **PDFs:** every invoice and receipt requests its PDF in the same transaction (the outbox); the worker renders it. A `payment.posted` event is written for M4b's receipt sender.
    - **The sub-ledger check (4.16):** each entry balances per book; invariants 2, 3, 4 and 7; 2090 against unmatched receipts; 1060 per collector and book. A mismatch raises `billing.subledger_mismatch`.
    - **Owners (decisions 5 and 6, M2 S5):** `POST /properties/{propertyId}/ownership/correction` corrects the owner on the same day, before any ledger entry. Changes after the first entry are refused.
- **Concurrency:**
    - **Locks:** one advisory lock per lease (`app.lock_lease_billing`) serialises everything that bills, accrues, allocates or corrects a lease; renewals lock both leases, in id order. Cash takes one per collector and book (`app.lock_collector_cash`).
    - **Order:** both locks are taken before any audited write, so the order is always lease, then collector, then the audit chain head.
    - **Approvals:** M1's engine gains a `prepare` step, which takes these locks before the decision row is written.
- **Idempotent requests (M2 S8):**
    - **Where:** one place in the API (`apps/api/src/http/idempotency.ts`) over `IdempotencyStore` (`packages/server/src/core/idempotency.ts`).
    - **Required on** the seven money writes. Without the header the API answers 400 `idempotency_key_required`.
    - **What is stored:** the key per company and person, with a SHA-256 hash of the operation, the person and the body.
    - **How it runs:** a reservation; a claim inside the write's own transaction; the response saved on success; the reservation released on failure.
    - **Answers:** a replay returns the stored response. The key with another body gets 422 `idempotency_key_reused`. A second request while the first runs gets 409 `request_in_progress`.
    - **Uploads:** a photo or proof is staged outside the write, so a retry never stores it twice.
- **API (step 5):**
    - **`BillingController`** serves the whole billing contract (4.18), with `billingStartDate` on paper leases (the default, an earlier period start or a later one).
    - **Two contract changes, both additive:**
        - `paymentsContract.paymentFile`: `GET /payment-files/{documentId}/download` returns `{ url }`;
        - `registerContract.correctOwner`.
- **Worker:** the invoice, accrual and sub-ledger runs at 00:10, 00:20 and 03:00, each fanning out one job per company; and the lease events `lease.signed`, `lease.activated`, `lease.ended` and `lease.cancelled` (architecture section 10).
- **Seed (step 7):**
    - **How it records money:** through the real services: cash and cheques approved by a second person, transfers, Kojo's banking, and one unmatched transfer.
    - **Each run** ends with the sub-ledger check: `Money: 14 new payments; the sub-ledger check found 0 mismatches.` A second run adds nothing.
    - **Balances on a fresh database seeded on 2026-10-30.** Dates move with the day of seeding: billing starts and arrears are set relative to it.

        | Unit | Tenant and story | Billed from | Paid until | Owed | Unearned | Deposit | Credit |
        | --- | --- | --- | --- | --- | --- | --- | --- |
        | ACC-LEG-B1-01 | Kwame Monthly: monthly, paid up in cash | 2026-07-30 | 2026-11-29 | nothing | — | GH₵1,600.00 | — |
        | ACC-LEG-B1-02 | Efua Annual: a year in advance, in cash | 2026-08-30 | 2027-08-29 (the end) | nothing | GH₵6,300.00 | — | — |
        | ACC-ELG-B1-04 | Yaw Two-Year: GH₵36,000 by transfer, deposit in cash | 2026-09-30 | 2028-09-29 (the end) | nothing | GH₵33,000.00, falling GH₵1,500 a month | GH₵3,000.00 | — |
        | ACC-OSU-G-01 | Osu Pharmacy Ltd: commercial, owner Nana Owner-Accra VAT-registered, quarterly invoices with VAT lines, by transfer | 2026-06-30 | 2026-12-29 | nothing | GH₵3,000.00 | GH₵9,000.00 | — |
        | ACC-LEG-B2-01 | Kofi Arrears-45 | 2026-06-15 | 2026-09-14, plus GH₵100.00 towards 2026-09-15 | GH₵700.00 overdue: GH₵400.00 at 0–30 days, GH₵300.00 at 31–60; oldest due 2026-09-15 | — | — | — |
        | ACC-LEG-B2-02 | Esi Arrears-95 | 2026-05-27 | 2026-07-26, plus GH₵150.00 towards 2026-07-27 | GH₵1,450.00 overdue: GH₵400.00 each at 0–30, 31–60 and 61–90, GH₵250.00 at 90+; oldest due 2026-07-27 | — | — | — |
        | ACC-LEG-B2-03 | Kojo Partial: part payment by cheque | 2026-08-30 | 2026-10-29, plus GH₵200.00 towards 2026-10-30 | GH₵250.00 due today | — | — | — |
        | ACC-ELG-B1-02 | Adwoa Credit: overpaid | 2026-08-30 | 2026-11-29, plus GH₵500.00 towards 2026-11-30 | nothing | GH₵500.00 | GH₵3,600.00 | GH₵500.00 |
        | ACC-ELG-B1-05 | Ama Tenant (agency): by transfer into the owner's account | 2026-08-30 | 2026-11-29 | nothing | — | GH₵4,400.00 | — |
        | ACC-ELG-B1-01 | Akua Expiring: no money recorded | 2026-10-30 (the paper default, so no deposit invoice) | — | GH₵1,800.00 due today | — | — | — |
        | TEM-EST-B1-01 | Ama Tenant (landlord): six-monthly; the first half-year and deposit in cash, confirmed by the nominated adviser | 2026-04-30 | 2026-10-29 | GH₵27,000.00 due today (the second half-year), GH₵4,500.00 of it earned | — | GH₵9,000.00 | — |

        - **Not billed:** ACC-ELG-B1-03 (Kojo Signing) is out for signature.
        - **Cash on hand:** Kofi Manager GH₵14,600.00 and Akosua Manager GH₵3,350.00. Kojo Caretaker holds GH₵800.00 for Ama Owner-London (demo), after banking GH₵800.00. Kwabena Landlord holds GH₵36,000.00.
        - **Unmatched:** one GH₵500.00 transfer into the agency's account (`UNKNOWN TRF 0001 (demo)`).

        These are the units and names the web end-to-end specs read (ACC-LEG-B1-01, ACC-ELG-B1-04, ACC-LEG-B2-03, Kofi's and Esi's leases, Kojo, Ama Owner-London and the Legon compound house).
    - **The dev database (`rent`)** is migrated and seeded, but on top of the M3 data. My reset (emptying the data tables after a backup) was refused by the permission system, so I did not reset it.
        - **What that means:** the M3 demo leases keep their M3 dates, and the backfill bills them from 2026-10-29. Nothing is months in arrears, and ACC-ELG-B1-04 (at the M3 rent) is paid until 2028-01-28, with part of its advance invoice overdue.
        - **The end-to-end specs need a fresh database,** as in CI. The backup is `backups/20261030T132525Z.dump`. To start fresh, stop `pnpm dev`, then:

          ```
          docker compose exec -T postgres dropdb --username=postgres --force rent
          docker compose exec -T postgres psql --username=postgres --dbname=postgres -f /docker-entrypoint-initdb.d/01-bootstrap.sql
          pnpm db:migrate && pnpm db:seed
          ```
- **The coordinator's six items:**
    1. **Payment files:** `GET /payment-files/{documentId}/download` serves a cash or cheque photo, a transfer proof or a banking slip. It is open to people with `billing.view` within their scope, to anyone who may decide the record's open request, and to a caretaker for their own records.
    2. **Approval payloads** carry `amountMinor` and the display fields. Subject types:
        - `cash_record`, `cash_banking`, `payment` (reversals) and `invoice_line` (credit notes and write-offs);
        - `direct_receipt` for transfers. The screen has no page for it, so it falls back to the payload's lease.
    3. **Reversals** need `billing.manage`. A caretaker is refused (`apps/api/test/billing.int.test.ts`).
    4. **Caretakers** get 403 on every billing read except their own cash records and cash on hand (the same test).
    5. **`Idempotency-Key` passes the web app's rewrite.** `/api/v1/:path*` is a plain proxy, and the web's `lib/idempotency.ts` sends a UUID v4 key.
    6. **Seed units:** they match on a fresh database (the table above).
- **Design details settled while building (continued):**
    8. **Approval first:** cash, cheques and transfers wait as records with an approval request. The payment exists only once approved.
    9. **Lock order:** the lease, then the collector's cash, then the audit chain head (above).
    10. **Someone else's cash:** recording or banking it needs `cash.bank_others` (owners in their own company, agency admins and accountants). Everyone else records and banks their own.
    11. **Where a reversal takes money from:** where it is now (`collector`, `owner_account`, `agency_account` or `provider`). From a collector, never more than they hold.
    12. **Owner names for caretakers** come from a narrow definer function. Cash on hand names the owner without opening the owner register to them.
    13. **TINs** print masked on invoices and receipts, as M3 stores them for display. OQ-20 item 6 asks whether a VAT invoice needs them in full.
    14. **Invoice and receipt PDFs** are for staff only. Tenants get them in M4b.
- **For the review:**
    - **Approval requests are company-wide (M1).** A property-scoped manager or accountant sees and may decide money requests for properties outside their scope. The payloads carry tenant names and amounts. Client owners cannot see approvals, and caretakers see only the requests they started. I recommend scoping approval requests by property before the pilot.
    - **A rare deadlock in M3's cancel-signed flow.** The handler locks the audit chain head, then the lease. The daily transitions job locks the unit, the lease and then the chain head. Neither M3's tests nor these hit it.
    - **Design detail 7 above** is still open: how one invoice orders rent and service charge.
- **Tests:** listed with the full run in the report at the end of the milestone. The new integration tests are:
    - **The ledger:** `packages/db/src/ledger.int.test.ts` (8).
    - **Billing:** `packages/server/test/billing.int.test.ts` (16) and `billing-money.int.test.ts` (15).
    - **Differential properties:** `billing-properties.int.test.ts` (4). Random leases run against the database and the reference model, 4 runs each by default (`M4A_PROPERTY_RUNS`); a deep run of 80 each passed in 337 s.
    - **The cash flow:** `billing-flow.int.test.ts` (1).
    - **The API:** `apps/api/test/billing.int.test.ts` (2).
    - **The worker:** `apps/worker/src/billing.jobs.test.ts` (2).
    - **Isolation:** M1's tests cover the new tables, with fixture rows for each.

**2026-10-30, the independent review's fixes (backend; in the working tree, not committed).** Each finding has a regression test that fails before its fix.

- **Must fix:**
    1. **A late move-out keeps what was earned.** System credit notes cancel only lines never charged; accrual never charges a period after the last billable day. Charged lines after the end stay owed and are listed on the lease's money card (`chargedAfterEnd`) for a credit note two people approve. Test: `BC-01 a move-out recorded late keeps what was earned`.
    2. **Money is classified as of the day it arrived.** `postingClassAt` and `planAllocation` classify by value date. A period that started later but has accrued since takes the payment as its advance, then a late draw (Dr 2010, Cr 1100, at the period start). A match uses the day the money arrived. The model, the domain properties and the differential test pay with past value dates. Tests: `BC-07 a payment is classified as of the day it arrived` (domain), `P03 money is classified as of the day it arrived` (2), and a new model invariant (nothing owed on a period before it starts).
- **Should fix:**
    3. **One lock order:** the lease(s), then their properties' owner locks, then the collector's cash, then the counters (a per-company lock that `nextNumber` also takes), then the audit chain head. `lockLeases` takes the property locks with the lease locks; owner changes and corrections take theirs first; approval `prepare` steps take the rest; M3's cancel-signed locks the lease first. A reversal locks all its leases at once, in id order, and ends with a retryable `payment_moved` if another appeared meanwhile. Tests: `BC-05 a reversal from the collector and banking never deadlock`, `PR-07 an owner correction and the first invoice wait for each other`.
    4. **Paid-until** stops at a month credited to nothing and never passes the last billable day. Tests in `review-regressions.test.ts`; the move-out tests assert it.
    5. **Matching and reversing** take a lock per payment; the database refuses a match of reversed money and a line-for-line reversal of matched money (`RA049`); a reversal asked for before a match is cancelled as changed. Tests: `P23 matching and reversing the same unmatched money` (2).
    6. **The sub-ledger check** runs in one read-only snapshot. Test: `AC-01 the sub-ledger check reads one snapshot`.
    7. **Daily runs** isolate each lease: a failure raises `billing.lease_run_failed` (lease id and error code only) and the run carries on. Test: `BC-01 one failing lease never stops the daily runs`.
    8. **Approval requests carry their property** (migration 0015, backfilled in 0016, which resets the company context afterwards). RLS and the policy limit scoped people to their properties; company-level requests (banking) are for unscoped people; eligible approvers are counted by their own scope. Banking waiting is read through `app.pending_banking` (a narrow definer function that returns amounts per book only), so a scoped collector still counts banking someone else asked for on their cash. Tests: `AD-02 approval requests are scoped by property`, `BC-05 a collector counts banking someone else asked for`.
    9. **Deposits carry per payment** (migration 0017 relaxes the check). A reversal takes a carried deposit from the lease holding it, with a carry-back row. The sub-ledger check flags any lease or payment with a negative deposit. Test: `P29 a reversal after the deposit moved to the renewal`.
    10. **Credit pays VAT lines:** at accrual, after the base line, and in the walk (including VAT expected on periods not invoiced yet). Money paths carry a started renewal over first. `issueForAdvance` issues only when the payment exceeds what is open; it then reaches `payment − open + credit` into new cycles. Test: `CT-04 credit pays VAT lines too`.
    11. **No stranded credit:** a late payment's surplus on an ended lease moves to its started renewal; a credit note returns released money to where the payment's credit sits, so `credit_moved` is gone. Test: `P29 no credit is stranded on an ended lease`.
- **Tests that did not prove enough:** 12. the caretaker scope test now proves property scope with cash the collector filter would not hide; 13. the replay test asserts `approval.closed`; 14. move-outs in the model and the differential test (P29 and matching stay in their own integration tests), 24 differential runs by default (about two minutes), paid-until asserted after move-outs, and `AR-03 unearned rent`.
- **Notes:** 15. the reversal's `prepare` re-reads its leases once they are locked and ends the attempt if one appeared (D1). 16. billing reads books and journal lines through `ledger.queries` and approvals through `ApprovalsService`; the sub-ledger check keeps its own reconciliation SQL over the journal, deliberately one level below. 17. a money write stores its answer in its own transaction (`claim.done`); the API rebuilds the response from it. Test: `M2 S8 a committed write always has its answer`. 18. one open credit-note or write-off request per line. 20. an invoice must be in the book of its property's owner on its issue date (`RA050`), and owner changes and invoices take one lock per property. Finding 19 waits for the founder.
- **Second check (the same day):**
    - **A. VAT is owed from its tax point.** One-off and tax lines carry the day they were charged (their P01 or P32 value date). Money that arrived before it is held in 2010 and drawn on that day (the late draw). The invoices a payment makes issue (decision 4) are charged at that payment's value date. Tests: `CT-04 a tax line is owed from its tax point` (domain) and `CT-04 VAT is never owed before its tax point` (2). The model checks it for every line, and the differential test issues VAT at the payment's date. OQ-20 item 7 records the tax point P33 must use.
    - **B and C** are under items 3 and 8 above. **D:** D1 under item 3; D2 under item 10; D3 under item 8.
- **Seed:** a fresh seed gives the same figures as the table above, with 0 mismatches.
- **For the web:** `chargedAfterEnd` on the money card; `ownerId` and `receivedInto` on payment rows; `creditableMinor`, `writeOffableMinor`, `bankableMinor` and `evidenceDocumentId` from part 1.

## 6. Tests

★ marks the tests the roadmap requires for M4a.

| Test | Level | Proves |
| --- | --- | --- |
| ★ `AC-01 the ledger balances` (fast-check, invariant 1) | unit and integration | For any sequence of invoices, payments, accruals, reversals, credit notes and write-offs, every entry sums to zero in each book; the database refuses one that does not. |
| ★ `BC-07 allocation never exceeds what is owed` (fast-check, invariants 2, 3 and 7) | unit and integration | No line is allocated more than it owes. Per payment, allocations net of reversals plus credit equal the payment. 1100 matches each started line, and 2010 matches each lease. |
| ★ `BC-11 deposits never reach income` (fast-check, invariant 4) | unit and integration | 2100 per lease equals deposits received less what they settled, and no path posts deposit money to income. |
| ★ `AR-01 recognition plus prepayments equal what was prepaid` (fast-check, invariant 5) | unit and integration | For any lease with no refund, reversal, credit note or carry-over, what P02 recognised from prepayments plus the 2010 balance equals everything prepaid. |
| ★ `AR-01 a two-year advance month by month` | integration | For GH₵36,000 on a 24-month lease, each month: recognition plus 2010 equals the advance, paid-until is right, and unearned rent falls by GH₵1,500. |
| ★ `AC-01 replaying an event changes nothing` (invariant 8) | integration | Rerunning invoice generation, accrual, approvals and money requests with the same keys posts nothing new. |
| ★ `AR-02 paid-until moves back only on a reversal, credit note or schedule change` (fast-check, invariant 9) | unit | Paid-until under random sequences. |
| ★ `BC-05 cash posts only after a second person approves` | integration | The initiator is refused in the service and in the database; nothing posts before approval or after a rejection. |
| ★ `BC-06 receipt numbers have no gaps under concurrency` | integration | 50 concurrent approvals give numbers 1 to 50 with no gaps or duplicates; invoice numbers likewise. |
| `AC-01 the journal is append-only` | integration | `rent_app` cannot insert, update or delete journal rows by raw SQL; `ledger_writer` cannot update or delete. |
| `BC-01 invoices from lease terms` | unit and integration | Cycles bundle 1, 3, 6 or 12 periods; the initial advance; escalation; lead days; holding-over months; billing start; no periods after the end; no billing for a property with two owners. |
| `BC-07 allocation order` | unit (fast-check) | Due date, then type with VAT after its base line, then period start; accrual before allocation. |
| `P21 payment reversal from current allocations` | integration | A reversal after surplus was applied by accruals restores every line and the credit exactly; a credit receipt is issued. |
| `P27 credit notes` and `P24 write-offs` | integration | Each state of a line (not accrued, accrued and unpaid, accrued and paid); two-person approval. |
| `P23 unmatched direct receipts` | integration | Suspense in the right book; matching across books keeps each book balanced. |
| `P29 renewal carry-over` | integration | Credit and deposit move to the renewal; arrears stay; first-in, first-out order is kept. |
| `CT-04 VAT on commercial invoices` | unit and integration | VAT, NHIL and GETFund per line, rounded once; rule versions recorded; dwellings exempt; the payment is the tax point for advances. |
| `BC-08 arrears ageing` | integration | Buckets by due date as of past dates, by tenant, property and owner. |
| `BC-03 payment references` | unit (fast-check) | Every single-character error and adjacent swap is caught; references are unique. |
| `AC-04 accounting dates under a lock` | integration | An entry dated in a locked month takes the first open day; statements select it there. |
| `M2 S8 idempotent requests` | integration | The same key and body replays; the same key with another body is refused. |
| `NFR-SEC billing isolation and scope` | integration | The new tables pass M1's isolation and coverage tests. A tenant session reads only its own invoices, payments and receipts, and no journal row. A caretaker sees only their assigned properties' cash. |
| `BC-05 and P07 cash on hand` (e2e) | e2e | A caretaker records cash with a photo; a manager approves; the receipt PDF exists; the cash is banked and leaves the caretaker's balance. |
| `AR-02 the lease page shows paid-until and unearned rent` (e2e) | e2e | For the seed's two-year advance and a part-paid lease. |
| `BC-08 arrears screen` (e2e) | e2e | The seed's 45- and 95-day tenants in the right buckets. |

## 7. New dependencies

None expected: the ledger uses PostgreSQL, Drizzle and fast-check, which are already in the stack. Receipt and invoice PDFs use the documents package.

## 8. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A posting or allocation bug | A wrong balance, the worst bug this product can have | Pure posting functions; property-based invariants; database zero-sum and append-only; the nightly sub-ledger check; an independent review of the rules |
| Accrual and allocation drift apart | 1100 and 2010 stop matching their sub-ledgers | Payments accrue first; both write in one transaction per lease, locked per lease; invariants 2 and 3 tested and checked nightly |
| VAT rules are unverified (OQ-20) | Wrong VAT on commercial invoices | Rules rows marked unverified, with the warning shown to staff; the tax adviser is on the roadmap's track for M4a |
| A sole landlord waits 24 hours for cash to post (decision 7) | Friction for the smallest customers | A nominated approver removes it; revisit with the pilot |
| Balance queries slow down at month end | Slow screens at 5,000 units | Indexed sums now; balance snapshots later if the M11 load test needs them (ADR-003) |
| Milestone size | A long build | The build order puts the domain and the ledger first; progress is recorded in section 5 |

## 9. Deviations from the playbook, roadmap and architecture

1. **Receipts:** billing owns the receipt record and its PDF, because the number is taken in the posting transaction. M4b's payments module delivers receipts (4.1).
2. **An independent review in M4a,** as well as the one the playbook asks for at the end of M4 (M4b).
3. **System credit notes need no approval** when a lease ends, because they release only lines whose income was never recognised (4.9).
4. **One audit event per journal entry,** not per line (4.2).
5. **New rules row:** `vat.applies_to_service_charge`, unverified (decision 4).

## 10. Deferred

- **M4b:** provider payments, webhooks, verification, the unmatched queue with suggestions, receipts sent within a minute, reminders, pay links, reconciliation and settlement (BC-02 to BC-04, BC-06, BC-09, BC-12; P22, P31). The tenant app's money screens.
- **M5:** rent tax (P17, P18), withholding (P19, P20), early termination (P13) and VAT returns (P33).
- **M8:** deposits at move-out (P11, P12).
- **M9:** fees, expenses, remittances and statements, which issue period locks (P14 to P16).
- **M10:** subscriptions (P26).
- **M11:** opening balances (P25) with the pilot import.
- **Phase 2:** ownership transfer once a property has ledger entries; joint ownership (PR-07); statement import; late fees (BC-10, OQ-15).
