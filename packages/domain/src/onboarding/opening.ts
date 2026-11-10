import { parseBusinessDate } from '../dates';
import { DomainError } from '../errors';
import {
  drawFromPools,
  planAccrual,
  planAllocation,
  planReopenedDraws,
  planTaxDraws,
} from '../billing/allocation';
import type { ScheduleRow } from '../billing/invoicing';
import {
  creditPools,
  isRecurring,
  lineBalance,
  linesToAccrue,
  paymentCredit,
  postingClassOf,
  type AllocationRow,
  type BillingLine,
  type PaymentRef,
  type RecurringKind,
} from '../billing/lines';
import {
  AGE_BUCKETS,
  ageBucket,
  forwardWalk,
  walkLines,
  type AgeBucket,
  type ScheduledPeriod,
} from '../billing/walk';
import { checkEntry, type JournalLineDraft, type PostingRule } from '../ledger/journal';
import {
  openingAgentCashLines,
  openingAgentCashReductionLines,
  openingArrearsLines,
  openingBalanceKeys,
  openingDepositLines,
  openingDepositReductionLines,
  openingPaymentLines,
  openingPaymentReductionLines,
  openingRentTaxLines,
  openingRentTaxReductionLines,
  openingWithholdingLines,
  openingWithholdingReductionLines,
} from '../ledger/opening-posting';
import {
  creditDrawLines,
  creditNoteLines,
  lateDrawLines,
  type LeaseDimensions,
} from '../ledger/posting';

/**
 * Opening balances (P25; M11 decision 3; plan 4.2). What a commit of the Balances workbook, or of
 * an adjustment workbook of signed changes, writes for one lease or one owner, and how each lease
 * will look afterwards (the preview). Reads only what it is given; posts nothing.
 *
 * - Arrears become opening invoice lines at their original period and due date, accrued at commit
 *   against opening balances (3900), never income and never accrued again.
 * - An advance is an opening payment (source `opening_balance`, no receipt) allocated as any
 *   payment is, oldest debt first (BC-07): it pays what the lease owes at the cut-over first, and
 *   its surplus is credit that later months draw on, first in, first out, so it is drawn first.
 * - A deposit held is an opening deposit line, settled by an allocation of source
 *   `opening_balance`, so move-out (P11, P12) and renewals (P29) work unchanged.
 * - Withholding outstanding (1150), agent-held cash (1070) and rent tax outstanding (2200) are
 *   entries against 3900.
 * - Opening money posts no rent tax (P17) and no management fee (P14) (OQ-64): see
 *   `isOpeningAllocation`, `taxPeriodsFromWalk`'s `opening` and `FeeAllocation.opening`.
 */

const OWNER = () => 'owner' as const;

const positive = (amount: number, what: string): number => {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new DomainError('opening.bad_amount', `${what} must be an amount above zero`);
  return amount;
};

const isoDate = (date: string, what: string): string => {
  try {
    return parseBusinessDate(date).toString();
  } catch {
    throw new DomainError('opening.bad_date', `${what} is not a date`);
  }
};

// The lease as the plan sees it.

/** A lease's billing records: every balance is derived from them. */
export interface OpeningLeaseState {
  readonly lines: readonly BillingLine[];
  readonly allocations: readonly AllocationRow[];
  /** Live payments whose credit sits on the lease, each with its amount for allocation. */
  readonly payments: readonly PaymentRef[];
  /** Which of them are opening payments (source `opening_balance`). */
  readonly openingPaymentIds: ReadonlySet<string>;
}

/** Where a lease's opening items post and what they must respect. */
export interface OpeningLeaseContext {
  readonly batchId: string;
  /** The company's cut-over: every opening entry is dated it. */
  readonly cutOver: string;
  /** The day the plan is posted (on or after the cut-over): credit drawn onto debt is dated it. */
  readonly today?: string;
  /** The owner's book the lease is billed in. */
  readonly bookId: string;
  readonly lease: LeaseDimensions;
  /** The lease's rent schedule (its charge periods), to place opening arrears. */
  readonly schedule: readonly Pick<
    ScheduleRow,
    'id' | 'chargeType' | 'periodStart' | 'periodEnd'
  >[];
  /** The first period the platform bills (plan 4.1): arrears are for periods before it. */
  readonly billingStart: string;
  /** The lease's last billable day, once known. */
  readonly lastDay?: string | null;
}

// The items a workbook brings in (raising).

export interface OpeningArrearsItem {
  readonly itemId: string;
  /** The opening invoice line it becomes. */
  readonly lineId: string;
  readonly kind: RecurringKind;
  /** The charge period it was owed for: one of the lease's, before billing starts. */
  readonly periodStart: string;
  /** Its original due date, so ageing works. */
  readonly dueDate: string;
  readonly amountMinor: number;
}

export interface OpeningAdvanceItem {
  readonly itemId: string;
  /** The opening payment it becomes. */
  readonly paymentId: string;
  /**
   * Its place first in, first out: before every payment on the platform (received on the cut-over,
   * sorting first that day), so later months draw on it first.
   */
  readonly order: string;
  /** An amount, or what `advanceFromPaidThrough` makes of a paid-through date. */
  readonly amountMinor: number;
}

export interface OpeningDepositItem {
  readonly itemId: string;
  /** The opening deposit line it becomes. */
  readonly lineId: string;
  readonly amountMinor: number;
}

export interface OpeningWithholdingItem {
  readonly itemId: string;
  readonly amountMinor: number;
}

export interface OpeningItems {
  readonly arrears?: readonly OpeningArrearsItem[];
  readonly advances?: readonly OpeningAdvanceItem[];
  readonly deposits?: readonly OpeningDepositItem[];
  readonly withholding?: readonly OpeningWithholdingItem[];
}

// What an adjustment lowers.

export interface OpeningLowering {
  /** An opening line's arrears lowered by `amountMinor`, never below what has been paid of it. */
  readonly arrears?: readonly {
    readonly itemId: string;
    readonly lineId: string;
    readonly amountMinor: number;
  }[];
  /**
   * An advance lowered by `amountMinor`, never below what has been drawn from it: the credit of one
   * opening payment, or with no `paymentId`, of the lease's opening payments, latest first.
   */
  readonly advances?: readonly {
    readonly itemId: string;
    readonly paymentId?: string | null;
    readonly amountMinor: number;
  }[];
  /**
   * A deposit held lowered by `amountMinor`, never below what has been taken from it (a move-out
   * or a renewal): one opening deposit line, or with no `lineId`, the lease's, latest first.
   */
  readonly deposits?: readonly {
    readonly itemId: string;
    readonly lineId?: string | null;
    readonly amountMinor: number;
  }[];
  /** Withholding outstanding lowered, never below what a certificate or write-off has cleared. */
  readonly withholding?: readonly {
    readonly itemId: string;
    readonly amountMinor: number;
    /** What is still outstanding of the opening withholding it lowers (1150). */
    readonly outstandingMinor: number;
  }[];
}

// The plan.

export interface OpeningLine extends BillingLine {
  readonly itemId: string;
  /** The charge period an arrears line is for; null for a deposit. */
  readonly chargePeriodId: string | null;
}

export interface OpeningAllocation extends AllocationRow {
  /** The workbook item behind it; null for credit drawn onto debt (BC-07). */
  readonly itemId: string | null;
  readonly valueDate: string;
}

export interface OpeningPayment extends PaymentRef {
  readonly itemId: string;
  /** The day it is dated: the cut-over. */
  readonly receivedOn: string;
}

export interface OpeningReduction {
  readonly itemId: string;
  readonly paymentId: string;
  /** Taken off the payment's amount for allocation, as a refund part is. */
  readonly amountMinor: number;
}

export interface OpeningEntry {
  readonly rule: Extract<PostingRule, 'P02' | 'P25'>;
  /**
   * `P25:<batch>:<item>` for an item; `P02:<line>:<payment>` for a late draw (P03, review 2);
   * `P02:<line>:redraw:<n>` for credit drawn onto opening debt (M4b review F4), as the engine keys
   * them.
   */
  readonly key: string;
  readonly itemId: string | null;
  readonly valueDate: string;
  readonly lines: readonly JournalLineDraft[];
}

export interface OpeningLeasePlan {
  readonly lines: readonly OpeningLine[];
  readonly allocations: readonly OpeningAllocation[];
  readonly payments: readonly OpeningPayment[];
  readonly reductions: readonly OpeningReduction[];
  readonly entries: readonly OpeningEntry[];
  /** The lease after the plan is posted: for the preview and the next step. */
  readonly after: OpeningLeaseState;
}

class Plan {
  readonly lines: OpeningLine[] = [];
  readonly allocations: OpeningAllocation[] = [];
  readonly payments: OpeningPayment[] = [];
  readonly reductions: OpeningReduction[] = [];
  readonly entries: OpeningEntry[] = [];
  private stateLines: BillingLine[];
  private stateAllocations: AllocationRow[];
  private statePayments: PaymentRef[];
  private readonly opening: Set<string>;
  private sequence: number;

  constructor(
    readonly ctx: OpeningLeaseContext,
    state: OpeningLeaseState,
  ) {
    this.stateLines = [...state.lines];
    this.stateAllocations = [...state.allocations];
    this.statePayments = [...state.payments];
    this.opening = new Set(state.openingPaymentIds);
    this.sequence = state.lines.reduce((max, l) => Math.max(max, l.sequence), 0);
  }

  get state(): OpeningLeaseState {
    return {
      lines: this.stateLines,
      allocations: this.stateAllocations,
      payments: this.statePayments,
      openingPaymentIds: this.opening,
    };
  }

  key(itemId: string): string {
    return openingBalanceKeys.item(this.ctx.batchId, itemId);
  }

  post(entry: OpeningEntry): void {
    if (entry.lines.length === 0) return;
    if (this.entries.some((e) => e.key === entry.key))
      throw new DomainError(
        'opening.repeated_item',
        `Item ${entry.itemId ?? entry.key} is given twice`,
      );
    checkEntry(entry.lines, OWNER);
    this.entries.push(entry);
  }

  addLine(line: OpeningLine): void {
    if (this.stateLines.some((l) => l.id === line.id))
      throw new DomainError('opening.line_exists', `Line ${line.id} already exists`);
    this.sequence += 1;
    const placed = { ...line, sequence: this.sequence };
    this.lines.push(placed);
    this.stateLines.push(placed);
  }

  allocate(row: AllocationRow, itemId: string | null, valueDate: string): void {
    this.allocations.push({ ...row, itemId, valueDate });
    this.stateAllocations.push(row);
  }

  addPayment(payment: OpeningPayment): void {
    if (this.statePayments.some((p) => p.id === payment.id))
      throw new DomainError('opening.payment_exists', `Payment ${payment.id} already exists`);
    this.payments.push(payment);
    this.statePayments.push({
      id: payment.id,
      amountMinor: payment.amountMinor,
      order: payment.order,
    });
    this.opening.add(payment.id);
  }

  reduce(reduction: OpeningReduction): void {
    this.reductions.push(reduction);
    this.statePayments = this.statePayments.map((p) =>
      p.id === reduction.paymentId
        ? { ...p, amountMinor: p.amountMinor - reduction.amountMinor }
        : p,
    );
  }

  result(): OpeningLeasePlan {
    return {
      lines: this.lines,
      allocations: this.allocations,
      payments: this.payments,
      reductions: this.reductions,
      entries: this.entries,
      after: this.state,
    };
  }
}

function checkContext(ctx: OpeningLeaseContext): string {
  const cutOver = isoDate(ctx.cutOver, 'The cut-over');
  isoDate(ctx.billingStart, 'The billing start');
  const today = ctx.today === undefined ? cutOver : isoDate(ctx.today, 'Today');
  if (today < cutOver)
    throw new DomainError(
      'opening.before_cut_over',
      'Opening balances post on or after the cut-over',
    );
  return today;
}

/** Raising: new opening items, in the order arrears, deposits, advances, then withholding. */
function raise(plan: Plan, items: OpeningItems, today: string): void {
  const { ctx } = plan;
  const lineIds = new Set<string>();
  const fresh = (id: string, what: string) => {
    if (!id || lineIds.has(id))
      throw new DomainError('opening.repeated_line', `${what} ${id} is given twice`);
    lineIds.add(id);
  };

  // Arrears: opening lines, owed from the cut-over in the ledger, at their original periods.
  const periods = new Set<string>();
  for (const item of items.arrears ?? []) {
    positive(item.amountMinor, 'Opening arrears');
    if (!isRecurring(item.kind))
      throw new DomainError('opening.arrears_kind', 'Arrears are rent or service charge');
    const periodStart = isoDate(item.periodStart, 'The period start');
    const dueDate = isoDate(item.dueDate, 'The due date');
    const period = ctx.schedule.find(
      (p) => p.chargeType === item.kind && p.periodStart === periodStart,
    );
    if (!period)
      throw new DomainError(
        'opening.not_a_period',
        `${periodStart} does not start one of the lease’s ${item.kind === 'rent' ? 'rent' : 'service-charge'} periods`,
      );
    if (!(periodStart < ctx.billingStart) || periodStart > ctx.cutOver)
      throw new DomainError(
        'opening.period_billed',
        'Arrears are for periods before the cut-over; later periods are billed on the platform',
      );
    const pair = `${item.kind}|${periodStart}`;
    if (periods.has(pair))
      throw new DomainError(
        'opening.repeated_period',
        `Arrears for ${periodStart} are given twice`,
      );
    periods.add(pair);
    const billed = plan.state.lines.find(
      (l) => l.opening !== true && l.kind === item.kind && l.periodStart === periodStart,
    );
    if (billed)
      throw new DomainError(
        'opening.period_billed',
        `The platform already bills the period from ${periodStart}`,
      );
    fresh(item.lineId, 'Line');
    plan.addLine({
      id: item.lineId,
      kind: item.kind,
      baseLineId: null,
      rateBps: null,
      dueDate,
      periodStart,
      periodEnd: period.periodEnd,
      amountMinor: item.amountMinor,
      accrued: true,
      sequence: 0,
      chargedOn: ctx.cutOver,
      opening: true,
      itemId: item.itemId,
      chargePeriodId: period.id,
    });
    plan.post({
      rule: 'P25',
      key: plan.key(item.itemId),
      itemId: item.itemId,
      valueDate: ctx.cutOver,
      lines: openingArrearsLines({
        bookId: ctx.bookId,
        lease: ctx.lease,
        invoiceLineId: item.lineId,
        amountMinor: item.amountMinor,
      }),
    });
  }

  // Deposits held: settled opening deposit lines.
  for (const item of items.deposits ?? []) {
    positive(item.amountMinor, 'The deposit held');
    fresh(item.lineId, 'Line');
    plan.addLine({
      id: item.lineId,
      kind: 'deposit',
      baseLineId: null,
      rateBps: null,
      dueDate: ctx.cutOver,
      periodStart: null,
      periodEnd: null,
      amountMinor: item.amountMinor,
      accrued: false,
      sequence: 0,
      chargedOn: null,
      opening: true,
      itemId: item.itemId,
      chargePeriodId: null,
    });
    plan.allocate(
      {
        lineId: item.lineId,
        source: 'opening_balance',
        paymentId: null,
        amountMinor: item.amountMinor,
        recordId: item.itemId,
      },
      item.itemId,
      ctx.cutOver,
    );
    plan.post({
      rule: 'P25',
      key: plan.key(item.itemId),
      itemId: item.itemId,
      valueDate: ctx.cutOver,
      lines: openingDepositLines({
        bookId: ctx.bookId,
        lease: ctx.lease,
        invoiceLineId: item.lineId,
        amountMinor: item.amountMinor,
      }),
    });
  }

  // Advances: opening payments, allocated as any payment is (oldest debt first), never to a deposit.
  for (const item of items.advances ?? []) {
    positive(item.amountMinor, 'An advance');
    if (!item.paymentId || !item.order)
      throw new DomainError('opening.payment_id', 'An opening payment needs its id and order');
    const { lines, allocations } = plan.state;
    const allocation = planAllocation({
      lines: lines.filter((l) => l.kind !== 'deposit'),
      allocations,
      paymentId: item.paymentId,
      amountMinor: item.amountMinor,
      lease: ctx.lease,
      valueDate: ctx.cutOver,
      lastDay: ctx.lastDay ?? null,
    });
    plan.addPayment({
      id: item.paymentId,
      amountMinor: item.amountMinor,
      order: item.order,
      itemId: item.itemId,
      receivedOn: ctx.cutOver,
    });
    for (const a of allocation.allocations)
      plan.allocate({ ...a, source: 'payment' }, item.itemId, ctx.cutOver);
    plan.post({
      rule: 'P25',
      key: plan.key(item.itemId),
      itemId: item.itemId,
      valueDate: ctx.cutOver,
      lines: openingPaymentLines({
        bookId: ctx.bookId,
        lease: ctx.lease,
        paymentId: item.paymentId,
        allocations: allocation.postings,
        surplusMinor: allocation.surplusMinor,
      }),
    });
    for (const draw of allocation.lateDraws)
      plan.post({
        rule: 'P02',
        key: `P02:${draw.lineId}:${draw.paymentId}`,
        itemId: item.itemId,
        valueDate: draw.valueDate,
        lines: lateDrawLines({
          bookId: ctx.bookId,
          lease: ctx.lease,
          invoiceLineId: draw.lineId,
          paymentId: draw.paymentId,
          amountMinor: draw.amountMinor,
        }),
      });
  }

  // Credit never sits beside debt (BC-07; M4b review F4): credit the lease already holds pays
  // opening arrears it could not reach, first in, first out, as after a correction.
  drawCreditToDebt(plan, today);

  for (const item of items.withholding ?? []) {
    positive(item.amountMinor, 'Withholding outstanding');
    plan.post({
      rule: 'P25',
      key: plan.key(item.itemId),
      itemId: item.itemId,
      valueDate: ctx.cutOver,
      lines: openingWithholdingLines({
        bookId: ctx.bookId,
        lease: ctx.lease,
        amountMinor: item.amountMinor,
      }),
    });
  }
}

function drawCreditToDebt(plan: Plan, today: string): void {
  const { ctx } = plan;
  const { lines, allocations, payments } = plan.state;
  for (const draw of planReopenedDraws(lines, allocations, creditPools(payments, allocations))) {
    const n = plan.state.allocations.filter((a) => a.lineId === draw.lineId).length;
    for (const d of draw.draws)
      plan.allocate(
        {
          lineId: draw.lineId,
          source: 'payment',
          paymentId: d.paymentId,
          amountMinor: d.amountMinor,
        },
        null,
        today,
      );
    plan.post({
      rule: 'P02',
      key: `P02:${draw.lineId}:redraw:${n}`,
      itemId: null,
      valueDate: today,
      lines: creditDrawLines({
        bookId: ctx.bookId,
        lease: ctx.lease,
        invoiceLineId: draw.lineId,
        draws: draw.draws,
      }),
    });
  }
}

/**
 * The commit of one lease's opening items (P25): its opening lines, deposits, payments and
 * withholding, with their allocations and entries, validated. Lines started by the cut-over must be
 * accrued first, as on every money path. Committing the same items again gives the same plan (the
 * same keys); the server posts each key once.
 */
export function planOpeningLease(
  input: OpeningLeaseContext & { readonly state: OpeningLeaseState; readonly items: OpeningItems },
): OpeningLeasePlan {
  const today = checkContext(input);
  const plan = new Plan(input, input.state);
  raise(plan, input.items, today);
  return plan.result();
}

/**
 * An adjustment of one lease's opening balances (decision 3): signed changes. Lowering comes
 * first, each never below what has been paid or drawn; then raising adds opening items, as the
 * commit does.
 * - Arrears lowered: a credit note on the opening line's unpaid part (P27 against 3900).
 * - An advance lowered: the opening payment's credit returns to 3900; its amount for allocation
 *   drops by a reduction, as a refund part does.
 * - A deposit lowered: a negative `opening_balance` allocation and a credit note of the same amount
 *   on the opening deposit line; Dr 2100, Cr 3900. `depositHeldMinor` is 2100 for the lease now.
 * - Withholding lowered: Dr 3900, Cr 1150.
 */
export function planOpeningAdjustment(
  input: OpeningLeaseContext & {
    readonly state: OpeningLeaseState;
    readonly lower?: OpeningLowering;
    readonly raise?: OpeningItems;
    /** 2100 for the lease now (deposits held, net of what left them); needed to lower a deposit. */
    readonly depositHeldMinor?: number;
  },
): OpeningLeasePlan {
  const today = checkContext(input);
  const plan = new Plan(input, input.state);
  const lower = input.lower ?? {};
  const { ctx } = plan;

  for (const change of lower.arrears ?? []) {
    positive(change.amountMinor, 'The change');
    const line = plan.state.lines.find((l) => l.id === change.lineId);
    if (!line || line.opening !== true || !isRecurring(line.kind))
      throw new DomainError('opening.not_opening_line', 'Only opening arrears can be lowered here');
    const { outstandingMinor } = lineBalance(line, plan.state.allocations);
    if (change.amountMinor > outstandingMinor)
      throw new DomainError(
        'opening.below_paid',
        'Opening arrears cannot be lowered below what has been paid of them',
      );
    plan.allocate(
      {
        lineId: line.id,
        source: 'credit_note',
        paymentId: null,
        amountMinor: change.amountMinor,
        recordId: change.itemId,
      },
      change.itemId,
      ctx.cutOver,
    );
    plan.post({
      rule: 'P25',
      key: plan.key(change.itemId),
      itemId: change.itemId,
      valueDate: ctx.cutOver,
      lines: creditNoteLines({
        bookId: ctx.bookId,
        lease: ctx.lease,
        invoiceLineId: line.id,
        chargedTo: '3900',
        unpaidMinor: change.amountMinor,
        released: [],
      }),
    });
  }

  for (const change of lower.advances ?? []) {
    positive(change.amountMinor, 'The change');
    const { payments, allocations } = plan.state;
    const opening = payments
      .filter((p) => plan.state.openingPaymentIds.has(p.id))
      .filter((p) => !change.paymentId || p.id === change.paymentId)
      .sort((a, b) => (a.order < b.order ? 1 : a.order > b.order ? -1 : 0));
    if (change.paymentId && opening.length === 0)
      throw new DomainError(
        'opening.not_opening_payment',
        'Only an opening payment can be lowered here',
      );
    let need = change.amountMinor;
    const parts: OpeningReduction[] = [];
    for (const p of opening) {
      if (need === 0) break;
      const take = Math.min(paymentCredit(p, allocations), need);
      if (take <= 0) continue;
      parts.push({ itemId: change.itemId, paymentId: p.id, amountMinor: take });
      need -= take;
    }
    if (need > 0)
      throw new DomainError(
        'opening.below_drawn',
        'An advance cannot be lowered below what has been drawn from it',
      );
    for (const part of parts) plan.reduce(part);
    plan.post({
      rule: 'P25',
      key: plan.key(change.itemId),
      itemId: change.itemId,
      valueDate: ctx.cutOver,
      lines: parts.flatMap((part) =>
        openingPaymentReductionLines({
          bookId: ctx.bookId,
          lease: ctx.lease,
          paymentId: part.paymentId,
          amountMinor: part.amountMinor,
        }),
      ),
    });
  }

  let depositLeft = input.depositHeldMinor;
  for (const change of lower.deposits ?? []) {
    positive(change.amountMinor, 'The change');
    if (depositLeft === undefined || !Number.isSafeInteger(depositLeft))
      throw new DomainError('opening.deposit_held', 'Say how much deposit the lease holds now');
    const { lines, allocations } = plan.state;
    const held = (line: BillingLine) =>
      allocations
        .filter((a) => a.lineId === line.id && a.source === 'opening_balance')
        .reduce((s, a) => s + a.amountMinor, 0);
    const targets = lines
      .filter((l) => l.kind === 'deposit' && l.opening === true)
      .filter((l) => !change.lineId || l.id === change.lineId)
      .sort((a, b) => b.sequence - a.sequence);
    if (change.lineId && targets.length === 0)
      throw new DomainError(
        'opening.not_opening_line',
        'Only an opening deposit can be lowered here',
      );
    let need = change.amountMinor;
    if (need > depositLeft)
      throw new DomainError(
        'opening.below_drawn',
        'A deposit cannot be lowered below what has been taken from it',
      );
    const parts: { line: BillingLine; amountMinor: number }[] = [];
    for (const line of targets) {
      if (need === 0) break;
      const take = Math.min(held(line), need);
      if (take <= 0) continue;
      parts.push({ line, amountMinor: take });
      need -= take;
    }
    if (need > 0)
      throw new DomainError(
        'opening.below_drawn',
        'A deposit cannot be lowered below what has been taken from it',
      );
    depositLeft -= change.amountMinor;
    // What the line held returns to opening balances, and the line no longer charges it.
    for (const part of parts) {
      for (const [source, amount] of [
        ['opening_balance', -part.amountMinor],
        ['credit_note', part.amountMinor],
      ] as const)
        plan.allocate(
          {
            lineId: part.line.id,
            source,
            paymentId: null,
            amountMinor: amount,
            recordId: change.itemId,
          },
          change.itemId,
          ctx.cutOver,
        );
    }
    plan.post({
      rule: 'P25',
      key: plan.key(change.itemId),
      itemId: change.itemId,
      valueDate: ctx.cutOver,
      lines: parts.flatMap((part) =>
        openingDepositReductionLines({
          bookId: ctx.bookId,
          lease: ctx.lease,
          invoiceLineId: part.line.id,
          amountMinor: part.amountMinor,
        }),
      ),
    });
  }

  for (const change of lower.withholding ?? []) {
    positive(change.amountMinor, 'The change');
    if (
      !Number.isSafeInteger(change.outstandingMinor) ||
      change.amountMinor > change.outstandingMinor
    )
      throw new DomainError(
        'opening.below_drawn',
        'Withholding cannot be lowered below what its certificate or a write-off has cleared',
      );
    plan.post({
      rule: 'P25',
      key: plan.key(change.itemId),
      itemId: change.itemId,
      valueDate: ctx.cutOver,
      lines: openingWithholdingReductionLines({
        bookId: ctx.bookId,
        lease: ctx.lease,
        amountMinor: change.amountMinor,
      }),
    });
  }

  raise(plan, input.raise ?? {}, today);
  return plan.result();
}

// Owner items.

export const OWNER_OPENING_KINDS = ['agent_cash', 'rent_tax'] as const;
export type OwnerOpeningKind = (typeof OWNER_OPENING_KINDS)[number];

export interface OwnerOpeningChange {
  readonly itemId: string;
  readonly kind: OwnerOpeningKind;
  /** Signed: above zero brings an item in (the commit, or raising); below zero lowers one. */
  readonly amountMinor: number;
  /** Rent tax brought in: its due date (TX-02). */
  readonly dueOn?: string | null;
  /**
   * Lowering: what is left to lower: agent cash, the owner's 1070 now; rent tax, what is still
   * unpaid of the opening rent tax (P18 settles items).
   */
  readonly availableMinor?: number;
}

export interface OwnerOpeningPlan {
  readonly entries: readonly OpeningEntry[];
  /** Rent tax items brought in, with their due dates (TX-02 alerts follow them). */
  readonly rentTaxItems: readonly {
    readonly itemId: string;
    readonly amountMinor: number;
    readonly dueOn: string;
  }[];
}

/**
 * An owner's opening items (P25), at the commit or in an adjustment: agent-held cash (Dr 1070, Cr
 * 3900) and rent tax outstanding with its due date (Dr 3900, Cr 2200), in the owner's book.
 */
export function planOwnerOpening(input: {
  readonly batchId: string;
  readonly cutOver: string;
  readonly bookId: string;
  readonly changes: readonly OwnerOpeningChange[];
}): OwnerOpeningPlan {
  const cutOver = isoDate(input.cutOver, 'The cut-over');
  const entries: OpeningEntry[] = [];
  const rentTaxItems: { itemId: string; amountMinor: number; dueOn: string }[] = [];
  // What this plan has lowered so far, per kind: several rows share what is left to lower.
  const lowered: Record<OwnerOpeningKind, number> = { agent_cash: 0, rent_tax: 0 };
  for (const change of input.changes) {
    if (!OWNER_OPENING_KINDS.includes(change.kind))
      throw new DomainError('opening.owner_kind', 'Agent-held cash or rent tax outstanding');
    if (!Number.isSafeInteger(change.amountMinor) || change.amountMinor === 0)
      throw new DomainError('opening.bad_amount', 'A change is an amount other than zero');
    const key = openingBalanceKeys.item(input.batchId, change.itemId);
    if (entries.some((e) => e.key === key))
      throw new DomainError('opening.repeated_item', `Item ${change.itemId} is given twice`);
    const amountMinor = Math.abs(change.amountMinor);
    let lines: JournalLineDraft[];
    if (change.amountMinor > 0) {
      if (change.kind === 'rent_tax') {
        const dueOn = isoDate(change.dueOn ?? '', 'The rent tax due date');
        rentTaxItems.push({ itemId: change.itemId, amountMinor, dueOn });
        lines = openingRentTaxLines({ bookId: input.bookId, amountMinor });
      } else lines = openingAgentCashLines({ bookId: input.bookId, amountMinor });
    } else {
      const available = change.availableMinor;
      if (available === undefined || !Number.isSafeInteger(available))
        throw new DomainError('opening.available', 'Say what is left to lower');
      if (amountMinor > available - lowered[change.kind])
        throw new DomainError(
          'opening.below_drawn',
          change.kind === 'agent_cash'
            ? 'Agent-held cash cannot be lowered below what the agent still holds'
            : 'Rent tax outstanding cannot be lowered below what has been paid to GRA',
        );
      lowered[change.kind] += amountMinor;
      lines =
        change.kind === 'agent_cash'
          ? openingAgentCashReductionLines({ bookId: input.bookId, amountMinor })
          : openingRentTaxReductionLines({ bookId: input.bookId, amountMinor });
    }
    checkEntry(lines, OWNER);
    entries.push({ rule: 'P25', key, itemId: change.itemId, valueDate: cutOver, lines });
  }
  return { entries, rentTaxItems };
}

// Paid-through dates.

/**
 * An advance given as a paid-through date (plan 4.2), as an amount: everything the lease charges
 * from the billing start to that date, rent, service charge and their VAT and levies (`taxMinor`),
 * as the walk applies credit to them. The date must be the last day of one of those months, so
 * paid-until is exactly it once the advance is in. A date before the billing start means nothing
 * is paid ahead of the platform: zero.
 */
export function advanceFromPaidThrough(input: {
  readonly periods: readonly Pick<
    ScheduledPeriod,
    'periodStart' | 'periodEnd' | 'amountMinor' | 'taxMinor'
  >[];
  readonly billingStart: string;
  readonly paidThrough: string;
}): number {
  const billingStart = isoDate(input.billingStart, 'The billing start');
  const paidThrough = isoDate(input.paidThrough, 'The paid-through date');
  if (paidThrough < billingStart) return 0;
  const billed = input.periods.filter((p) => p.periodStart >= billingStart);
  if (!billed.some((p) => p.periodEnd === paidThrough))
    throw new DomainError(
      'opening.paid_through_not_period_end',
      'The paid-through date must be the last day of one of the lease’s rent periods',
    );
  let total = 0;
  for (const p of billed)
    if (p.periodEnd <= paidThrough) {
      if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor < 0)
        throw new DomainError('opening.bad_amount', 'A period charges zero or more pesewas');
      total += p.amountMinor + (p.taxMinor ?? 0);
    }
  return total;
}

// The preview.

/**
 * P02 in memory, for the preview: every line started by `date` and not accrued, in accrual order,
 * uses its own advance, then the lease's credit first in, first out, and its VAT and levies draw on
 * what is left, as the engine accrues. Returns the state after; posts nothing.
 */
export function accrueOpeningState(
  state: OpeningLeaseState,
  date: string,
  lastDay: string | null = null,
): OpeningLeaseState {
  isoDate(date, 'The date');
  let lines = [...state.lines];
  const allocations = [...state.allocations];
  let pools = creditPools(state.payments, allocations);
  const due = linesToAccrue(lines, date).filter(
    (l) => lastDay === null || (l.periodStart as string) <= lastDay,
  );
  for (const line of due) {
    const accrual = planAccrual(line, allocations, pools);
    for (const d of accrual.draws)
      allocations.push({
        lineId: line.id,
        source: 'payment',
        paymentId: d.paymentId,
        amountMinor: d.amountMinor,
      });
    pools = drawFromPools(pools, accrual.draws);
    lines = lines.map((l) => (l.id === line.id ? { ...l, accrued: true } : l));
    for (const tax of planTaxDraws(
      lines.filter((l) => l.baseLineId === line.id),
      allocations,
      pools,
    )) {
      for (const d of tax.draws)
        allocations.push({
          lineId: tax.lineId,
          source: 'payment',
          paymentId: d.paymentId,
          amountMinor: d.amountMinor,
        });
      pools = drawFromPools(pools, tax.draws);
    }
  }
  return { ...state, lines, allocations };
}

/** One lease as the landlord will see it (decision 3), in `onboardingPreviewSchema`'s terms. */
export interface OpeningLeaseFigures {
  /** Owed and due by the day (1100 on lines due on or before it): what the tenant is behind. */
  readonly arrearsMinor: number;
  /** The part past its due date, by days past due, as the dashboard counts it (BC-08). */
  readonly arrearsByAge: Readonly<Record<AgeBucket, number>>;
  /** Paid ahead and not yet drawn: 2010 for the lease (invariant 3). */
  readonly advanceMinor: number;
  /** The forward walk's paid-until (AR-02). */
  readonly paidUntil: string | null;
  /** 2100 for the lease. */
  readonly depositHeldMinor: number;
  /** 1150 for the lease: withholding whose certificate is still to come. */
  readonly withholdingOutstandingMinor: number;
  /** Arrears less what is paid ahead: positive owes, negative is in credit. */
  readonly balanceMinor: number;
}

/**
 * A lease's preview figures on `asOf`, from its records (after a plan, `plan.after`, brought to the
 * day with `accrueOpeningState`). Arrears are the receivables due by the day; their ageing is the
 * dashboard's (`ledgerArrears`): lines past their due date, by days past due. Paid-until is the
 * forward walk's over the lease's lines and its periods still to be invoiced.
 */
export function openingLeaseFigures(input: {
  readonly state: OpeningLeaseState;
  /** Charge periods from the billing start that have no invoice line yet. */
  readonly scheduled: readonly ScheduledPeriod[];
  readonly asOf: string;
  readonly lastDay?: string | null;
  /**
   * 2100 beyond the deposit lines' allocations: carried in less carried out (P29), less what a
   * move-out applied, kept or refunded (P11, P12). Zero by default.
   */
  readonly depositAdjustmentMinor?: number;
  readonly withholdingOutstandingMinor?: number;
}): OpeningLeaseFigures {
  const asOf = isoDate(input.asOf, 'The date');
  const { lines, allocations, payments } = input.state;
  const arrearsByAge = Object.fromEntries(AGE_BUCKETS.map((b) => [b, 0])) as Record<
    AgeBucket,
    number
  >;
  let arrears = 0;
  let prepaidOnLines = 0;
  let deposits = 0;
  for (const line of lines) {
    const posting = postingClassOf(line);
    const balance = lineBalance(line, allocations);
    if (posting === 'deposit') deposits += balance.settledMinor;
    else if (posting === 'prepayment') prepaidOnLines += balance.settledMinor;
    else if (line.dueDate <= asOf) {
      arrears += balance.outstandingMinor;
      const bucket = ageBucket(line.dueDate, asOf);
      if (bucket) arrearsByAge[bucket] += balance.outstandingMinor;
    }
  }
  const pools = creditPools(payments, allocations);
  const advance = prepaidOnLines + pools.reduce((sum, p) => sum + p.amountMinor, 0);
  const walk = forwardWalk(walkLines({ lines, allocations, scheduled: input.scheduled }), pools, {
    lastDay: input.lastDay ?? null,
  });
  const withholding = input.withholdingOutstandingMinor ?? 0;
  const adjustment = input.depositAdjustmentMinor ?? 0;
  if (!Number.isSafeInteger(withholding) || !Number.isSafeInteger(adjustment))
    throw new DomainError('opening.bad_amount', 'Balances are whole numbers of pesewas');
  return {
    arrearsMinor: arrears,
    arrearsByAge,
    advanceMinor: advance,
    paidUntil: walk.paidUntil,
    depositHeldMinor: deposits + adjustment,
    withholdingOutstandingMinor: withholding,
    balanceMinor: arrears - advance,
  };
}

/** One owner's totals in the preview (`onboardingPreviewSchema`'s `owners`). */
export interface OpeningOwnerTotals {
  readonly ownerId: string;
  readonly leases: number;
  readonly arrearsMinor: number;
  readonly advancesMinor: number;
  readonly depositsHeldMinor: number;
  readonly withholdingOutstandingMinor: number;
  readonly agentCashMinor: number;
  readonly rentTaxOutstandingMinor: number;
  /** The earliest due date of the rent tax outstanding; null with none. */
  readonly rentTaxDueOn: string | null;
}

/**
 * The preview's totals per owner: their leases' figures added up, and their own items. Owners in
 * the order they first appear (their items, then their leases).
 */
export function openingOwnerTotals(input: {
  readonly leases: readonly { readonly ownerId: string; readonly figures: OpeningLeaseFigures }[];
  readonly owners: readonly {
    readonly ownerId: string;
    readonly agentCashMinor: number;
    readonly rentTaxOutstandingMinor: number;
    readonly rentTaxDueOn: string | null;
  }[];
}): OpeningOwnerTotals[] {
  const totals = new Map<string, OpeningOwnerTotals>();
  const get = (ownerId: string): OpeningOwnerTotals =>
    totals.get(ownerId) ?? {
      ownerId,
      leases: 0,
      arrearsMinor: 0,
      advancesMinor: 0,
      depositsHeldMinor: 0,
      withholdingOutstandingMinor: 0,
      agentCashMinor: 0,
      rentTaxOutstandingMinor: 0,
      rentTaxDueOn: null,
    };
  for (const o of input.owners) {
    const t = get(o.ownerId);
    const due =
      o.rentTaxOutstandingMinor > 0 && o.rentTaxDueOn !== null
        ? isoDate(o.rentTaxDueOn, 'The rent tax due date')
        : null;
    totals.set(o.ownerId, {
      ...t,
      agentCashMinor: t.agentCashMinor + o.agentCashMinor,
      rentTaxOutstandingMinor: t.rentTaxOutstandingMinor + o.rentTaxOutstandingMinor,
      rentTaxDueOn:
        due === null
          ? t.rentTaxDueOn
          : t.rentTaxDueOn === null || due < t.rentTaxDueOn
            ? due
            : t.rentTaxDueOn,
    });
  }
  for (const l of input.leases) {
    const t = get(l.ownerId);
    totals.set(l.ownerId, {
      ...t,
      leases: t.leases + 1,
      arrearsMinor: t.arrearsMinor + l.figures.arrearsMinor,
      advancesMinor: t.advancesMinor + l.figures.advanceMinor,
      depositsHeldMinor: t.depositsHeldMinor + l.figures.depositHeldMinor,
      withholdingOutstandingMinor:
        t.withholdingOutstandingMinor + l.figures.withholdingOutstandingMinor,
    });
  }
  return [...totals.values()];
}
