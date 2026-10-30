import { describe, expect, it } from 'vitest';
import { availabilityChoices } from './unit-status';

describe('PB-09 occupancy from leases on the unit page', () => {
  it('keeps a unit held by a signed lease that has not started available or under repair', () => {
    // A signed lease reserves the unit (shown "Reserved") while its availability stays "available".
    expect(availabilityChoices('available', 'reserved', 'reserved')).toEqual(['under_repair']);
    expect(availabilityChoices('available', 'occupied', 'occupied')).toEqual(['under_repair']);
    expect(availabilityChoices('under_repair', 'occupied', 'occupied')).toEqual(['available']);
  });

  it('leaves a unit no lease holds to the availability rules alone', () => {
    // A manual hold shows "Reserved" too, but no lease holds the unit.
    expect(availabilityChoices('reserved', 'reserved', 'vacant')).toEqual(['available']);
    expect(availabilityChoices('available', 'vacant', 'vacant')).toEqual([
      'reserved',
      'under_repair',
      'not_lettable',
    ]);
  });
});
