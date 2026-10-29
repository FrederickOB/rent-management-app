import { DomainError } from '../errors';

/**
 * Unit status (PR-06, PB-09; prd-issues 21) is two fields. Availability is set by hand.
 * Occupancy is derived from leases (M3) and can never be set by hand, so "vacant" and "occupied"
 * are not availability values.
 */
export const AVAILABILITY = ['available', 'reserved', 'under_repair', 'not_lettable'] as const;
export type Availability = (typeof AVAILABILITY)[number];

export type Occupancy = 'occupied' | 'vacant';

export const AVAILABILITY_LABELS: Record<Availability, string> = {
  available: 'Available',
  reserved: 'Reserved',
  under_repair: 'Under repair',
  not_lettable: 'Not lettable',
};

/** Manual changes follow the unit status machine (architecture section 7), through available. */
const MANUAL_CHANGES: Record<Availability, readonly Availability[]> = {
  available: ['reserved', 'under_repair', 'not_lettable'],
  reserved: ['available'],
  under_repair: ['available'],
  not_lettable: ['available'],
};

/** While a lease is active the unit stays lettable; only a repair badge can be added (M3). */
const WHILE_OCCUPIED: readonly Availability[] = ['available', 'under_repair'];

export function checkAvailabilityChange(
  from: Availability,
  to: Availability,
  options: { readonly occupied: boolean },
): void {
  if (from === to)
    throw new DomainError(
      'unit.availability_unchanged',
      `The unit is already ${AVAILABILITY_LABELS[to].toLowerCase()}`,
    );
  if (!MANUAL_CHANGES[from].includes(to))
    throw new DomainError(
      'unit.availability_transition',
      `A unit that is ${AVAILABILITY_LABELS[from].toLowerCase()} must be made available first`,
    );
  if (options.occupied && !WHILE_OCCUPIED.includes(to))
    throw new DomainError(
      'unit.occupied',
      'This unit has an active lease, so it can only be marked under repair',
    );
}

export const STATUS_REASON_MIN_LENGTH = 3;

export function checkStatusReason(reason: string | null | undefined): string {
  const value = reason?.trim() ?? '';
  if (value.length < STATUS_REASON_MIN_LENGTH)
    throw new DomainError('unit.status_reason_required', 'Give a reason for the change');
  return value;
}

export const DISPLAY_STATUSES = [
  'occupied',
  'reserved',
  'under_repair',
  'not_lettable',
  'vacant',
] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

export const DISPLAY_STATUS_LABELS: Record<DisplayStatus, string> = {
  occupied: 'Occupied',
  reserved: 'Reserved',
  under_repair: 'Under repair',
  not_lettable: 'Not lettable',
  vacant: 'Vacant',
};

/**
 * The one status shown for a unit. Occupancy wins; repairs on an occupied unit show as a badge.
 * Reserved covers both a manual hold and a signed lease that has not started (M3).
 */
export function displayStatus(
  occupancy: Occupancy | 'reserved',
  availability: Availability,
): { status: DisplayStatus; underRepair: boolean } {
  if (occupancy === 'occupied')
    return { status: 'occupied', underRepair: availability === 'under_repair' };
  if (occupancy === 'reserved') return { status: 'reserved', underRepair: false };
  return {
    status: availability === 'available' ? 'vacant' : availability,
    underRepair: availability === 'under_repair',
  };
}
