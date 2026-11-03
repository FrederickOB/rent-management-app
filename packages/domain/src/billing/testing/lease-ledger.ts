import { addDays, parseBusinessDate, toIsoDate } from '../../dates';
import { DomainError } from '../../errors';
import type { BookKind, CashAccount } from '../../ledger/accounts';
import {
  balanceOf,
  checkEntry,
  type JournalLineDraft,
  type PostingRule,
} from '../../ledger/journal';
import {
  accrualLines,
  creditDrawLines,
  creditNoteLines,
  lateDrawLines,
  oneOffChargeLines,
  paymentReversalLines,
  receiptLines,
  vatChargeLines,
  writeOffLines,
  type LeaseDimensions,
} from '../../ledger/posting';
import {
  drawFromPools,
  planAccrual,
  planAllocation,
  planReopenedDraws,
  planTaxDraws,
  withholdingDrawsFor,
} from '../allocation';
import {
  linesAfterEnd,
  planCreditNote,
  planPaymentReversal,
  planWithholding,
  planWriteOff,
} from '../corrections';
import {
  creditApplicationLines,
  refundApprovedLines,
  withholdingDrawLines,
  withholdingLines,
} from '../../ledger/tax-posting';
import { applyCreditToOpenLines, refundCredits } from '../termination';
import type { InvoiceLineDraft } from '../invoicing';
import {
  creditPools,
  inAllocationOrder,
  isRecurring,
  isTax,
  lineBalance,
  paymentCredit,
  postingClassOf,
  type AllocationRow,
  type AllocationSource,
  type BillingLine,
  type PaymentRef,
} from '../lines';
import { forwardWalk, walkLines, type ScheduledPeriod, type WalkResult } from '../walk';

/**
 * M4b decision 9: one invoice is paid month by month. Within each due date, in allocation order
 * (the deposit, each month's rent then its service charge with their VAT and levies, then one-off
 * charges), no line holds money while an earlier line is still open. It holds while nothing has
 * been corrected: a reversal, credit note, write-off or move-out may reopen an earlier month.
 * Returns the first line that breaks it, or null.
 */
export function monthByMonthBreak(
  lines: readonly BillingLine[],
  allocations: readonly AllocationRow[],
): string | null {
  const byDue = new Map<string, BillingLine[]>();
  for (const line of lines) byDue.set(line.dueDate, [...(byDue.get(line.dueDate) ?? []), line]);
  for (const group of byDue.values()) {
    let open: BillingLine | null = null;
    for (const line of inAllocationOrder(group)) {
      const b = lineBalance(line, allocations);
      if (open !== null && b.settledMinor > 0)
        return `${line.id} (${line.kind} ${line.periodStart ?? ''}) holds money while ${open.id} (${open.kind} ${open.periodStart ?? ''}) is open`;
      if (open === null && b.outstandingMinor > 0) open = line;
    }
  }
  return null;
}

/**
 * An in-memory model of one lease in an owner's book (M4a plan section 5, step 1). It runs the
 * same planning and posting functions the billing service runs against the database, so the
 * property-based tests prove the rules themselves.
 */
export interface PostedEntry {
  readonly rule: PostingRule;
  readonly key: string;
  readonly lines: readonly JournalLineDraft[];
  /** When it happened: a payment's day received, a period's start for P02. */
  readonly valueDate: string;
}

export interface ModelPayment extends PaymentRef {
  readonly cash: CashAccount;
  reversed: boolean;
}

export class LeaseLedgerModel {
  readonly book = 'book-owner';
  readonly lease: LeaseDimensions = {
    propertyId: 'property-1',
    unitId: 'unit-1',
    leaseId: 'lease-1',
    tenantId: 'tenant-1',
  };
  readonly lines: BillingLine[] = [];
  readonly allocations: (AllocationRow & { readonly sequence: number })[] = [];
  readonly payments: ModelPayment[] = [];
  readonly entries: PostedEntry[] = [];
  /** Periods the lease will bill that have no invoice line yet. */
  scheduled: ScheduledPeriod[] = [];
  /** Corrections that may move paid-until backwards (invariant 9). */
  corrections = 0;
  /** The last day billed once the tenant has moved out; null while the lease runs. */
  lastDay: string | null = null;
  private sequence = 0;
  private readonly accruedIds = new Set<string>();

  constructor(public today: string) {}

  private bookKind = (): BookKind => 'owner';

  private post(
    rule: PostingRule,
    key: string,
    lines: readonly JournalLineDraft[],
    valueDate: string = this.today,
  ): void {
    if (lines.length === 0) return;
    if (this.entries.some((e) => e.key === key)) return;
    checkEntry(lines, this.bookKind);
    this.entries.push({ rule, key, lines, valueDate });
  }

  private addAllocation(row: AllocationRow): void {
    this.sequence += 1;
    this.allocations.push({ ...row, sequence: this.sequence });
  }

  private refreshAccrued(): void {
    for (let i = 0; i < this.lines.length; i += 1) {
      const line = this.lines[i] as BillingLine;
      if (isRecurring(line.kind) && this.accruedIds.has(line.id) !== line.accrued)
        this.lines[i] = { ...line, accrued: this.accruedIds.has(line.id) };
    }
  }

  /**
   * Issues an invoice's lines (P01 for one-off lines, P32 for tax lines), charged on `taxPoint`:
   * today, or the value date of the payment that made it issue them (decision 4).
   */
  issue(
    drafts: readonly InvoiceLineDraft[],
    dueDate: string,
    invoiceKey: string,
    taxPoint: string = this.today,
  ): BillingLine[] {
    const ids: string[] = [];
    const added: BillingLine[] = [];
    for (const draft of drafts) {
      this.sequence += 1;
      const id = `line-${this.sequence}`;
      ids.push(id);
      const line: BillingLine = {
        id,
        kind: draft.kind,
        baseLineId: draft.baseIndex === null ? null : (ids[draft.baseIndex] as string),
        rateBps: draft.rateBps,
        dueDate,
        periodStart: draft.periodStart,
        periodEnd: draft.periodEnd,
        amountMinor: draft.amountMinor,
        accrued: false,
        sequence: this.sequence,
        chargedOn: isRecurring(draft.kind) || draft.kind === 'deposit' ? null : taxPoint,
      };
      this.lines.push(line);
      added.push(line);
      if (draft.chargePeriodId)
        this.scheduled = this.scheduled.filter((s) => s.id !== draft.chargePeriodId);
    }
    const oneOff = added.filter((l) => l.kind === 'one_off');
    this.post(
      'P01',
      `P01:${invoiceKey}`,
      oneOffChargeLines({
        bookId: this.book,
        lease: this.lease,
        lines: oneOff.map((l) => ({ invoiceLineId: l.id, amountMinor: l.amountMinor })),
      }),
      taxPoint,
    );
    const taxes = added.filter((l) => isTax(l.kind));
    this.post(
      'P32',
      `P32:${invoiceKey}`,
      vatChargeLines({
        bookId: this.book,
        lease: this.lease,
        lines: taxes.map((l) => ({ invoiceLineId: l.id, amountMinor: l.amountMinor })),
      }),
      taxPoint,
    );
    return added;
  }

  private livePayments(): PaymentRef[] {
    return this.payments.filter((p) => !p.reversed);
  }

  /** P02 for every started line not yet accrued, in accrual order, drawing credit first in, first out. */
  accrueTo(date: string): void {
    this.refreshAccrued();
    let pools = creditPools(this.livePayments(), this.allocations);
    const due = this.lines
      .filter(
        (l) =>
          isRecurring(l.kind) &&
          !l.accrued &&
          (l.periodStart as string) <= date &&
          (this.lastDay === null || (l.periodStart as string) <= this.lastDay),
      )
      .sort((a, b) =>
        (a.periodStart as string) !== (b.periodStart as string)
          ? (a.periodStart as string) < (b.periodStart as string)
            ? -1
            : 1
          : a.kind === b.kind
            ? a.sequence - b.sequence
            : a.kind === 'rent'
              ? -1
              : 1,
      );
    for (const line of due) {
      const plan = planAccrual(line, this.allocations, pools);
      for (const draw of plan.draws)
        this.addAllocation({
          lineId: line.id,
          source: 'payment',
          paymentId: draw.paymentId,
          amountMinor: draw.amountMinor,
        });
      pools = drawFromPools(pools, plan.draws);
      if (plan.amountMinor > 0)
        this.post(
          'P02',
          `P02:${line.id}`,
          accrualLines({
            bookId: this.book,
            lease: this.lease,
            invoiceLineId: line.id,
            chargeType: line.kind as 'rent' | 'service_charge',
            amountMinor: plan.amountMinor,
            advance: plan.advance,
            draws: plan.draws,
          }),
          line.periodStart as string,
        );
      // M5 decision 8: withholding held as its advance pays it now, each on its own key.
      for (const d of withholdingDrawsFor(line.id, this.allocations))
        this.post(
          'P02',
          `P02:${line.id}:withholding:${d.withholdingId}`,
          withholdingDrawLines({
            bookId: this.book,
            lease: this.lease,
            invoiceLineId: line.id,
            amountMinor: d.amountMinor,
          }),
          line.periodStart as string,
        );
      // Its VAT and levies, from the credit left (review 10).
      for (const tax of planTaxDraws(
        this.lines.filter((l) => l.baseLineId === line.id),
        this.allocations,
        pools,
      )) {
        for (const draw of tax.draws)
          this.addAllocation({
            lineId: tax.lineId,
            source: 'payment',
            paymentId: draw.paymentId,
            amountMinor: draw.amountMinor,
          });
        pools = drawFromPools(pools, tax.draws);
        this.post(
          'P02',
          `P02:${tax.lineId}`,
          creditDrawLines({
            bookId: this.book,
            lease: this.lease,
            invoiceLineId: tax.lineId,
            draws: tax.draws,
          }),
          line.periodStart as string,
        );
      }
      this.accruedIds.add(line.id);
      this.refreshAccrued();
    }
  }

  /**
   * A payment recorded today, received on `valueDate` (today or earlier): accrue first, then
   * allocate oldest debt first, classified as of the day it was received (P03 to P06, P08, P10).
   * A period that started after that day but has accrued since is paid by a late draw.
   */
  pay(
    amountMinor: number,
    cash: CashAccount = '1050',
    valueDate: string = this.today,
  ): ModelPayment {
    this.accrueTo(this.today);
    const id = `payment-${this.payments.length + 1}`;
    const payment: ModelPayment = {
      id,
      amountMinor,
      order: `${valueDate}#${String(this.payments.length + 1).padStart(6, '0')}`,
      cash,
      reversed: false,
    };
    const plan = planAllocation({
      lines: this.lines,
      allocations: this.allocations,
      paymentId: id,
      amountMinor,
      lease: this.lease,
      valueDate,
      lastDay: this.lastDay,
    });
    this.payments.push(payment);
    for (const a of plan.allocations) this.addAllocation({ ...a, source: 'payment' });
    this.post(
      'P03',
      `P03:${id}`,
      receiptLines({
        cash: {
          bookId: this.book,
          account: cash,
          collectorId: cash === '1060' ? 'collector-1' : null,
        },
        bookId: this.book,
        paymentId: id,
        lease: this.lease,
        allocations: plan.postings,
        surplusMinor: plan.surplusMinor,
      }),
      valueDate,
    );
    for (const draw of plan.lateDraws)
      this.post(
        'P02',
        `P02:${draw.lineId}:${id}`,
        lateDrawLines({
          bookId: this.book,
          lease: this.lease,
          invoiceLineId: draw.lineId,
          paymentId: id,
          amountMinor: draw.amountMinor,
        }),
        draw.valueDate,
      );
    return payment;
  }

  /** P21(b): reverses a payment from what it pays for now. */
  reverse(paymentId: string): void {
    const payment = this.payments.find((p) => p.id === paymentId);
    if (!payment || payment.reversed)
      throw new DomainError('model.no_payment', 'No live payment to reverse');
    this.refreshAccrued();
    const plan = planPaymentReversal({
      payment,
      lines: this.lines,
      allocations: this.allocations,
      leaseOf: () => this.lease,
    });
    for (const row of plan.rows) this.addAllocation(row);
    payment.reversed = true;
    this.corrections += 1;
    this.post(
      'P21',
      `P21:${paymentId}`,
      paymentReversalLines({
        cash: {
          bookId: this.book,
          account: payment.cash,
          collectorId: payment.cash === '1060' ? 'collector-1' : null,
        },
        bookId: this.book,
        paymentId,
        allocations: plan.postings,
        credit: plan.creditMinor > 0 ? { lease: this.lease, amountMinor: plan.creditMinor } : null,
      }),
    );
    this.drawCreditToOpen();
  }

  /**
   * Spare credit pays debt a correction reopened (M4b review F4), as the engine does after a
   * reversal or a credit note: P02 credit draws dated today, one entry per line.
   */
  drawCreditToOpen(): void {
    for (const plan of planReopenedDraws(
      this.lines,
      this.allocations,
      creditPools(this.livePayments(), this.allocations),
    )) {
      const n = this.allocations.filter((a) => a.lineId === plan.lineId).length;
      for (const draw of plan.draws)
        this.addAllocation({
          lineId: plan.lineId,
          source: 'payment',
          paymentId: draw.paymentId,
          amountMinor: draw.amountMinor,
        });
      this.post(
        'P02',
        `P02:${plan.lineId}:redraw:${n}`,
        creditDrawLines({
          bookId: this.book,
          lease: this.lease,
          invoiceLineId: plan.lineId,
          draws: plan.draws,
        }),
      );
    }
  }

  /** P27 on a base line, its tax lines following. */
  creditNote(lineId: string, amountMinor: number, key: string): void {
    this.refreshAccrued();
    const line = this.lines.find((l) => l.id === lineId) as BillingLine;
    const parts = planCreditNote({
      line,
      taxLines: this.lines.filter((l) => l.baseLineId === lineId),
      allocations: this.allocations,
      payments: this.livePayments(),
      amountMinor,
    });
    this.corrections += 1;
    const lines: JournalLineDraft[] = [];
    for (const part of parts) {
      for (const row of part.rows) this.addAllocation(row);
      lines.push(
        ...creditNoteLines({
          bookId: this.book,
          lease: this.lease,
          invoiceLineId: part.line.id,
          chargedTo: part.chargedTo,
          unpaidMinor: part.unpaidMinor,
          released: part.released,
        }),
      );
    }
    this.post('P27', `P27:${key}`, lines);
    this.drawCreditToOpen();
  }

  /**
   * P19 as `BillingEngine.withhold` posts it (TX-04; M5 decision 8 and review 2), with the same
   * planning and posting functions: pinned to its lines, started or not; cash already on a line
   * returns to its payment's credit first, and that credit then pays reopened debt.
   */
  withhold(
    withheld: readonly { readonly lineId: string; readonly amountMinor: number }[],
    key: string,
    paymentId: string | null = null,
  ): void {
    this.accrueTo(this.today);
    const plan = planWithholding({
      lines: this.lines,
      allocations: this.allocations,
      payments: this.livePayments(),
      withheld,
      paymentId,
    });
    for (const row of plan.rows) this.addAllocation({ ...row, recordId: key });
    this.post(
      'P19',
      `P19:${key}`,
      withholdingLines({
        bookId: this.book,
        lease: this.lease,
        paymentId,
        lines: plan.lines.map((l) => ({
          invoiceLineId: l.line.id,
          amountMinor: l.amountMinor,
          prepaid: l.prepaid,
          released: l.released,
        })),
      }),
    );
    if (plan.released.length > 0) this.drawCreditToOpen();
  }

  /** P13 apply as `BillingEngine.applyCreditToOpen` posts it: credit pays open charged lines. */
  applyCreditToOpen(key: string): void {
    const { applications } = applyCreditToOpenLines(
      this.lines,
      this.allocations,
      creditPools(this.livePayments(), this.allocations),
    );
    if (applications.length === 0) return;
    for (const a of applications)
      for (const d of a.draws)
        this.addAllocation({
          lineId: a.lineId,
          source: 'payment',
          paymentId: d.paymentId,
          amountMinor: d.amountMinor,
        });
    this.post(
      'P13',
      `P13:${key}:apply`,
      creditApplicationLines({
        bookId: this.book,
        lease: this.lease,
        applications: applications.map((a) => ({ invoiceLineId: a.lineId, draws: a.draws })),
      }),
    );
  }

  /**
   * P13 refund approved as `BillingEngine.approveRefund` posts it: first in, first out by payment;
   * each payment's share reduces its credit, as the engine's refund parts do.
   */
  refund(key: string, amountMinor: number): void {
    const credits = refundCredits(creditPools(this.livePayments(), this.allocations), amountMinor);
    this.post(
      'P13',
      `P13:${key}:refund`,
      refundApprovedLines({ bookId: this.book, lease: this.lease, credits }),
    );
    for (const c of credits) {
      const index = this.payments.findIndex((p) => p.id === c.paymentId);
      const payment = this.payments[index] as ModelPayment;
      this.payments[index] = { ...payment, amountMinor: payment.amountMinor - c.amountMinor };
    }
  }

  /** P24 on a charged line still owed. */
  writeOff(lineId: string, amountMinor: number, key: string): void {
    this.refreshAccrued();
    const line = this.lines.find((l) => l.id === lineId) as BillingLine;
    const row = planWriteOff({ line, allocations: this.allocations, amountMinor });
    this.addAllocation(row);
    this.post(
      'P24',
      `P24:${key}`,
      writeOffLines({ bookId: this.book, lease: this.lease, invoiceLineId: lineId, amountMinor }),
    );
  }

  nextDay(): void {
    this.today = toIsoDate(addDays(parseBusinessDate(this.today), 1));
  }

  // Balances, all from the journal.
  journal(): JournalLineDraft[] {
    return this.entries.flatMap((e) => e.lines);
  }

  balance(
    accountCode: JournalLineDraft['accountCode'],
    filter: Partial<JournalLineDraft> = {},
  ): number {
    return balanceOf(this.journal(), { bookId: this.book, accountCode, ...filter });
  }

  walk(): WalkResult {
    this.refreshAccrued();
    return forwardWalk(
      walkLines({ lines: this.lines, allocations: this.allocations, scheduled: this.scheduled }),
      creditPools(this.livePayments(), this.allocations),
      { lastDay: this.lastDay },
    );
  }

  /**
   * A move-out recorded today, on `lastDay` (today or earlier): nothing after it is billed, and a
   * system credit note cancels the lines never charged for periods after it (review 1, 14).
   */
  moveOut(lastDay: string): void {
    this.refreshAccrued();
    this.lastDay = lastDay;
    this.scheduled = this.scheduled.filter((s) => s.periodStart <= lastDay);
    this.corrections += 1;
    for (const line of linesAfterEnd(this.lines, lastDay)) {
      const b = lineBalance(line, this.allocations);
      if (b.netMinor - b.writtenOffMinor <= 0) continue;
      this.creditNote(line.id, b.netMinor - b.writtenOffMinor, `end-${line.id}`);
    }
  }

  /** Allocations from one source, per line. */
  allocatedFrom(source: AllocationSource, lineId?: string): number {
    return this.allocations
      .filter((a) => a.source === source && (lineId === undefined || a.lineId === lineId))
      .reduce((sum, a) => sum + a.amountMinor, 0);
  }

  /** Decision 9 on the model's own lines: throws if a later month holds money an earlier one lacks. */
  checkMonthByMonth(): void {
    this.refreshAccrued();
    const broken = monthByMonthBreak(this.lines, this.allocations);
    if (broken) throw new DomainError('model.invariant', `Not month by month: ${broken}`);
  }

  /** Invariants 1 to 4 and 7 (architecture section 5). Throws with the first one broken. */
  checkInvariants(): void {
    this.refreshAccrued();
    const fail = (what: string) => {
      throw new DomainError('model.invariant', what);
    };
    // 1. Every entry balances within each book.
    for (const entry of this.entries) checkEntry(entry.lines, this.bookKind);
    // The balances the checks below need, from one pass over the journal: each was a full scan
    // per line or payment, which made the property tests slow (second review, CI timeouts).
    // Rent counts from its period start; one-off and tax lines from their charge (P01, P32).
    const owedFrom = new Map<string, string>();
    for (const line of this.lines) {
      const from = isRecurring(line.kind) ? line.periodStart : (line.chargedOn ?? null);
      if (from !== null) owedFrom.set(line.id, from);
    }
    const receivables = new Map<string, number>();
    const early = new Map<string, number>();
    const cash = new Map<string, number>();
    let leasePrepayments = 0;
    let leaseDeposits = 0;
    for (const entry of this.entries)
      for (const l of entry.lines) {
        if (l.bookId !== this.book) continue;
        if (l.accountCode === '1100' && l.invoiceLineId) {
          receivables.set(l.invoiceLineId, (receivables.get(l.invoiceLineId) ?? 0) + l.amountMinor);
          const from = owedFrom.get(l.invoiceLineId);
          if (from !== undefined && entry.valueDate < from)
            early.set(l.invoiceLineId, (early.get(l.invoiceLineId) ?? 0) + l.amountMinor);
        }
        if (l.leaseId === this.lease.leaseId && l.accountCode === '2010')
          leasePrepayments += l.amountMinor;
        if (l.leaseId === this.lease.leaseId && l.accountCode === '2100')
          leaseDeposits += l.amountMinor;
        if (l.paymentId) {
          const key = `${l.accountCode}|${l.paymentId}`;
          cash.set(key, (cash.get(key) ?? 0) + l.amountMinor);
        }
      }
    // 2. Per line, 1100 equals what is outstanding once the line is charged, and nothing before.
    let prepaidOnLines = 0;
    let depositsHeld = 0;
    for (const line of this.lines) {
      const balance = lineBalance(line, this.allocations);
      const receivable = receivables.get(line.id) ?? 0;
      const cls = postingClassOf(line);
      const expected = cls === 'receivable' ? balance.outstandingMinor : 0;
      if (receivable !== expected)
        fail(`1100 for ${line.id} is ${receivable}, expected ${expected}`);
      if (cls === 'prepayment') prepaidOnLines += balance.settledMinor;
      if (cls === 'deposit') depositsHeld += balance.settledMinor;
    }
    // 3. 2010 equals allocations to lines not yet charged plus every payment's credit.
    const credit = this.livePayments().reduce(
      (sum, p) => sum + paymentCredit(p, this.allocations),
      0,
    );
    const prepayments = 0 - leasePrepayments;
    if (prepayments !== prepaidOnLines + credit)
      fail(`2010 is ${prepayments}, expected ${prepaidOnLines} on lines plus ${credit} credit`);
    // 2b. As of any day before a line is owed, nothing is owed on it: no entry dated earlier
    // touches its receivable (P03 classifies by the day money arrived).
    for (const line of this.lines) {
      const before = early.get(line.id) ?? 0;
      if (before !== 0) fail(`1100 for ${line.id} is ${before} before its period starts`);
    }
    // 4. 2100 equals deposits received less what left them.
    const deposits = 0 - leaseDeposits;
    if (deposits !== depositsHeld) fail(`2100 is ${deposits}, expected ${depositsHeld}`);
    // 7. Per payment, allocations net of reversals plus credit equal the payment; a reversed one is nil.
    for (const p of this.payments) {
      const allocated = this.allocations
        .filter((a) => a.source === 'payment' && a.paymentId === p.id)
        .reduce((sum, a) => sum + a.amountMinor, 0);
      const cashHeld = cash.get(`${p.cash}|${p.id}`) ?? 0;
      if (p.reversed) {
        if (allocated !== 0) fail(`reversed ${p.id} still allocates ${allocated}`);
        if (cashHeld !== 0) fail(`reversed ${p.id} still holds ${cashHeld} on its cash side`);
      } else {
        const remainder = paymentCredit(p, this.allocations);
        if (allocated + remainder !== p.amountMinor) fail(`${p.id} does not add up`);
        if (cashHeld !== p.amountMinor) fail(`${p.id} cash side is ${cashHeld}`);
      }
    }
  }
}
