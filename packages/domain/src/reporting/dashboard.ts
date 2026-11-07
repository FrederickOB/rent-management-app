import {
  lineBalance,
  postingClassOf,
  type AllocationRow,
  type BillingLine,
} from '../billing/lines';
import { AGE_BUCKETS, ageBucket, type AgeBucket } from '../billing/walk';
import { compareDates, parseBusinessDate } from '../dates';
import { DomainError } from '../errors';
import { DISPLAY_STATUSES, type DisplayStatus } from '../portfolio/status';
import { rentOn, type RentStep } from '../tenancy/lease-terms';
import { medianOf, ratioOf, type Ratio } from './measures';

/**
 * Dashboard measures (DA-01; M9 plan decision 12; prd-issues 32). The rollup stores a snapshot per
 * lease and unit; these functions turn the snapshot rows, or live rows, into the figures shown.
 */

// Occupancy.

/** Units by the one status shown for each (PR-06): occupied, reserved, under repair, not lettable or vacant. */
export type OccupancyCounts = Partial<Readonly<Record<DisplayStatus, number>>>;

export interface OccupancySummary {
  readonly units: number;
  /** Every unit except those marked not lettable. */
  readonly lettable: number;
  /** Units with an occupying lease (active, ending or holding over), under repair or not. */
  readonly occupied: number;
  /** Lettable units with no occupying lease: available, reserved or under repair. */
  readonly vacant: number;
  readonly available: number;
  readonly reserved: number;
  /** Vacant units under repair (an occupied unit under repair is occupied). */
  readonly underRepair: number;
  readonly notLettable: number;
  /** Occupied against lettable (decision 12). */
  readonly rate: Ratio;
}

export function occupancyOf(counts: OccupancyCounts): OccupancySummary {
  const n = (status: DisplayStatus): number => {
    const value = counts[status] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0)
      throw new DomainError('report.bad_count', 'Unit counts are whole numbers of zero or more');
    return value;
  };
  for (const key of Object.keys(counts))
    if (!(DISPLAY_STATUSES as readonly string[]).includes(key))
      throw new DomainError('report.bad_status', `Not a unit status: ${key}`);
  const occupied = n('occupied');
  const available = n('vacant');
  const reserved = n('reserved');
  const underRepair = n('under_repair');
  const notLettable = n('not_lettable');
  const vacant = available + reserved + underRepair;
  return {
    units: occupied + vacant + notLettable,
    lettable: occupied + vacant,
    occupied,
    vacant,
    available,
    reserved,
    underRepair,
    notLettable,
    rate: ratioOf(occupied, occupied + vacant),
  };
}

/** Counts units by their shown status, for `occupancyOf`. */
export function countByStatus(
  units: readonly { readonly status: DisplayStatus }[],
): OccupancyCounts {
  const counts: Partial<Record<DisplayStatus, number>> = {};
  for (const u of units) counts[u.status] = (counts[u.status] ?? 0) + 1;
  return counts;
}

/** Adds occupancy counts, for a portfolio or a statement's summary page. */
export function addOccupancy(all: readonly OccupancyCounts[]): OccupancyCounts {
  const total: Partial<Record<DisplayStatus, number>> = {};
  for (const counts of all)
    for (const status of DISPLAY_STATUSES)
      if (counts[status] !== undefined)
        total[status] = (total[status] ?? 0) + (counts[status] ?? 0);
  return total;
}

// Rent roll.

/** A lease as the rent roll reads it. */
export interface RentRollLease {
  readonly leaseId: string;
  readonly startDate: string;
  /** The last day it occupied the unit (an end, a move-out, a termination); null while it does. */
  readonly lastDay: string | null;
  readonly monthlyRentMinor: number;
  readonly steps?: readonly RentStep[];
  readonly serviceChargeMonthlyMinor?: number | null;
}

export interface RentRoll {
  readonly asOf: string;
  readonly leases: readonly {
    readonly leaseId: string;
    readonly rentMinor: number;
    readonly serviceChargeMinor: number;
  }[];
  readonly rentMinor: number;
  readonly serviceChargeMinor: number;
  readonly totalMinor: number;
}

/** Whether a lease occupied its unit on a business date: started by then, and not ended before it. */
export function leaseActiveOn(
  lease: Pick<RentRollLease, 'startDate' | 'lastDay'>,
  date: string,
): boolean {
  const day = parseBusinessDate(date);
  return (
    compareDates(parseBusinessDate(lease.startDate), day) <= 0 &&
    (lease.lastDay === null || compareDates(day, parseBusinessDate(lease.lastDay)) <= 0)
  );
}

/**
 * Decision 12: the monthly equivalent of the leases active on a date. Rent periods are monthly
 * whatever the billing cycle (TL-06), so it is the monthly rent in force that day, with any
 * escalation step that has taken effect, plus the monthly service charge. Nothing is divided, so
 * nothing is rounded. Leases in lease-id order.
 */
export function rentRoll(leases: readonly RentRollLease[], asOf: string): RentRoll {
  parseBusinessDate(asOf);
  const rows = leases
    .filter((lease) => leaseActiveOn(lease, asOf))
    .map((lease) => {
      const rentMinor = rentOn(
        { monthlyRentMinor: lease.monthlyRentMinor, steps: [...(lease.steps ?? [])] },
        asOf,
      );
      const serviceChargeMinor = lease.serviceChargeMonthlyMinor ?? 0;
      for (const amount of [rentMinor, serviceChargeMinor])
        if (!Number.isSafeInteger(amount) || amount < 0)
          throw new DomainError('report.bad_amount', 'Rent is a whole number of pesewas');
      return { leaseId: lease.leaseId, rentMinor, serviceChargeMinor };
    })
    .sort((a, b) => (a.leaseId < b.leaseId ? -1 : a.leaseId > b.leaseId ? 1 : 0));
  const rentMinor = rows.reduce((sum, r) => sum + r.rentMinor, 0);
  const serviceChargeMinor = rows.reduce((sum, r) => sum + r.serviceChargeMinor, 0);
  return {
    asOf,
    leases: rows,
    rentMinor,
    serviceChargeMinor,
    totalMinor: rentMinor + serviceChargeMinor,
  };
}

// Paid-until coverage (prd-issues 32).

/** An occupied unit's lease, from the snapshot: its paid-until and whole months paid ahead (AR-02, AR-05). */
export interface CoverageUnit {
  readonly unitId: string;
  /** The last day of the last month fully covered, or null when none is. */
  readonly paidUntil: string | null;
  /** Whole months fully covered that start after the day (billing's `monthsPaidAhead`). */
  readonly monthsPaidAhead: number;
}

export interface PaidUntilCoverage {
  readonly occupied: number;
  readonly covered: number;
  /** Occupied units paid until the day or later, against all occupied units. */
  readonly rate: Ratio;
  /** By nearest rank across every occupied unit; a unit not paid ahead counts as zero. */
  readonly medianMonthsPaidAhead: number | null;
}

/** prd-issues 32: the share of occupied units paid until today or later, and the median months paid ahead. */
export function paidUntilCoverage(input: {
  readonly units: readonly CoverageUnit[];
  readonly today: string;
}): PaidUntilCoverage {
  const today = parseBusinessDate(input.today);
  const seen = new Set<string>();
  let covered = 0;
  for (const unit of input.units) {
    if (seen.has(unit.unitId))
      throw new DomainError('report.duplicate_unit', `Unit ${unit.unitId} is listed twice`);
    seen.add(unit.unitId);
    if (!Number.isSafeInteger(unit.monthsPaidAhead) || unit.monthsPaidAhead < 0)
      throw new DomainError('report.bad_months', 'Months paid ahead are zero or more');
    if (unit.paidUntil !== null && compareDates(parseBusinessDate(unit.paidUntil), today) >= 0)
      covered += 1;
  }
  return {
    occupied: input.units.length,
    covered,
    rate: ratioOf(covered, input.units.length),
    medianMonthsPaidAhead: medianOf(input.units.map((u) => u.monthsPaidAhead)),
  };
}

// Arrears as the ledger holds them (M9 review: the dashboard counts them as the statement does).

export interface LedgerArrears {
  /** Earned and unpaid (1100) past its due date, by days past due (BC-08). */
  readonly byBucket: Readonly<Record<AgeBucket, number>>;
  readonly totalMinor: number;
  /**
   * Billed and past due but not charged yet, so not owed in the ledger: an annual invoice's months
   * not started (or a month P02 has not reached yet), what is unpaid on them by their allocations.
   * Credit not applied to them yet is not netted off: it shows as credit (`PrepaymentSplit`).
   */
  readonly dueNotStartedMinor: number;
}

/**
 * A lease's arrears on a day, as the statement counts them: each line past its due date with an
 * amount in 1100, which is what is outstanding on a charged line (the nightly sub-ledger check's
 * invariant 2), aged by days past due. A recurring line not charged yet is not owed in the ledger,
 * so it is not arrears: what is unpaid on it goes in `dueNotStartedMinor`. Deposits are never
 * arrears (BC-11). Reads only what it is given.
 */
export function ledgerArrears(input: {
  readonly lines: readonly BillingLine[];
  readonly allocations: readonly AllocationRow[];
  readonly asOf: string;
}): LedgerArrears {
  parseBusinessDate(input.asOf);
  const byBucket = Object.fromEntries(AGE_BUCKETS.map((b) => [b, 0])) as Record<AgeBucket, number>;
  let dueNotStarted = 0;
  for (const line of input.lines) {
    const bucket = ageBucket(line.dueDate, input.asOf);
    if (!bucket) continue;
    const posting = postingClassOf(line);
    if (posting === 'deposit') continue;
    const { outstandingMinor } = lineBalance(line, input.allocations);
    if (posting === 'receivable') byBucket[bucket] += outstandingMinor;
    else dueNotStarted += outstandingMinor;
  }
  return {
    byBucket,
    totalMinor: AGE_BUCKETS.reduce((sum, b) => sum + byBucket[b], 0),
    dueNotStartedMinor: dueNotStarted,
  };
}
