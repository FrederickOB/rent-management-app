import { describe, expect, it } from 'vitest';
import { checkAmenities, checkMeterNumber, checkMeterUnits, checkSupplier } from './features';
import { checkOwnerReference, checkOwnershipShares } from './owners';

describe('PR-09 amenities', () => {
  it('accepts the fixed list in any case, in the list order, without duplicates', () => {
    expect(checkAmenities(['Solar', 'parking', ' Air conditioning', 'PARKING', ''])).toEqual([
      'parking',
      'solar',
      'air_conditioning',
    ]);
  });

  it('refuses anything not on the list', () => {
    expect(() => checkAmenities(['Swimming pool'])).toThrow(/amenities list/);
  });
});

describe('PR-05 meters', () => {
  it('normalises meter numbers and checks suppliers', () => {
    expect(checkMeterNumber(' p-0123  456 ')).toBe('P-0123 456');
    expect(() => checkMeterNumber('x')).toThrow(/meter number/);
    expect(checkSupplier(' ECG ')).toBe('ECG');
    expect(() => checkSupplier('E')).toThrow(/supplier/);
  });

  it('lets only a shared meter serve more than one unit', () => {
    expect(() => checkMeterUnits('shared', 4)).not.toThrow();
    expect(() => checkMeterUnits('prepaid', 1)).not.toThrow();
    expect(() => checkMeterUnits('postpaid', 2)).toThrow(/shared/);
  });
});

describe('AD-02 owners', () => {
  it('normalises owner references', () => {
    expect(checkOwnerReference(' own-01 ')).toBe('OWN-01');
    expect(() => checkOwnerReference('-')).toThrow(/reference/);
  });

  it('needs ownership shares that add up to the whole property (ready for PR-07)', () => {
    expect(() => checkOwnershipShares([{ shareBps: 10_000 }])).not.toThrow();
    expect(() => checkOwnershipShares([{ shareBps: 6_000 }, { shareBps: 4_000 }])).not.toThrow();
    expect(() => checkOwnershipShares([{ shareBps: 6_000 }])).toThrow(/100%/);
    expect(() => checkOwnershipShares([])).toThrow(/owner/);
    expect(() => checkOwnershipShares([{ shareBps: 0 }, { shareBps: 10_000 }])).toThrow();
  });
});
