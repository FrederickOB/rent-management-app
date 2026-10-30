import {
  DEFAULT_TIME_ZONE,
  formatBusinessDate,
  formatInstant,
  instantFrom,
} from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import {
  LEASE_STATUS_LABELS,
  RENT_CYCLE_LABELS,
  type LeaseStatus,
  type RentCycle,
} from '@rent/domain/tenancy';

// Words for the tenant app's screens (M3 plan 4.16). Amounts arrive as integer pesewas and are
// formatted here only, at the edge (CLAUDE.md section 4); business dates never pass through a
// local-time Date (section 11).

/** `GH₵1,500.00`, from integer pesewas. */
export function formatMoney(amountMinor: number): string {
  return format(money(amountMinor));
}

/** A business date such as `2026-11-01`, as `1 November 2026`. */
export function formatDate(iso: string): string {
  try {
    return formatBusinessDate(iso);
  } catch {
    return iso;
  }
}

/**
 * An instant, always with its time zone (DO-04): `29 Oct 2026, 17:05 GMT (Africa/Accra)`. The
 * tenant endpoints do not say which zone the landlord works in, so times are shown in the
 * product's default zone, named.
 */
export function formatTime(iso: string, timeZone: string = DEFAULT_TIME_ZONE): string {
  try {
    return formatInstant(instantFrom(iso), timeZone);
  } catch {
    return iso;
  }
}

/** `1 November 2026 to 31 October 2027`. */
export function termLabel(startDate: string, endDate: string): string {
  return `${formatDate(startDate)} to ${formatDate(endDate)}`;
}

/** `GH₵1,500.00 a month, paid quarterly`. */
export function rentLabel(monthlyRentMinor: number, cycle: RentCycle): string {
  return `${formatMoney(monthlyRentMinor)} a month, paid ${RENT_CYCLE_LABELS[cycle].toLowerCase()}`;
}

/** A deposit or charge that may not exist. */
export function optionalMoney(amountMinor: number | null, suffix = ''): string {
  return amountMinor === null || amountMinor === 0
    ? 'None'
    : `${formatMoney(amountMinor)}${suffix}`;
}

export function noticeLabel(days: number): string {
  if (days <= 0) return 'None';
  return days === 1 ? '1 day' : `${days} days`;
}

export const leaseStatusLabel = (status: LeaseStatus): string => LEASE_STATUS_LABELS[status];

export type Tone = 'ok' | 'waiting' | 'past';

/** How a lease's status looks: in force, waiting on something, or over. */
export function leaseStatusTone(status: LeaseStatus): Tone {
  switch (status) {
    case 'signed':
    case 'active':
      return 'ok';
    case 'draft':
    case 'pending_signatures':
    case 'ending':
    case 'holding_over':
      return 'waiting';
    case 'ended':
    case 'terminated':
    case 'cancelled':
      return 'past';
  }
}

export type SignerStatus = 'pending' | 'signed' | 'declined';

export const SIGNER_STATUS_LABELS: Record<SignerStatus, string> = {
  pending: 'Not signed yet',
  signed: 'Signed',
  declined: 'Declined',
};

/** "1 lease is", "2 leases are". */
export function leasesAre(count: number): string {
  return count === 1 ? '1 lease is' : `${count} leases are`;
}
