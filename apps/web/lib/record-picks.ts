import type { UnitRowView } from '@rent/contracts';
import type { DisplayStatus } from '@rent/domain/portfolio';

// What the unit and tenant pickers hold. Plain data and functions, so server pages can build the
// first choice (from ?unitId= or ?tenantId=) and hand it to the client pickers.

export interface PickedUnit {
  readonly id: string;
  readonly code: string;
  readonly propertyName: string;
  readonly status: DisplayStatus;
  readonly occupancy: UnitRowView['occupancy'];
  /** Commercial units default to a commercial lease (plan 4.6). */
  readonly commercial: boolean;
}

export interface PickedTenant {
  readonly id: string;
  readonly displayName: string;
  readonly phone: string | null;
  readonly kind: 'individual' | 'company';
}

export const pickedUnitOf = (row: UnitRowView): PickedUnit => ({
  id: row.id,
  code: row.code,
  propertyName: row.propertyName,
  status: row.status,
  occupancy: row.occupancy,
  commercial: row.billingBand === 'commercial',
});

export const pickedTenantOf = (tenant: {
  readonly id: string;
  readonly displayName: string;
  readonly phone: string | null;
  readonly kind: 'individual' | 'company';
}): PickedTenant => ({
  id: tenant.id,
  displayName: tenant.displayName,
  phone: tenant.phone,
  kind: tenant.kind,
});
