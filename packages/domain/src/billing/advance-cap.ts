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
