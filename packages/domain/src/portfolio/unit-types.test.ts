import { describe, expect, it } from 'vitest';
import {
  BILLING_BANDS,
  checkBedrooms,
  defaultBandFor,
  resolveBand,
  UNIT_TYPES,
  type BillingBand,
  type UnitType,
} from './unit-types';

/** PRD section 21, "Billing band" table, written out again so a change to the code shows here. */
const SECTION_21: Record<UnitType, BillingBand> = {
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

describe('PB-01 billing bands', () => {
  it('maps every unit type to its band as in PRD section 21', () => {
    for (const type of UNIT_TYPES) expect(defaultBandFor(type)).toBe(SECTION_21[type]);
    expect(new Set(Object.values(SECTION_21))).toEqual(new Set(BILLING_BANDS));
  });

  it('needs a reason to override the band, and keeps it', () => {
    expect(() => resolveBand('kiosk', { band: 'single_room' })).toThrow(/reason/);
    expect(() => resolveBand('kiosk', { band: 'single_room', reason: 'lived in' })).toThrow(
      /10 characters/,
    );
    expect(
      resolveBand('kiosk', { band: 'single_room', reason: '  Kiosk-style room let for living  ' }),
    ).toEqual({ band: 'single_room', overrideReason: 'Kiosk-style room let for living' });
  });

  it('clears the override when the default band is chosen', () => {
    expect(resolveBand('shop', { band: 'commercial', reason: 'anything at all' })).toEqual({
      band: 'commercial',
      overrideReason: null,
    });
    expect(resolveBand('studio')).toEqual({ band: 'self_contained', overrideReason: null });
  });
});

describe('PR-02 unit types', () => {
  it('lists the PR-02 unit types', () => {
    expect(UNIT_TYPES).toEqual(
      expect.arrayContaining([
        'chamber_and_hall',
        'single_room_self_contained',
        'apartment',
        'studio',
        'shop',
        'store',
        'office',
        'warehouse',
        'kiosk',
      ]),
    );
  });

  it('requires 1 to 5 bedrooms for an apartment', () => {
    expect(() => checkBedrooms('apartment', null)).toThrow(/bedrooms/);
    expect(() => checkBedrooms('apartment', 6)).toThrow(/1 to 5/);
    expect(() => checkBedrooms('apartment', 2.5)).toThrow();
    expect(checkBedrooms('apartment', 3)).toBe(3);
  });

  it('allows bedrooms on houses only, and nowhere else', () => {
    expect(checkBedrooms('detached_house', 4)).toBe(4);
    expect(checkBedrooms('townhouse', null)).toBeNull();
    expect(() => checkBedrooms('chamber_and_hall', 1)).toThrow(/apartments and houses/);
    expect(checkBedrooms('shop', undefined)).toBeNull();
  });
});
