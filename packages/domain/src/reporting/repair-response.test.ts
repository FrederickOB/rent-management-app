import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { repairResponse, workStartedAtOf, type RepairJobForMetric } from './gate1';

const reported = '2026-11-10T08:00:00Z';
const asOf = '2026-11-30T23:00:00Z';
const emergency = (
  workStartedAt: string | null,
  clockStartedAt = reported,
): RepairJobForMetric => ({
  priority: 'emergency',
  clockStartedAt,
  workStartedAt,
  targetMinutes: 120,
});

describe('Gate 1 repair response: attended means work started (founder decision, 2026-11-05)', () => {
  it('counts an emergency attended when it moved to In progress within its target', () => {
    const result = repairResponse({
      asOf,
      jobs: [
        emergency('2026-11-10T09:15:00Z'),
        emergency('2026-11-10T10:00:00Z'), // exactly 2 hours: within
        emergency('2026-11-10T10:00:01Z'),
      ],
    });
    expect(result).toEqual({
      met: 2,
      missed: 1,
      pending: 0,
      rate: { numerator: 2, denominator: 3, bps: 6_667 },
    });
  });

  it('does not count a job assigned in time but not started in time', () => {
    // Assigned at 08:30, the artisan started at 11:00: only the start counts, so it is missed.
    expect(repairResponse({ asOf, jobs: [emergency('2026-11-10T11:00:00Z')] }).missed).toBe(1);
    // Assigned, never started, target passed.
    expect(repairResponse({ asOf, jobs: [emergency(null)] }).missed).toBe(1);
  });

  it('leaves a job inside its target with no work started out of the share', () => {
    const result = repairResponse({ asOf, jobs: [emergency(null, '2026-11-30T22:00:00Z')] });
    expect(result.pending).toBe(1);
    expect(result.rate.bps).toBeNull();
    // Started after the moment measured: not started yet as of then.
    const later = repairResponse({
      asOf,
      jobs: [emergency('2026-11-30T23:30:00Z', '2026-11-30T22:00:00Z')],
    });
    expect(later).toMatchObject({ met: 0, missed: 0, pending: 1 });
  });

  it('reads the first metric’s field name as the same instant', () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 0, max: 600 }), { nil: null }),
        fc.integer({ min: 0, max: 480 }),
        (startedAfter, targetMinutes) => {
          const started =
            startedAfter === null
              ? null
              : new Date(Date.parse(reported) + startedAfter * 60_000).toISOString();
          const facts = { priority: 'emergency', clockStartedAt: reported, targetMinutes } as const;
          const named: RepairJobForMetric = { ...facts, workStartedAt: started };
          const previous: RepairJobForMetric = { ...facts, attendedAt: started };
          expect(workStartedAtOf(named)).toBe(started);
          expect(workStartedAtOf(previous)).toBe(started);
          expect(repairResponse({ asOf, jobs: [named] })).toEqual(
            repairResponse({ asOf, jobs: [previous] }),
          );
        },
      ),
    );
  });
});
