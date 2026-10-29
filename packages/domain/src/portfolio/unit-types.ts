import { DomainError } from '../errors';

/** Property types (PRD section 1). */
export const PROPERTY_TYPES = [
  'apartment_block',
  'house',
  'compound_house',
  'shop',
  'office',
  'warehouse',
  'mixed_use',
  'gated_estate',
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  apartment_block: 'Apartment block',
  house: 'House',
  compound_house: 'Compound house',
  shop: 'Shops',
  office: 'Offices',
  warehouse: 'Warehouse',
  mixed_use: 'Mixed-use building',
  gated_estate: 'Gated estate',
};

export const PROPERTY_USES = ['residential', 'commercial', 'mixed'] as const;
export type PropertyUse = (typeof PROPERTY_USES)[number];

/** PR-02 unit types. Bedrooms apply to apartments (1 to 5, as PR-02 lists) and houses. */
export const UNIT_TYPES = [
  'single_room',
  'chamber_and_hall',
  'single_room_self_contained',
  'studio',
  'apartment',
  'detached_house',
  'semi_detached_house',
  'townhouse',
  'shop',
  'store',
  'office',
  'warehouse',
  'kiosk',
] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const UNIT_TYPE_LABELS: Record<UnitType, string> = {
  single_room: 'Single room',
  chamber_and_hall: 'Chamber and hall',
  single_room_self_contained: 'Single room self-contained',
  studio: 'Studio',
  apartment: 'Apartment',
  detached_house: 'Detached house',
  semi_detached_house: 'Semi-detached house',
  townhouse: 'Townhouse',
  shop: 'Shop',
  store: 'Store',
  office: 'Office',
  warehouse: 'Warehouse',
  kiosk: 'Kiosk',
};

/** PB-01 billing bands, the three subscription rates of PRD section 21. */
export const BILLING_BANDS = ['single_room', 'self_contained', 'commercial'] as const;
export type BillingBand = (typeof BILLING_BANDS)[number];

export const BILLING_BAND_LABELS: Record<BillingBand, string> = {
  single_room: 'Single room',
  self_contained: 'Self-contained flat or house',
  commercial: 'Commercial',
};

/** PRD section 21, "Billing band" table. Product configuration, not law. */
const DEFAULT_BAND: Record<UnitType, BillingBand> = {
  single_room: 'single_room',
  chamber_and_hall: 'single_room',
  single_room_self_contained: 'single_room',
  studio: 'self_contained',
  apartment: 'self_contained',
  detached_house: 'self_contained',
  semi_detached_house: 'self_contained',
  townhouse: 'self_contained',
  shop: 'commercial',
  store: 'commercial',
  office: 'commercial',
  warehouse: 'commercial',
  kiosk: 'commercial',
};

export function defaultBandFor(type: UnitType): BillingBand {
  return DEFAULT_BAND[type];
}

const HOUSES: readonly UnitType[] = ['detached_house', 'semi_detached_house', 'townhouse'];

/** Checks bedrooms for a unit type: required for apartments, optional for houses, absent otherwise. */
export function checkBedrooms(type: UnitType, bedrooms: number | null | undefined): number | null {
  if (type === 'apartment') {
    if (bedrooms == null) throw new DomainError('unit.bedrooms_required', 'Enter the bedrooms');
    if (!Number.isInteger(bedrooms) || bedrooms < 1 || bedrooms > 5)
      throw new DomainError('unit.bedrooms_range', 'An apartment has 1 to 5 bedrooms');
    return bedrooms;
  }
  if (HOUSES.includes(type)) {
    if (bedrooms == null) return null;
    if (!Number.isInteger(bedrooms) || bedrooms < 1 || bedrooms > 20)
      throw new DomainError('unit.bedrooms_range', 'A house has 1 to 20 bedrooms');
    return bedrooms;
  }
  if (bedrooms != null)
    throw new DomainError(
      'unit.bedrooms_not_applicable',
      'Bedrooms apply to apartments and houses',
    );
  return null;
}

export const BAND_REASON_MIN_LENGTH = 10;

/**
 * The band to store for a unit (PB-01). The default follows the unit type; a different band is
 * an override and needs a reason, which the audit log keeps. Choosing the default clears it.
 */
export function resolveBand(
  type: UnitType,
  requested?: { readonly band: BillingBand; readonly reason?: string | null } | null,
): { band: BillingBand; overrideReason: string | null } {
  const fallback = defaultBandFor(type);
  if (!requested || requested.band === fallback) return { band: fallback, overrideReason: null };
  const reason = requested.reason?.trim() ?? '';
  if (reason.length < BAND_REASON_MIN_LENGTH)
    throw new DomainError(
      'unit.band_reason_required',
      `Give a reason of at least ${BAND_REASON_MIN_LENGTH} characters for a band that differs from the unit type`,
    );
  return { band: requested.band, overrideReason: reason };
}
