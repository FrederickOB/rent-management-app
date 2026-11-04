import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  parseBusinessDate,
  toIsoDate,
  type BusinessDate,
} from '../dates';
import { DomainError } from '../errors';

/**
 * Billing cycles (TL-06). Rent periods are monthly whatever the cycle; invoices bundle them. Rent
 * in Ghana is paid monthly, twice a year, yearly and two years ahead (M4b decision 9); quarterly
 * stays for the leases that use it.
 */
export const RENT_CYCLES = ['monthly', 'quarterly', 'six_monthly', 'annual', 'two_yearly'] as const;
export type RentCycle = (typeof RENT_CYCLES)[number];

export const CYCLE_MONTHS: Record<RentCycle, number> = {
  monthly: 1,
  quarterly: 3,
  six_monthly: 6,
  annual: 12,
  two_yearly: 24,
};

export const RENT_CYCLE_LABELS: Record<RentCycle, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  six_monthly: 'Every six months',
  annual: 'Annually',
  two_yearly: 'Every two years',
};

export const LEASE_USES = ['residential', 'commercial'] as const;
export type LeaseUse = (typeof LEASE_USES)[number];

export const BREAK_PARTIES = ['tenant', 'landlord', 'either'] as const;
export type BreakParty = (typeof BREAK_PARTIES)[number];

/** A change of rent from the start of a rent period (TL-06 escalation schedule). */
export interface RentStep {
  readonly effectiveFrom: string;
  readonly monthlyRentMinor: number;
}

/**
 * A break clause (TL-06). `creditUnusedDays` says whether unused days of the current month are
 * credited on an early exit (prd-issues 36, decided: follow the break clause; none means no).
 */
export interface BreakClause {
  readonly fromDate: string;
  readonly party: BreakParty;
  readonly noticeDays: number;
  readonly creditUnusedDays: boolean;
}

export interface LeaseTermsInput {
  readonly startDate: string;
  readonly endDate: string;
  readonly monthlyRentMinor: number;
  readonly cycle: RentCycle;
  readonly initialAdvanceMonths?: number | null;
  readonly depositMinor?: number | null;
  readonly serviceChargeMonthlyMinor?: number | null;
  readonly steps?: readonly RentStep[];
  readonly breakClause?: BreakClause | null;
  readonly noticeDays: number;
  readonly use: LeaseUse;
}

export interface LeaseTerms {
  readonly startDate: string;
  readonly endDate: string;
  readonly monthlyRentMinor: number;
  readonly cycle: RentCycle;
  readonly initialAdvanceMonths: number | null;
  readonly depositMinor: number | null;
  readonly serviceChargeMonthlyMinor: number | null;
  readonly steps: RentStep[];
  readonly breakClause: BreakClause | null;
  readonly noticeDays: number;
  readonly use: LeaseUse;
  /** Rent periods in the term, a short final one included. */
  readonly periodCount: number;
}

/** A practical ceiling; terms over three years already take the formal-lease path (OQ-44). */
export const MAX_TERM_MONTHS = 600;
export const MAX_NOTICE_DAYS = 3650;

/**
 * The start of rent period `k`, computed from the anchor every time (31 Jan, 28 Feb, 31 Mar…),
 * so a short month never shifts the periods after it (CLAUDE.md section 4).
 */
export function periodStart(start: BusinessDate, k: number): BusinessDate {
  return addMonths(start, k);
}

/** The last day of rent period `k`, before any cut at the lease end. */
export function fullPeriodEnd(start: BusinessDate, k: number): BusinessDate {
  return addDays(periodStart(start, k + 1), -1);
}

/** How many rent periods a term has: whole months, plus a short final period if there is one. */
export function countPeriods(start: BusinessDate, end: BusinessDate): number {
  let k = 0;
  while (compareDates(periodStart(start, k), end) <= 0) {
    k += 1;
    if (k > MAX_TERM_MONTHS)
      throw new DomainError(
        'lease.term_too_long',
        `A lease can run at most ${MAX_TERM_MONTHS / 12} years`,
      );
  }
  return k;
}

const positiveMinor = (value: number, code: string, what: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new DomainError(code, `${what} must be a positive amount in pesewas`);
  return value;
};

const wholeDays = (value: number, code: string, what: string): number => {
  if (!Number.isInteger(value) || value < 0 || value > MAX_NOTICE_DAYS)
    throw new DomainError(code, `${what} must be 0 to ${MAX_NOTICE_DAYS} days`);
  return value;
};

/**
 * Checks and normalises lease terms (TL-06). Dates are business dates; amounts are integer
 * pesewas; every escalation starts on a rent period, so periods never split.
 */
export function checkLeaseTerms(input: LeaseTermsInput): LeaseTerms {
  const start = parseBusinessDate(input.startDate);
  const end = parseBusinessDate(input.endDate);
  if (compareDates(end, start) <= 0)
    throw new DomainError('lease.end_before_start', 'The lease must end after it starts');
  const periods = countPeriods(start, end);
  const monthlyRentMinor = positiveMinor(input.monthlyRentMinor, 'lease.rent_invalid', 'The rent');
  if (!(RENT_CYCLES as readonly string[]).includes(input.cycle))
    throw new DomainError('lease.cycle_invalid', 'Choose a billing cycle');
  const cycleMonths = CYCLE_MONTHS[input.cycle];
  if (cycleMonths > periods)
    throw new DomainError(
      'lease.cycle_longer_than_term',
      'The billing cycle is longer than the lease',
    );

  const advance = input.initialAdvanceMonths ?? null;
  if (
    advance !== null &&
    (!Number.isInteger(advance) || advance < cycleMonths || advance > periods)
  )
    throw new DomainError(
      'lease.advance_invalid',
      `An initial advance covers ${cycleMonths} to ${periods} months for this lease`,
    );

  const deposit = input.depositMinor ?? null;
  if (deposit !== null && (!Number.isSafeInteger(deposit) || deposit < 0))
    throw new DomainError('lease.deposit_invalid', 'The deposit must be an amount in pesewas');
  const serviceCharge =
    input.serviceChargeMonthlyMinor == null
      ? null
      : positiveMinor(
          input.serviceChargeMonthlyMinor,
          'lease.service_charge_invalid',
          'The service charge',
        );

  const steps = [...(input.steps ?? [])].sort((a, b) =>
    a.effectiveFrom.localeCompare(b.effectiveFrom),
  );
  const starts = new Set(
    Array.from({ length: periods }, (_, k) => toIsoDate(periodStart(start, k))),
  );
  let previous = input.startDate;
  for (const step of steps) {
    const from = parseBusinessDate(step.effectiveFrom);
    if (step.effectiveFrom <= previous || !starts.has(toIsoDate(from)))
      throw new DomainError(
        'lease.step_date_invalid',
        'Each rent change starts on a later rent period inside the lease',
      );
    positiveMinor(step.monthlyRentMinor, 'lease.step_rent_invalid', 'The new rent');
    previous = step.effectiveFrom;
  }

  let breakClause: BreakClause | null = null;
  if (input.breakClause) {
    const from = parseBusinessDate(input.breakClause.fromDate);
    if (compareDates(from, start) <= 0 || compareDates(from, end) > 0)
      throw new DomainError('lease.break_date_invalid', 'A break can only start during the lease');
    if (!(BREAK_PARTIES as readonly string[]).includes(input.breakClause.party))
      throw new DomainError('lease.break_party_invalid', 'Say who may break the lease');
    breakClause = {
      fromDate: toIsoDate(from),
      party: input.breakClause.party,
      noticeDays: wholeDays(
        input.breakClause.noticeDays,
        'lease.break_notice_invalid',
        'The break notice',
      ),
      creditUnusedDays: input.breakClause.creditUnusedDays === true,
    };
  }

  if (!(LEASE_USES as readonly string[]).includes(input.use))
    throw new DomainError(
      'lease.use_invalid',
      'Say whether the lease is residential or commercial',
    );

  return {
    startDate: toIsoDate(start),
    endDate: toIsoDate(end),
    monthlyRentMinor,
    cycle: input.cycle,
    initialAdvanceMonths: advance,
    depositMinor: deposit === 0 ? null : deposit,
    serviceChargeMonthlyMinor: serviceCharge,
    steps: steps.map((s) => ({
      effectiveFrom: s.effectiveFrom,
      monthlyRentMinor: s.monthlyRentMinor,
    })),
    breakClause,
    noticeDays: wholeDays(input.noticeDays, 'lease.notice_invalid', 'The notice period'),
    use: input.use,
    periodCount: periods,
  };
}

/** The monthly rent in force on a date: the last step on or before it, or the base rent. */
export function rentOn(
  terms: Pick<LeaseTerms, 'monthlyRentMinor' | 'steps'>,
  date: string,
): number {
  let rent = terms.monthlyRentMinor;
  for (const step of terms.steps) if (step.effectiveFrom <= date) rent = step.monthlyRentMinor;
  return rent;
}

/** The whole term in months, rounded up: what the advance rules and the formal-lease rule read. */
export function termMonths(terms: Pick<LeaseTerms, 'periodCount'>): number {
  return terms.periodCount;
}

/** A term exactly: whole rent periods (months anchored on the start), then the days left. */
export interface TermLength {
  readonly months: number;
  readonly days: number;
}

/**
 * The exact length of a term from its first to its last day, both included: the whole months
 * counted from the start as the rent periods are (31 January, 28 February...), then the days
 * after the last whole month. 1 November to 6 November a year later is 12 months and 6 days.
 */
export function termLength(startDate: string, endDate: string): TermLength {
  const start = parseBusinessDate(startDate);
  const end = parseBusinessDate(endDate);
  if (compareDates(end, start) < 0)
    throw new DomainError('lease.end_before_start', 'The lease must end after it starts');
  let months = 0;
  while (compareDates(fullPeriodEnd(start, months), end) <= 0) {
    months += 1;
    if (months > MAX_TERM_MONTHS)
      throw new DomainError(
        'lease.term_too_long',
        `A lease can run at most ${MAX_TERM_MONTHS / 12} years`,
      );
  }
  return { months, days: daysBetween(periodStart(start, months), end) + 1 };
}

/** A term in words for documents: "12 months", "12 months and 6 days", "20 days". */
export function formatTerm(term: TermLength): string {
  const parts = [
    term.months > 0 ? `${term.months} month${term.months === 1 ? '' : 's'}` : null,
    term.days > 0 ? `${term.days} day${term.days === 1 ? '' : 's'}` : null,
  ].filter((p): p is string => p !== null);
  return parts.join(' and ');
}
