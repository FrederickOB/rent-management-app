import { compareDates, daysBetween, parseBusinessDate, type BusinessDate } from '../dates';
import { DomainError } from '../errors';
import { billableInMonth } from '../ledger/fees';
import { BILLING_BANDS, type BillingBand } from '../portfolio/unit-types';
import { monthBounds, type BandCounts } from './pricing';

/**
 * The monthly snapshot of billable units (PB-02, D8; M10 decision 2 and plan 4.3). A unit is
 * billable for a month if it had an active lease on any day of it. The caller passes only leases
 * that became active (signed and started): a reserved unit (signed, starting after the month), a
 * unit under repair or one not lettable has no qualifying lease and is never billed. The snapshot
 * is frozen for audit and dispute once written.
 */

export interface SnapshotLeaseInput {
  readonly leaseId: string;
  readonly startDate: string;
  /** The lease's last day; null while it runs or holds over. */
  readonly lastDay: string | null;
}

export interface SnapshotUnitInput {
  readonly unitId: string;
  readonly unitCode: string;
  readonly band: BillingBand;
  readonly leases: readonly SnapshotLeaseInput[];
}

export interface SnapshotUnit {
  readonly unitId: string;
  readonly unitCode: string;
  readonly band: BillingBand;
  /** The lease with the most days in the month; ties: the latest start, then the greatest id. */
  readonly leaseId: string;
  /** Days of the month covered by any lease, overlapping leases counted once. */
  readonly daysLeased: number;
}

export const isBillingBand = (value: unknown): value is BillingBand =>
  typeof value === 'string' && (BILLING_BANDS as readonly string[]).includes(value);

interface Clipped {
  readonly lease: SnapshotLeaseInput;
  readonly start: BusinessDate;
  readonly end: BusinessDate;
  readonly leaseStart: BusinessDate;
}

const dayCount = (start: BusinessDate, end: BusinessDate): number => daysBetween(start, end) + 1;

/** Days covered by any of the intervals, each day once. */
function unionDays(intervals: readonly Clipped[]): number {
  const sorted = [...intervals].sort((a, b) => compareDates(a.start, b.start));
  let total = 0;
  let runStart: BusinessDate | null = null;
  let runEnd: BusinessDate | null = null;
  for (const { start, end } of sorted) {
    if (runStart === null || runEnd === null) {
      runStart = start;
      runEnd = end;
    } else if (compareDates(start, runEnd) <= 0 || daysBetween(runEnd, start) === 1) {
      if (compareDates(end, runEnd) > 0) runEnd = end;
    } else {
      total += dayCount(runStart, runEnd);
      runStart = start;
      runEnd = end;
    }
  }
  if (runStart !== null && runEnd !== null) total += dayCount(runStart, runEnd);
  return total;
}

function checkLease(lease: SnapshotLeaseInput): void {
  if (typeof lease.leaseId !== 'string' || lease.leaseId === '')
    throw new DomainError('subscription.bad_lease', 'Each lease needs its id');
  const start = parseBusinessDate(lease.startDate);
  if (lease.lastDay !== null && compareDates(parseBusinessDate(lease.lastDay), start) < 0)
    throw new DomainError('subscription.bad_lease', 'A lease cannot end before it starts');
}

/**
 * Units billable for the month (D8: an active lease on any day of it), in unit code order. `upTo`
 * clips the month (the estimate: today); a day after it is not counted, and a month that starts
 * after it has nothing billable yet.
 */
export function billableUnits(
  month: string,
  units: readonly SnapshotUnitInput[],
  upTo?: string | null,
): SnapshotUnit[] {
  const bounds = monthBounds(month);
  const first = parseBusinessDate(bounds.first);
  let last = parseBusinessDate(bounds.last);
  if (upTo !== undefined && upTo !== null) {
    const until = parseBusinessDate(upTo);
    if (compareDates(until, last) < 0) last = until;
  }

  const seen = new Set<string>();
  const billed: SnapshotUnit[] = [];
  for (const unit of units) {
    if (seen.has(unit.unitId))
      throw new DomainError('subscription.duplicate_unit', `Unit ${unit.unitId} is listed twice`);
    seen.add(unit.unitId);
    if (!isBillingBand(unit.band))
      throw new DomainError('subscription.bad_band', `Not a billing band: ${String(unit.band)}`);
    unit.leases.forEach(checkLease);
    // D8, on the whole month (fees.ts): the same rule management fees use.
    if (!billableInMonth(unit.leases, month)) continue;

    const clipped: Clipped[] = [];
    for (const lease of unit.leases) {
      const leaseStart = parseBusinessDate(lease.startDate);
      const start = compareDates(leaseStart, first) > 0 ? leaseStart : first;
      const leaseEnd = lease.lastDay === null ? last : parseBusinessDate(lease.lastDay);
      const end = compareDates(leaseEnd, last) < 0 ? leaseEnd : last;
      if (compareDates(start, end) <= 0) clipped.push({ lease, start, end, leaseStart });
    }
    // Only an `upTo` before the lease's first day in the month empties this.
    if (clipped.length === 0) continue;

    let chosen = clipped[0]!;
    let chosenDays = dayCount(chosen.start, chosen.end);
    for (const candidate of clipped.slice(1)) {
      const days = dayCount(candidate.start, candidate.end);
      const byStart = compareDates(candidate.leaseStart, chosen.leaseStart);
      if (
        days > chosenDays ||
        (days === chosenDays &&
          (byStart > 0 || (byStart === 0 && candidate.lease.leaseId > chosen.lease.leaseId)))
      ) {
        chosen = candidate;
        chosenDays = days;
      }
    }
    billed.push({
      unitId: unit.unitId,
      unitCode: unit.unitCode,
      band: unit.band,
      leaseId: chosen.lease.leaseId,
      daysLeased: unionDays(clipped),
    });
  }
  const key = (u: SnapshotUnit): string => `${u.unitCode}\u0000${u.unitId}`;
  return billed.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Billable units by band (PB-01). */
export function countsByBand(units: readonly { readonly band: BillingBand }[]): BandCounts {
  const counts = Object.fromEntries(BILLING_BANDS.map((band) => [band, 0])) as Record<
    BillingBand,
    number
  >;
  for (const unit of units) {
    if (!isBillingBand(unit.band))
      throw new DomainError('subscription.bad_band', `Not a billing band: ${String(unit.band)}`);
    counts[unit.band] += 1;
  }
  return counts;
}
