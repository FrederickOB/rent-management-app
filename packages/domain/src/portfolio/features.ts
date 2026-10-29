import { DomainError } from '../errors';

/** PR-09 amenities and features per unit, from a fixed list. */
export const AMENITIES = [
  'parking',
  'borehole',
  'generator',
  'solar',
  'air_conditioning',
  'furnished',
] as const;
export type Amenity = (typeof AMENITIES)[number];

export const AMENITY_LABELS: Record<Amenity, string> = {
  parking: 'Parking',
  borehole: 'Borehole',
  generator: 'Generator',
  solar: 'Solar',
  air_conditioning: 'Air conditioning',
  furnished: 'Furnished',
};

/** Keeps the list's own order and drops duplicates; an unknown amenity is refused. */
export function checkAmenities(values: readonly string[]): Amenity[] {
  const wanted = new Set<string>();
  for (const raw of values) {
    const value = raw
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    if (!value) continue;
    if (!(AMENITIES as readonly string[]).includes(value))
      throw new DomainError('unit.amenity_unknown', `"${raw}" is not on the amenities list`);
    wanted.add(value);
  }
  return AMENITIES.filter((a) => wanted.has(a));
}

/** PR-05 meters. Suppliers come from the country's configuration (ECG and NEDCo, Ghana Water). */
export const UTILITIES = ['electricity', 'water'] as const;
export type Utility = (typeof UTILITIES)[number];

export const METER_TYPES = ['prepaid', 'postpaid', 'shared'] as const;
export type MeterType = (typeof METER_TYPES)[number];

export const METER_TYPE_LABELS: Record<MeterType, string> = {
  prepaid: 'Prepaid',
  postpaid: 'Postpaid',
  shared: 'Shared',
};

export function checkMeterNumber(input: string): string {
  const value = input.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!/^[A-Z0-9][A-Z0-9 /-]{2,39}$/.test(value))
    throw new DomainError(
      'meter.number_invalid',
      'Enter the meter number: 3 to 40 letters, digits, spaces, hyphens or slashes',
    );
  return value;
}

export function checkSupplier(input: string): string {
  const value = input.trim().replace(/\s+/g, ' ');
  if (value.length < 2 || value.length > 40)
    throw new DomainError('meter.supplier_invalid', 'Enter the supplier, for example ECG');
  return value;
}

/** A prepaid or postpaid meter serves one unit at most; a shared meter may serve several. */
export function checkMeterUnits(type: MeterType, unitCount: number): void {
  if (type !== 'shared' && unitCount > 1)
    throw new DomainError('meter.not_shared', 'Only a shared meter can serve more than one unit');
}
