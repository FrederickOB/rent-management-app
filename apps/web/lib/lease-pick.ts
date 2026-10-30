import type { ApiClient } from '@rent/contracts/client';
import { LEASE_STATUS_LABELS, type LeaseStatus } from '@rent/domain/tenancy';

// The lease a payment is for (BC-05, P28). Plain data, so a server page can build the first choice
// from ?leaseId= and hand it to the picker. A caretaker sees a lease's unit and dates only.

type LeaseListRow = Awaited<ReturnType<ApiClient['leases']['list']>>[number];
type LeaseView = Awaited<ReturnType<ApiClient['leases']['get']>>;

export interface PickedLease {
  readonly id: string;
  readonly unitCode: string;
  readonly status: LeaseStatus;
  /** Null when this person sees only the unit and the dates (a caretaker). */
  readonly tenantName: string | null;
  readonly propertyName: string | null;
}

/**
 * Leases money can be recorded for: signed, whether or not they have started or ended (a tenant
 * who moved out may still pay what they owe). Drafts, leases out for signing and cancelled ones
 * have no invoices.
 */
export const PAYABLE_STATUSES: readonly LeaseStatus[] = [
  'signed',
  'active',
  'ending',
  'holding_over',
  'ended',
  'terminated',
];

export const isPayable = (status: LeaseStatus): boolean => PAYABLE_STATUSES.includes(status);

export function pickedLeaseOf(lease: LeaseListRow | LeaseView): PickedLease {
  if (lease.access === 'limited')
    return {
      id: lease.id,
      unitCode: lease.unit.code,
      status: lease.status,
      tenantName: null,
      propertyName: null,
    };
  return {
    id: lease.id,
    unitCode: lease.unit.code,
    status: lease.status,
    tenantName: lease.tenant.displayName,
    propertyName: 'propertyName' in lease ? lease.propertyName : lease.unit.propertyName,
  };
}

/** `ACC-LEG-B1-01 · Kwame Monthly (demo) · Active` for the picker. */
export function leasePickLabel(lease: PickedLease): string {
  return [lease.unitCode, lease.tenantName, LEASE_STATUS_LABELS[lease.status]]
    .filter(Boolean)
    .join(' · ');
}
