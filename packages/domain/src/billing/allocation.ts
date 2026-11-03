import { DomainError } from '../errors';
import type { AllocationPosting, LeaseDimensions, PaymentAmount } from '../ledger/posting';
import {
  inAllocationOrder,
  lineBalance,
  chargedFrom,
  paymentShares,
  postingClassAt,
  type AllocationRow,
  type BillingLine,
  type CreditPool,
} from './lines';

/** A new allocation row a plan asks the caller to write. */
export interface PlannedAllocation {
  readonly lineId: string;
  readonly paymentId: string | null;
  readonly amountMinor: number;
}

export interface AllocationPlan {
  readonly allocations: readonly PlannedAllocation[];
  /** What is left: the payment's credit, held in prepayments (BC-07). */
  readonly surplusMinor: number;
  /** The same allocations, as the ledger posts them (P03), classified as of the value date. */
  readonly postings: readonly AllocationPosting[];
  /**
   * Allocations to periods that had not started on the value date but have accrued since: the
   * receipt holds them in prepayments as an advance, and each is drawn at once (P02's 2010 part,
   * dated at the period start), so balances are right as of every date.
   */
  readonly lateDraws: readonly LateDraw[];
}

/** One late draw: Dr 2010 and Cr 1100 on the line, for the payment, at the period start. */
export interface LateDraw {
  readonly lineId: string;
  readonly paymentId: string;
  readonly amountMinor: number;
  readonly valueDate: string;
}

/**
 * Allocates a payment to a lease's open lines, oldest debt first (BC-07). The caller accrues
 * every started line first (M4a plan 4.5, step 3), so a line is always income before it is paid:
 * a started line still waiting for accrual is refused here. No line receives more than it owes.
 */
export function planAllocation(input: {
  readonly lines: readonly BillingLine[];
  readonly allocations: readonly AllocationRow[];
  readonly paymentId: string;
  readonly amountMinor: number;
  readonly lease: LeaseDimensions;
  /** The value date: lines whose period has started by then must be accrued. */
  readonly valueDate: string;
  /** The lease's last billable day (a move-out): periods after it are not owed and take nothing. */
  readonly lastDay?: string | null;
}): AllocationPlan {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new DomainError('billing.bad_amount', 'A payment must be a positive amount');
  const lastDay = input.lastDay ?? null;
  const after = (l: BillingLine) =>
    lastDay !== null && l.periodStart !== null && !l.accrued && l.periodStart > lastDay;
  const dropped = new Set(input.lines.filter(after).map((l) => l.id));
  const lines = input.lines.filter(
    (l) => !dropped.has(l.id) && !(l.baseLineId !== null && dropped.has(l.baseLineId)),
  );
  const waiting = lines.find(
    (l) => !l.accrued && l.periodStart !== null && l.periodStart <= input.valueDate,
  );
  if (waiting)
    throw new DomainError('billing.accrue_first', `Line ${waiting.id} must be accrued first`);
  let remaining = input.amountMinor;
  const allocations: PlannedAllocation[] = [];
  const postings: AllocationPosting[] = [];
  const lateDraws: LateDraw[] = [];
  for (const line of inAllocationOrder(lines)) {
    if (remaining === 0) break;
    const { outstandingMinor } = lineBalance(line, input.allocations);
    if (outstandingMinor === 0) continue;
    const amount = Math.min(outstandingMinor, remaining);
    remaining -= amount;
    allocations.push({ lineId: line.id, paymentId: input.paymentId, amountMinor: amount });
    const postingClass = postingClassAt(line, input.valueDate);
    postings.push({
      lease: input.lease,
      invoiceLineId: line.id,
      postingClass,
      amountMinor: amount,
    });
    // Owed now, but not yet on the day the money arrived: drawn on the day it became owed.
    const owedFrom = chargedFrom(line);
    if (postingClass === 'prepayment' && owedFrom !== null)
      lateDraws.push({
        lineId: line.id,
        paymentId: input.paymentId,
        amountMinor: amount,
        valueDate: owedFrom,
      });
  }
  return { allocations, surplusMinor: remaining, postings, lateDraws };
}

export interface AccrualPlan {
  /** What becomes income: the line after credit notes. Zero means nothing posts. */
  readonly amountMinor: number;
  /** Payments that paid the line before it started (its advance allocations, kept). */
  readonly advance: readonly PaymentAmount[];
  /** Credit drawn now, first in, first out by payment: each is a new allocation row. */
  readonly draws: readonly PaymentAmount[];
  /** What the tenant now owes on it (1100). */
  readonly owedMinor: number;
}

/**
 * P02 for one line, as its period starts (AR-01; architecture section 6). The line first uses
 * its own advance allocations, then the lease's credit, oldest payment first, and the rest is
 * owed. `pools` is the lease's credit before this line; the caller reduces it by the draws.
 */
export function planAccrual(
  line: BillingLine,
  allocations: readonly AllocationRow[],
  pools: readonly CreditPool[],
): AccrualPlan {
  if (line.accrued)
    throw new DomainError('billing.already_accrued', `Line ${line.id} is already accrued`);
  if (line.periodStart === null)
    throw new DomainError('billing.not_recurring', `Line ${line.id} is not a charge period`);
  const balance = lineBalance(line, allocations);
  const advance = [...paymentShares(line.id, allocations)].map(([paymentId, amountMinor]) => ({
    paymentId,
    amountMinor,
  }));
  const advanceTotal = advance.reduce((sum, a) => sum + a.amountMinor, 0);
  // M5 decision 8: tax a tenant withheld on a month not yet started is held as its advance too
  // (source `withholding`); the engine draws it on its own key when the month starts.
  const withheld = withheldOn(line.id, allocations);
  if (advanceTotal + withheld !== balance.settledMinor || balance.writtenOffMinor !== 0)
    throw new DomainError(
      'billing.unexpected_allocation',
      `Line ${line.id} has allocations a line not yet started cannot have`,
    );
  let need = balance.outstandingMinor;
  const draws: PaymentAmount[] = [];
  for (const pool of pools) {
    if (need === 0) break;
    const amount = Math.min(pool.amountMinor, need);
    if (amount <= 0) continue;
    draws.push({ paymentId: pool.paymentId, amountMinor: amount });
    need -= amount;
  }
  return { amountMinor: balance.netMinor, advance, draws, owedMinor: need };
}

/** Tax a tenant withheld on a line (TX-04, P19): allocations of source `withholding`, net. */
export function withheldOn(lineId: string, allocations: readonly AllocationRow[]): number {
  let total = 0;
  for (const a of allocations)
    if (a.lineId === lineId && a.source === 'withholding') total += a.amountMinor;
  return total;
}

/** Pools after some draws: the next line's starting credit. */
export function drawFromPools(
  pools: readonly CreditPool[],
  draws: readonly PaymentAmount[],
): CreditPool[] {
  const taken = new Map<string, number>();
  for (const d of draws) taken.set(d.paymentId, (taken.get(d.paymentId) ?? 0) + d.amountMinor);
  return pools
    .map((p) => ({ ...p, amountMinor: p.amountMinor - (taken.get(p.paymentId) ?? 0) }))
    .filter((p) => {
      if (p.amountMinor < 0)
        throw new DomainError('billing.pool_overdrawn', `Payment ${p.paymentId} is overdrawn`);
      return p.amountMinor > 0;
    });
}

/**
 * P02 for a line's VAT and levy lines (review 10): once the base line has drawn what it needs,
 * the credit left pays its tax lines too, first in, first out by payment. `pools` is the credit
 * after the base line's draws; the caller reduces it by these draws.
 */
export function planTaxDraws(
  taxLines: readonly BillingLine[],
  allocations: readonly AllocationRow[],
  pools: readonly CreditPool[],
): { readonly lineId: string; readonly draws: readonly PaymentAmount[] }[] {
  let left = pools;
  const out: { lineId: string; draws: PaymentAmount[] }[] = [];
  for (const tax of taxLines) {
    let need = lineBalance(tax, allocations).outstandingMinor;
    const draws: PaymentAmount[] = [];
    for (const pool of left) {
      if (need === 0) break;
      const amount = Math.min(pool.amountMinor, need);
      if (amount <= 0) continue;
      draws.push({ paymentId: pool.paymentId, amountMinor: amount });
      need -= amount;
    }
    if (draws.length > 0) {
      out.push({ lineId: tax.id, draws });
      left = drawFromPools(left, draws);
    }
  }
  return out;
}

/**
 * Credit to debt a correction reopened (M4b review F4). A payment reversed, or money released by
 * a credit note, can leave a rent or service-charge period that has accrued owing while the lease
 * still holds credit from other payments. That credit pays it at once, as P02 draws it when a
 * period starts: in allocation order, oldest payment first, each line's VAT and levies straight
 * after it. Deposits and one-off charges are not drawn (as at accrual). `pools` is the lease's
 * credit now; each plan is a credit draw (Dr 2010, Cr 1100) with its new allocation rows.
 */
export function planReopenedDraws(
  lines: readonly BillingLine[],
  allocations: readonly AllocationRow[],
  pools: readonly CreditPool[],
): { readonly lineId: string; readonly draws: readonly PaymentAmount[] }[] {
  const drawn = (line: BillingLine) =>
    line.accrued && line.periodStart !== null && line.baseLineId === null;
  const base = new Map(lines.map((l) => [l.id, l]));
  let left = pools.filter((p) => p.amountMinor > 0);
  const out: { lineId: string; draws: PaymentAmount[] }[] = [];
  for (const line of inAllocationOrder(lines)) {
    if (left.length === 0) break;
    const parent = line.baseLineId === null ? line : base.get(line.baseLineId);
    if (!parent || !drawn(parent)) continue;
    let need = lineBalance(line, allocations).outstandingMinor;
    if (need <= 0) continue;
    const draws: PaymentAmount[] = [];
    for (const pool of left) {
      if (need === 0) break;
      const amount = Math.min(pool.amountMinor, need);
      if (amount <= 0) continue;
      draws.push({ paymentId: pool.paymentId, amountMinor: amount });
      need -= amount;
    }
    if (draws.length > 0) {
      out.push({ lineId: line.id, draws });
      left = drawFromPools(left, draws);
    }
  }
  return out;
}
