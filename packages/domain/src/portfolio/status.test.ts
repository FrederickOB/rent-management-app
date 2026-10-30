import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY,
  checkAvailabilityChange,
  checkStatusReason,
  displayStatus,
  type Availability,
} from './status';

describe('PR-06 unit status', () => {
  it('has no vacant or occupied availability: occupancy is derived from leases (PB-09)', () => {
    expect(AVAILABILITY).not.toContain('vacant');
    expect(AVAILABILITY).not.toContain('occupied');
  });

  it('allows manual changes only through available', () => {
    const allowed: [Availability, Availability][] = [
      ['available', 'reserved'],
      ['available', 'under_repair'],
      ['available', 'not_lettable'],
      ['reserved', 'available'],
      ['under_repair', 'available'],
      ['not_lettable', 'available'],
    ];
    for (const from of AVAILABILITY)
      for (const to of AVAILABILITY) {
        const ok = allowed.some(([f, t]) => f === from && t === to);
        const run = () => checkAvailabilityChange(from, to, { occupied: false });
        if (ok) expect(run).not.toThrow();
        else expect(run).toThrow();
      }
  });

  it('keeps an occupied unit lettable: only a repair can be recorded', () => {
    expect(() =>
      checkAvailabilityChange('available', 'under_repair', { occupied: true }),
    ).not.toThrow();
    expect(() => checkAvailabilityChange('available', 'not_lettable', { occupied: true })).toThrow(
      /active lease/,
    );
    expect(() => checkAvailabilityChange('available', 'reserved', { occupied: true })).toThrow(
      /active lease/,
    );
  });

  it('needs a reason for every manual change', () => {
    expect(() => checkStatusReason('  ')).toThrow(/reason/);
    expect(checkStatusReason(' Roof leak ')).toBe('Roof leak');
  });

  it('shows one status, with repairs on an occupied unit as a badge', () => {
    expect(displayStatus('vacant', 'available')).toEqual({ status: 'vacant', underRepair: false });
    expect(displayStatus('vacant', 'not_lettable').status).toBe('not_lettable');
    expect(displayStatus('vacant', 'under_repair')).toEqual({
      status: 'under_repair',
      underRepair: true,
    });
    expect(displayStatus('occupied', 'under_repair')).toEqual({
      status: 'occupied',
      underRepair: true,
    });
    expect(displayStatus('reserved', 'available').status).toBe('reserved');
  });
});
