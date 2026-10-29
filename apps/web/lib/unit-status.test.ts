import { describe, expect, it } from 'vitest';
import {
  availabilityChoices,
  availabilityHint,
  bandChoices,
  bandOverrideProblem,
  reasonProblem,
} from './unit-status';

describe('PR-06 availability changes offered on the unit page', () => {
  it('offers exactly the transitions the state machine allows, through available', () => {
    expect(availabilityChoices('available', 'vacant')).toEqual([
      'reserved',
      'under_repair',
      'not_lettable',
    ]);
    expect(availabilityChoices('under_repair', 'under_repair')).toEqual(['available']);
    expect(availabilityChoices('not_lettable', 'not_lettable')).toEqual(['available']);
    expect(availabilityChoices('reserved', 'reserved')).toEqual(['available']);
  });

  it('keeps an occupied unit lettable: only a repair badge can be added', () => {
    expect(availabilityChoices('available', 'occupied')).toEqual(['under_repair']);
  });

  it('explains the choice and needs a reason', () => {
    expect(availabilityHint('under_repair', ['available'])).toMatch(/made available again/);
    expect(reasonProblem('  ')).not.toBeNull();
    expect(reasonProblem('ok')).not.toBeNull();
    expect(reasonProblem('Roof leak')).toBeNull();
  });
});

describe('PB-01 band overrides offered on the unit page', () => {
  it('offers the other bands and needs a reason of 10 characters for an override', () => {
    expect(bandChoices('single_room')).toEqual(['self_contained', 'commercial']);
    expect(bandOverrideProblem('kiosk', 'single_room', 'let as room')).toBeNull();
    expect(bandOverrideProblem('kiosk', 'single_room', 'short')).toMatch(/10 characters/);
    // Going back to the type's default needs no reason.
    expect(bandOverrideProblem('kiosk', 'commercial', '')).toBeNull();
  });
});
