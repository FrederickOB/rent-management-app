import { addDays, addMonths, compareDates, parseBusinessDate, toIsoDate } from '../dates';
import { DomainError } from '../errors';
import { money, multiplyRatio } from '../money/money';

/**
 * Building blocks for reports, dashboards and the Gate 1 metrics (M9 plan decisions 9 to 12):
 * shares as exact ratios, percentiles by nearest rank, and the reporting month.
 */

/**
 * A share: what was counted and out of what. `bps` is the share in basis points (95% = 9,500),
 * rounded half up once through packages/domain/money; null when there was nothing to measure, so
 * an empty month is never shown as 0% or 100%.
 */
export interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
  readonly bps: number | null;
}

const BPS_WHOLE = 10_000;

export function ratioOf(numerator: number, denominator: number): Ratio {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator < 0 ||
    denominator < 0
  )
    throw new DomainError('report.bad_ratio', 'A share counts whole amounts of zero or more');
  return {
    numerator,
    denominator,
    bps:
      denominator === 0
        ? null
        : multiplyRatio(money(BPS_WHOLE), numerator, denominator).amountMinor,
  };
}

/**
 * The nearest-rank percentile (1 to 100) of whole numbers: the smallest value with at least that
 * share of the values at or below it. Always one of the values, so no average and no rounding.
 * Null for no values.
 */
export function percentileOf(values: readonly number[], percentile: number): number | null {
  if (!Number.isInteger(percentile) || percentile < 1 || percentile > 100)
    throw new DomainError('report.bad_percentile', 'A percentile is a whole number from 1 to 100');
  if (values.length === 0) return null;
  for (const v of values)
    if (!Number.isSafeInteger(v))
      throw new DomainError('report.bad_value', 'Percentiles are taken of whole numbers');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentile * sorted.length) / 100);
  return sorted[Math.max(1, rank) - 1] as number;
}

/** The median by nearest rank: for an even count, the lower of the two middle values. */
export const medianOf = (values: readonly number[]): number | null => percentileOf(values, 50);

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface ReportMonth {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly firstDay: string;
  readonly lastDay: string;
}

/** A calendar month of business dates in the company's time zone (decision 5). */
export function reportMonth(month: string): ReportMonth {
  if (!MONTH.test(month)) throw new DomainError('report.bad_month', `Not a month: ${month}`);
  const first = parseBusinessDate(`${month}-01`);
  return {
    month,
    firstDay: toIsoDate(first),
    lastDay: toIsoDate(addDays(addMonths(first, 1), -1)),
  };
}

/** Whether a business date falls within the month. */
export function inReportMonth(date: string, month: ReportMonth): boolean {
  const day = parseBusinessDate(date);
  return (
    compareDates(parseBusinessDate(month.firstDay), day) <= 0 &&
    compareDates(day, parseBusinessDate(month.lastDay)) <= 0
  );
}
