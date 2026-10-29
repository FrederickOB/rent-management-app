import { DomainError } from '../errors';

/** Lease states (architecture section 7, plus holding over: prd-issues 20, OQ-12). */
export const LEASE_STATUSES = [
  'draft',
  'pending_signatures',
  'signed',
  'active',
  'ending',
  'holding_over',
  'ended',
  'terminated',
  'cancelled',
] as const;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];

export const LEASE_STATUS_LABELS: Record<LeaseStatus, string> = {
  draft: 'Draft',
  pending_signatures: 'Waiting for signatures',
  signed: 'Signed',
  active: 'Active',
  ending: 'Ending',
  holding_over: 'Holding over',
  ended: 'Ended',
  terminated: 'Terminated',
  cancelled: 'Cancelled',
};

const TRANSITIONS: Record<LeaseStatus, readonly LeaseStatus[]> = {
  draft: ['pending_signatures', 'signed', 'cancelled'],
  pending_signatures: ['draft', 'signed', 'cancelled'],
  signed: ['active', 'cancelled'],
  active: ['ending', 'holding_over', 'ended', 'terminated'],
  holding_over: ['ending', 'ended', 'terminated'],
  ending: ['ended'],
  ended: [],
  terminated: [],
  cancelled: [],
};

export function checkLeaseTransition(from: LeaseStatus, to: LeaseStatus): void {
  if (!TRANSITIONS[from].includes(to))
    throw new DomainError(
      'lease.transition',
      `A lease that is ${LEASE_STATUS_LABELS[from].toLowerCase()} cannot become ${LEASE_STATUS_LABELS[to].toLowerCase()}`,
    );
}

/** A unit is occupied while it has a lease in one of these states (PB-09). */
export const OCCUPYING_STATUSES: readonly LeaseStatus[] = ['active', 'ending', 'holding_over'];
/** Between signature and start the unit is reserved (prd-issues 22). */
export const RESERVING_STATUSES: readonly LeaseStatus[] = ['signed'];
/**
 * Leases in these states hold the unit, so no two of them may overlap on one unit. A lease out
 * for signature holds it too, so a completed signing never finds the unit taken (review finding 2).
 */
export const HOLDING_STATUSES: readonly LeaseStatus[] = [
  'pending_signatures',
  'signed',
  'active',
  'ending',
  'holding_over',
];
/** Terms are frozen once a lease leaves draft (architecture 3, "immutable once issued"). */
export const isDraft = (status: LeaseStatus): boolean => status === 'draft';

export function occupancyFor(statuses: readonly LeaseStatus[]): 'occupied' | 'reserved' | 'vacant' {
  if (statuses.some((s) => OCCUPYING_STATUSES.includes(s))) return 'occupied';
  if (statuses.some((s) => RESERVING_STATUSES.includes(s))) return 'reserved';
  return 'vacant';
}
