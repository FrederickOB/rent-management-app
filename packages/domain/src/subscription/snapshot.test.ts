import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, parseBusinessDate, toIsoDate } from '../dates';
import { billableInMonth } from '../ledger/fees';
import { BILLING_BANDS } from '../portfolio/unit-types';
import { daysInMonth, monthBounds, shiftMonth } from './pricing';
import {
  billableUnits,
  countsByBand,
  type SnapshotLeaseInput,
  type SnapshotUnitInput,
} from './snapshot';

const unit = (
  code: string,
  leases: SnapshotLeaseInput[],
  band: SnapshotUnitInput['band'] = 'self_contained',
): SnapshotUnitInput => ({ unitId: `u-${code}`, unitCode: code, band, leases });

const lease = (leaseId: string, startDate: string, lastDay: string | null = null) => ({
  leaseId,
  startDate,
  lastDay,
});

const dayOf = (month: string, offset: number): string =>
  toIsoDate(addDays(parseBusinessDate(`${month}-01`), offset));

describe('PB-02 snapshot (D8)', () => {
  it('bills a unit with an active lease on any day of the month, for the days leased', () => {
    const units = [
      unit('ACC-LEG-B1-01', [lease('whole', '2026-01-15')]),
      unit('ACC-LEG-B1-02', [lease('ends', '2026-01-15', '2026-11-10')]),
      unit('ACC-LEG-B1-03', [lease('starts', '2026-11-25', '2027-11-24')]),
      unit('ACC-LEG-B1-04', [lease('one-day', '2026-01-01', '2026-11-01')]),
      unit('ACC-LEG-B1-05', [lease('last-day', '2026-11-30', null)]),
    ];
    expect(billableUnits('2026-11', units)).toEqual([
      {
        unitId: 'u-ACC-LEG-B1-01',
        unitCode: 'ACC-LEG-B1-01',
        band: 'self_contained',
        leaseId: 'whole',
        daysLeased: 30,
      },
      {
        unitId: 'u-ACC-LEG-B1-02',
        unitCode: 'ACC-LEG-B1-02',
        band: 'self_contained',
        leaseId: 'ends',
        daysLeased: 10,
      },
      {
        unitId: 'u-ACC-LEG-B1-03',
        unitCode: 'ACC-LEG-B1-03',
        band: 'self_contained',
        leaseId: 'starts',
        daysLeased: 6,
      },
      {
        unitId: 'u-ACC-LEG-B1-04',
        unitCode: 'ACC-LEG-B1-04',
        band: 'self_contained',
        leaseId: 'one-day',
        daysLeased: 1,
      },
      {
        unitId: 'u-ACC-LEG-B1-05',
        unitCode: 'ACC-LEG-B1-05',
        band: 'self_contained',
        leaseId: 'last-day',
        daysLeased: 1,
      },
    ]);
  });

  it('never bills a vacant unit: ended, reserved, under repair or not lettable', () => {
    const units = [
      unit('ended', [lease('l1', '2025-11-01', '2026-10-31')]),
      // Reserved: signed, starting after the month.
      unit('reserved', [lease('l2', '2026-12-01')]),
      // Under repair and not lettable: no qualifying lease reaches the snapshot.
      unit('repair', []),
      unit('not-lettable', []),
    ];
    expect(billableUnits('2026-11', units)).toEqual([]);
  });

  it('counts overlapping leases once and names the lease with the most days', () => {
    const [moveOut] = billableUnits('2026-11', [
      unit('A', [
        lease('old', '2025-11-01', '2026-11-10'),
        lease('new', '2026-11-20', '2027-11-19'),
      ]),
    ]);
    expect(moveOut).toMatchObject({ leaseId: 'new', daysLeased: 10 + 11 });
    // 1 to 20 November and 15 to 30 November: 30 days, not 36; the first has more of them.
    const [overlap] = billableUnits('2026-11', [
      unit('B', [lease('first', '2026-10-01', '2026-11-20'), lease('second', '2026-11-15')]),
    ]);
    expect(overlap).toMatchObject({ leaseId: 'first', daysLeased: 30 });
    // Equal days: the latest start, whatever the order given.
    const tie = [lease('early', '2026-10-01', '2026-11-15'), lease('late', '2026-11-16')];
    expect(billableUnits('2026-11', [unit('C', tie)])[0]!.leaseId).toBe('late');
    expect(billableUnits('2026-11', [unit('C', [...tie].reverse())])[0]!.leaseId).toBe('late');
  });

  it('bills a unit holding over every month after its start', () => {
    const units = [unit('H', [lease('holding', '2024-03-15', null)])];
    expect(billableUnits('2024-02', units)).toEqual([]);
    for (const month of ['2024-03', '2025-07', '2026-11', '2031-01'])
      expect(billableUnits(month, units).map((u) => u.leaseId)).toEqual(['holding']);
  });

  it('clips the month at `upTo` for this month’s estimate', () => {
    const units = [
      unit('A', [lease('running', '2026-01-01')]),
      unit('B', [lease('later', '2026-11-20')]),
    ];
    expect(billableUnits('2026-11', units, '2026-11-07')).toEqual([
      { unitId: 'u-A', unitCode: 'A', band: 'self_contained', leaseId: 'running', daysLeased: 7 },
    ]);
    expect(billableUnits('2026-11', units, '2026-10-31')).toEqual([]);
    expect(billableUnits('2026-11', units, '2026-12-15')).toHaveLength(2);
  });

  it('lists units in unit code order and counts them by band (PB-01)', () => {
    const units = [
      unit('ACC-OSU-G-02', [lease('s2', '2026-01-01')], 'commercial'),
      unit('ACC-LEG-B2-04', [lease('r1', '2026-01-01')], 'single_room'),
      unit('ACC-OSU-G-01', [lease('s1', '2026-01-01')], 'commercial'),
      unit('ACC-ELG-A-01', [lease('f1', '2026-01-01')], 'self_contained'),
    ];
    const billed = billableUnits('2026-11', units);
    expect(billed.map((u) => u.unitCode)).toEqual([
      'ACC-ELG-A-01',
      'ACC-LEG-B2-04',
      'ACC-OSU-G-01',
      'ACC-OSU-G-02',
    ]);
    expect(countsByBand(billed)).toEqual({ single_room: 1, self_contained: 1, commercial: 2 });
    expect(countsByBand([])).toEqual({ single_room: 0, self_contained: 0, commercial: 0 });
  });

  it('refuses a unit listed twice, a lease ending before it starts and an unknown band', () => {
    expect(() => billableUnits('2026-11', [unit('A', []), unit('A', [])])).toThrow(/twice/);
    expect(() =>
      billableUnits('2026-11', [unit('A', [lease('x', '2026-11-10', '2026-11-09')])]),
    ).toThrow(/before it starts/);
    expect(() => billableUnits('2026-11', [{ ...unit('A', []), band: 'castle' as never }])).toThrow(
      /band/,
    );
  });
});

// Property-based (★ PRD section 21): leases starting, ending and holding over across month ends.

const MONTHS = ['2026-02', '2028-02', '2026-04', '2026-11', '2026-12'];
const BASE = '2026-01';
const leaseArb = fc.record({
  start: fc.integer({ min: 0, max: 1_100 }),
  length: fc.option(fc.integer({ min: 0, max: 500 }), { nil: null }),
});
const unitsArb = fc.array(
  fc.record({
    band: fc.constantFrom(...BILLING_BANDS),
    leases: fc.array(leaseArb, { maxLength: 4 }),
  }),
  { maxLength: 8 },
);
const toUnits = (
  raw: {
    band: (typeof BILLING_BANDS)[number];
    leases: { start: number; length: number | null }[];
  }[],
): SnapshotUnitInput[] =>
  raw.map((u, i) => ({
    unitId: `unit-${i}`,
    unitCode: `ACC-T-${String(100 - i).padStart(3, '0')}`,
    band: u.band,
    leases: u.leases.map((l, j) => {
      const startDate = dayOf(BASE, l.start);
      return {
        leaseId: `lease-${i}-${j}`,
        startDate,
        lastDay: l.length === null ? null : dayOf(BASE, l.start + l.length),
      };
    }),
  }));
const covers = (l: SnapshotLeaseInput, day: string): boolean =>
  l.startDate <= day && (l.lastDay === null || l.lastDay >= day);
// Months spanning the generated leases (2026 to 2029), plus the fixed ones.
const monthArb = fc.oneof(
  fc.constantFrom(...MONTHS),
  fc.integer({ min: 0, max: 47 }).map((n) => shiftMonth('2026-01', n)),
);

describe('PB-02 snapshot (D8, property-based)', () => {
  it('bills a unit iff a lease overlaps the month, for exactly the days some lease covers', () => {
    fc.assert(
      fc.property(monthArb, unitsArb, (month, raw) => {
        const units = toUnits(raw);
        const billed = billableUnits(month, units);
        const byId = new Map(billed.map((u) => [u.unitId, u]));
        const { first, last } = monthBounds(month);
        for (const u of units) {
          const overlaps = u.leases.some(
            (l) => l.startDate <= last && (l.lastDay === null || l.lastDay >= first),
          );
          expect(byId.has(u.unitId)).toBe(overlaps);
          expect(byId.has(u.unitId)).toBe(billableInMonth(u.leases, month));
          let covered = 0;
          for (let i = 0; i < daysInMonth(month); i += 1)
            if (u.leases.some((l) => covers(l, dayOf(month, i)))) covered += 1;
          const row = byId.get(u.unitId);
          if (!row) {
            expect(covered).toBe(0);
            continue;
          }
          expect(row.daysLeased).toBe(covered);
          expect(row.band).toBe(u.band);
          // The named lease is one of the unit's, with the most days in the month.
          const daysOf = (l: SnapshotLeaseInput) => {
            let n = 0;
            for (let i = 0; i < daysInMonth(month); i += 1) if (covers(l, dayOf(month, i))) n += 1;
            return n;
          };
          const named = u.leases.find((l) => l.leaseId === row.leaseId)!;
          expect(named).toBeDefined();
          for (const other of u.leases) expect(daysOf(named)).toBeGreaterThanOrEqual(daysOf(other));
        }
        // Unit code order; the counts by band add up to the units billed.
        const codes = billed.map((u) => u.unitCode);
        expect(codes).toEqual([...codes].sort());
        const counts = countsByBand(billed);
        expect(counts.single_room + counts.self_contained + counts.commercial).toBe(billed.length);
      }),
      { numRuns: 300 },
    );
  });

  it('bills a unit holding over (no last day) in every month from its start', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 700 }),
        fc.integer({ min: -3, max: 40 }),
        (start, ahead) => {
          const startDate = dayOf(BASE, start);
          const startMonth = startDate.slice(0, 7);
          const month = shiftMonth(startMonth, ahead);
          const billed = billableUnits(month, [unit('H', [lease('holding', startDate, null)])]);
          expect(billed.length).toBe(ahead >= 0 ? 1 : 0);
        },
      ),
    );
  });

  it('clips at `upTo`: an estimate counts only days up to it, and never more than the month', () => {
    fc.assert(
      fc.property(monthArb, unitsArb, fc.integer({ min: -3, max: 33 }), (month, raw, cut) => {
        const units = toUnits(raw);
        const upTo = dayOf(month, cut);
        const whole = new Map(billableUnits(month, units).map((u) => [u.unitId, u]));
        const clipped = new Map(billableUnits(month, units, upTo).map((u) => [u.unitId, u]));
        for (const u of units) {
          let covered = 0;
          for (let i = 0; i < daysInMonth(month); i += 1) {
            const day = dayOf(month, i);
            if (day <= upTo && u.leases.some((l) => covers(l, day))) covered += 1;
          }
          const row = clipped.get(u.unitId);
          expect(row?.daysLeased ?? 0).toBe(covered);
          if (row) expect(row.daysLeased).toBeLessThanOrEqual(whole.get(u.unitId)!.daysLeased);
        }
      }),
      { numRuns: 200 },
    );
  });
});
