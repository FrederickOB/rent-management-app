import { lineBalance, type AllocationRow, type BillingLine } from './lines';
import type { WalkResult } from './walk';

/**
 * Months paid ahead and the advance cap (AR-05; M5 plan 5.5, decision 4). Every payment records
 * how many whole months beyond the current one the lease is paid for, from the forward walk. The
 * product never calls an advance compliant; it only says whether a limit is exceeded.
 */

/** Whole months fully covered, in the unbroken run, that start after `valueDate`. */
export function monthsPaidAhead(walk: WalkResult, valueDate: string): number {
  if (walk.paidUntil === null) return 0;
  const starts = new Set<string>();
  for (const line of walk.lines)
    if (line.periodStart > valueDate && line.periodEnd <= walk.paidUntil)
      starts.add(line.periodStart);
  return starts.size;
}

/**
 * Under `block`, the most a payment may be so that it pays no more than `limitMonths` ahead:
 * what is still needed on every recurring line of the months up to that limit, plus what is due
 * now on other lines (deposits, one-off charges, VAT). The walk is the lease's, before the payment.
 */
export function maxPaymentWithinCap(input: {
  readonly walk: WalkResult;
  readonly valueDate: string;
  readonly limitMonths: number;
  /** Outstanding on lines outside the walk (deposits, one-off charges, VAT) due by now. */
  readonly otherDueMinor: number;
}): number {
  const months = [...new Set(input.walk.lines.map((l) => l.periodStart))].sort();
  const ahead = months.filter((m) => m > input.valueDate).slice(0, Math.max(0, input.limitMonths));
  const cutoff = ahead.length > 0 ? (ahead[ahead.length - 1] as string) : input.valueDate;
  const recurring = input.walk.lines
    .filter((l) => l.periodStart <= cutoff)
    .reduce((sum, l) => sum + l.remainingMinor, 0);
  return recurring + input.otherDueMinor;
}

/**
 * The most one payment may be under `block` (AR-05, decision 4), the same on every path: the pay
 * page, cash and transfers (M5 review 9). The limit counts months of rent (and service charge)
 * paid ahead; VAT and levies are not rent, so they never use it up, but each month's VAT and
 * levies are paid with it (M4b decision 9), so the most includes the VAT of the months up to the
 * limit. Plus what is due by the payment's date on lines outside the walk (deposits, one-off
 * charges). The walk is the lease's before the payment, so credit the tenant holds counts.
 */
export function advancePaymentCapMinor(input: {
  readonly lines: readonly BillingLine[];
  readonly allocations: readonly AllocationRow[];
  readonly walk: WalkResult;
  readonly valueDate: string;
  readonly limitMonths: number;
}): number {
  const walked = new Set(input.walk.lines.flatMap((l) => (l.lineId ? [l.lineId] : [])));
  const otherDueMinor = input.lines
    .filter((l) => !walked.has(l.id) && l.dueDate <= input.valueDate)
    .reduce((sum, l) => sum + lineBalance(l, input.allocations).outstandingMinor, 0);
  return maxPaymentWithinCap({
    walk: input.walk,
    valueDate: input.valueDate,
    limitMonths: input.limitMonths,
    otherDueMinor,
  });
}
