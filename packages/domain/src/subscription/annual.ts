import { taxLinesOn } from '../billing/invoicing';
import { DomainError } from '../errors';
import { add, money, multiplyFraction } from '../money/money';
import {
  checkVatRates,
  compareMonths,
  monthBounds,
  shiftMonth,
  type SubscriptionVatRates,
} from './pricing';

/**
 * Annual prepayment (M10 decision 7; PB-05). The landlord buys 12 months up front; the money sits
 * as prepaid credit (2020). Each month's invoice, at the discounted rates while the term runs, is
 * settled from the credit first; a shortfall is billed as usual, and credit left at the end of the
 * term carries forward.
 */

export const ANNUAL_TERM_MONTHS = 12;
const BPS_WHOLE = 10_000;

function nonNegative(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new DomainError('subscription.bad_amount', `${what} must be zero or more pesewas`);
  return value;
}

/**
 * 12 months up front: 12 × the monthly net less the annual discount (rounded once), floored at 12
 * × the minimum (never discounted); VAT and levies on top when charged.
 */
export function annualPrice(input: {
  readonly monthlyNetMinor: number;
  readonly minimumMinor: number;
  readonly annualDiscountBps: number;
  readonly vat: SubscriptionVatRates | null;
}): { netMinor: number; vatMinor: number; totalMinor: number } {
  const monthly = nonNegative(input.monthlyNetMinor, 'The monthly net');
  const minimum = nonNegative(input.minimumMinor, 'The minimum');
  const bps = input.annualDiscountBps;
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > BPS_WHOLE)
    throw new DomainError(
      'subscription.bad_rate',
      'The annual discount must be whole basis points from 0 to 10,000',
    );
  const discounted = multiplyFraction(
    money(monthly),
    [ANNUAL_TERM_MONTHS, BPS_WHOLE - bps],
    [BPS_WHOLE],
  ).amountMinor;
  const floor = multiplyFraction(money(minimum), [ANNUAL_TERM_MONTHS], []).amountMinor;
  const netMinor = Math.max(discounted, floor);
  const vatMinor =
    input.vat === null
      ? 0
      : taxLinesOn(netMinor, checkVatRates(input.vat)).reduce(
          (total, tax) => add(money(total), money(tax.amountMinor)).amountMinor,
          0,
        );
  return { netMinor, vatMinor, totalMinor: add(money(netMinor), money(vatMinor)).amountMinor };
}

/** The term: 12 billing months starting with `startMonth` (the month of purchase). */
export function annualTerm(startMonth: string): {
  startsOn: string;
  endsOn: string;
  firstMonth: string;
  lastMonth: string;
} {
  const lastMonth = shiftMonth(startMonth, ANNUAL_TERM_MONTHS - 1);
  return {
    startsOn: monthBounds(startMonth).first,
    endsOn: monthBounds(lastMonth).last,
    firstMonth: startMonth,
    lastMonth,
  };
}

export function inAnnualTerm(
  term: { readonly firstMonth: string; readonly lastMonth: string } | null,
  month: string,
): boolean {
  if (term === null) return false;
  return compareMonths(month, term.firstMonth) >= 0 && compareMonths(month, term.lastMonth) <= 0;
}

/** Each invoice draws on prepaid credit (2020) first; the shortfall stays owed. */
export function prepaidDraw(
  creditMinor: number,
  invoiceTotalMinor: number,
): { drawMinor: number; shortfallMinor: number; creditLeftMinor: number } {
  const credit = nonNegative(creditMinor, 'Prepaid credit');
  const total = nonNegative(invoiceTotalMinor, 'The invoice total');
  const drawMinor = Math.min(credit, total);
  return { drawMinor, shortfallMinor: total - drawMinor, creditLeftMinor: credit - drawMinor };
}
