import { daysBetween, parseBusinessDate } from '../dates';
import { DomainError } from '../errors';
import { money, multiplyRatio } from '../money/money';
import type { PaymentAmount } from '../ledger/posting';
import {
  inAllocationOrder,
  isRecurring,
  lineBalance,
  postingClassOf,
  type AllocationRow,
  type BillingLine,
  type CreditPool,
} from './lines';

/**
 * Early termination (AR-04, P13; M5 plan 5.4). Lines of periods after the end are already
 * cancelled (M4a), so their money is back in credit. Then, in order: agreed termination charges
 * (P01), the unused days of the current month credited where the break clause allows (P27; none
 * means no, prd-issues 36), the credit applied to open lines oldest first, and a positive
 * remainder, less approved deductions, refunded with two-person approval.
 */
export interface UnusedDaysCredit {
  readonly lineId: string;
  readonly unusedDays: number;
  readonly periodDays: number;
  readonly creditMinor: number;
}

/** The unused days of the month the tenancy ends in, for each of its recurring lines. */
export function unusedDaysCredits(
  lines: readonly BillingLine[],
  allocations: readonly AllocationRow[],
  lastDay: string,
): UnusedDaysCredit[] {
  const end = parseBusinessDate(lastDay);
  const credits: UnusedDaysCredit[] = [];
  for (const line of lines) {
    if (!isRecurring(line.kind) || !line.periodStart || !line.periodEnd) continue;
    if (!(line.periodStart <= lastDay && lastDay < line.periodEnd)) continue;
    const periodDays =
      daysBetween(parseBusinessDate(line.periodStart), parseBusinessDate(line.periodEnd)) + 1;
    const unusedDays = daysBetween(end, parseBusinessDate(line.periodEnd));
    const { netMinor, writtenOffMinor } = lineBalance(line, allocations);
    const creditMinor = Math.min(
      multiplyRatio(money(netMinor), unusedDays, periodDays).amountMinor,
      netMinor - writtenOffMinor,
    );
    if (creditMinor > 0) credits.push({ lineId: line.id, unusedDays, periodDays, creditMinor });
  }
  return credits;
}

export interface CreditApplication {
  readonly lineId: string;
  readonly draws: readonly PaymentAmount[];
}

/**
 * P13 apply: the lease's credit pays its open charged lines, oldest debt first, each draw taken
 * first in, first out by payment. Lines not yet charged are not paid this way: after an early
 * end none are left.
 */
export function applyCreditToOpenLines(
  lines: readonly BillingLine[],
  allocations: readonly AllocationRow[],
  pools: readonly CreditPool[],
): { readonly applications: readonly CreditApplication[]; readonly creditLeftMinor: number } {
  const credit = pools.map((p) => ({ ...p }));
  let index = 0;
  const applications: CreditApplication[] = [];
  for (const line of inAllocationOrder(lines)) {
    if (postingClassOf(line) !== 'receivable') continue;
    let need = lineBalance(line, allocations).outstandingMinor;
    const draws: PaymentAmount[] = [];
    while (need > 0 && index < credit.length) {
      const pool = credit[index] as { paymentId: string; amountMinor: number };
      const amount = Math.min(pool.amountMinor, need);
      draws.push({ paymentId: pool.paymentId, amountMinor: amount });
      pool.amountMinor -= amount;
      need -= amount;
      if (pool.amountMinor === 0) index += 1;
    }
    if (draws.length > 0) applications.push({ lineId: line.id, draws });
  }
  return {
    applications,
    creditLeftMinor: credit.slice(index).reduce((sum, p) => sum + p.amountMinor, 0),
  };
}

/** The refund: what credit is left after open lines, less deductions approved on the request. */
export function refundDue(creditLeftMinor: number, deductionsMinor: number): number {
  if (!Number.isSafeInteger(deductionsMinor) || deductionsMinor < 0)
    throw new DomainError('termination.bad_deductions', 'Deductions are zero or more');
  if (deductionsMinor > creditLeftMinor)
    throw new DomainError(
      'termination.deductions_too_large',
      'Deductions cannot exceed what is left to refund',
    );
  return creditLeftMinor - deductionsMinor;
}

/**
 * P13 refund approved (AR-04, decision 6): the credit left becomes a refund payable payment by
 * payment, first in, first out. Each payment's share reduces its credit (the engine records it).
 */
export function refundCredits(
  pools: readonly { readonly paymentId: string; readonly amountMinor: number }[],
  amountMinor: number,
): PaymentAmount[] {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
    throw new DomainError('termination.bad_refund', 'A refund is an amount above zero');
  const credits: PaymentAmount[] = [];
  let need = amountMinor;
  for (const pool of pools) {
    if (need === 0) break;
    const take = Math.min(pool.amountMinor, need);
    if (take <= 0) continue;
    credits.push({ paymentId: pool.paymentId, amountMinor: take });
    need -= take;
  }
  if (need > 0)
    throw new DomainError(
      'termination.refund_over_credit',
      'The lease no longer holds this much credit to refund',
    );
  return credits;
}
