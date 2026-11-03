import { compareDates, daysBetween, parseBusinessDate, toIsoDate } from '../dates';
import { money, multiplyRatio } from '../money/money';
import { fullPeriodEnd, periodStart, rentOn, type LeaseTerms } from './lease-terms';

export type ChargeType = 'rent' | 'service_charge';

/** One row of the rent schedule (architecture 3.3, `charge_period`). */
export interface ChargePeriod {
  /** Rent period number from 0, anchored on the lease start. */
  readonly sequence: number;
  readonly chargeType: ChargeType;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly amountMinor: number;
  /** A short final period, charged by the day. */
  readonly prorated: boolean;
}

/**
 * The rent schedule (TL-06; CLAUDE.md section 4): one row per month and charge type, anchored on
 * the lease start whatever the billing cycle. Only a short final period is prorated, by days,
 * rounded half up once in packages/domain/money. Escalation steps apply from their period.
 */
export function rentSchedule(terms: LeaseTerms): ChargePeriod[] {
  const start = parseBusinessDate(terms.startDate);
  const end = parseBusinessDate(terms.endDate);
  const rows: ChargePeriod[] = [];
  for (let k = 0; k < terms.periodCount; k += 1) {
    const from = periodStart(start, k);
    const fullEnd = fullPeriodEnd(start, k);
    const to = compareDates(fullEnd, end) > 0 ? end : fullEnd;
    const prorated = compareDates(to, fullEnd) < 0;
    const used = daysBetween(from, to) + 1;
    const length = daysBetween(from, fullEnd) + 1;
    const charge = (monthly: number) =>
      prorated ? multiplyRatio(money(monthly), used, length).amountMinor : monthly;
    const period = {
      sequence: k,
      periodStart: toIsoDate(from),
      periodEnd: toIsoDate(to),
      prorated,
    };
    rows.push({
      ...period,
      chargeType: 'rent',
      amountMinor: charge(rentOn(terms, toIsoDate(from))),
    });
    if (terms.serviceChargeMonthlyMinor)
      rows.push({
        ...period,
        chargeType: 'service_charge',
        amountMinor: charge(terms.serviceChargeMonthlyMinor),
      });
  }
  return rows;
}

/**
 * The next month of a tenancy held over after its end date (OQ-12: the tenant holds month to
 * month on the original terms, at the last rate, with no surcharge). Anchored on the original
 * start, so it continues the schedule exactly.
 */
export function holdingOverPeriods(terms: LeaseTerms, sequence: number): ChargePeriod[] {
  const start = parseBusinessDate(terms.startDate);
  const from = periodStart(start, sequence);
  const to = fullPeriodEnd(start, sequence);
  const lastRent = rentOn(terms, terms.endDate);
  const period = {
    sequence,
    periodStart: toIsoDate(from),
    periodEnd: toIsoDate(to),
    prorated: false,
  };
  const rows: ChargePeriod[] = [{ ...period, chargeType: 'rent', amountMinor: lastRent }];
  if (terms.serviceChargeMonthlyMinor)
    rows.push({
      ...period,
      chargeType: 'service_charge',
      amountMinor: terms.serviceChargeMonthlyMinor,
    });
  return rows;
}
