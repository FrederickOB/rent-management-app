import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  chargeAllocations,
  feeBearing,
  liveFeeMinor,
  takeBacks,
  undoings,
  type ChargedAllocation,
  type FeeAllocation,
} from './allocation-fees';

const rent = (
  id: string,
  amountMinor: number,
  over: Partial<FeeAllocation> = {},
): FeeAllocation => ({
  id,
  lineId: 'L1',
  lineKind: 'rent',
  source: 'payment',
  paymentId: 'p1',
  amountMinor,
  ...over,
});

describe('AC-02 fees tied to allocations (M9 review, must-fix 1)', () => {
  it('carries a fee only on money allocated to rent or service charge', () => {
    expect(feeBearing({ lineKind: 'rent', source: 'payment' })).toBe(true);
    expect(feeBearing({ lineKind: 'service_charge', source: 'withholding' })).toBe(true);
    expect(feeBearing({ lineKind: 'rent', source: 'deposit' })).toBe(true);
    expect(feeBearing({ lineKind: 'deposit', source: 'payment' })).toBe(false);
    expect(feeBearing({ lineKind: 'rent', source: 'credit_note' })).toBe(false);
    expect(feeBearing({ lineKind: 'rent', source: 'write_off' })).toBe(false);
  });

  it('rounds an event once per payment and splits the fee by largest remainder', () => {
    const [charge] = chargeAllocations(
      [
        rent('a', 100_005),
        rent('b', 33_333, { lineId: 'L2' }),
        rent('d', 9_000, { lineKind: 'deposit' }),
      ],
      1000,
    );
    expect(charge).toMatchObject({ paymentId: 'p1', baseMinor: 133_338, feeMinor: 13_334 });
    expect(charge!.parts.map((p) => p.feeMinor).reduce((s, f) => s + f, 0)).toBe(13_334);
    expect(charge!.parts.map((p) => p.allocationId)).toEqual(['a', 'b']);
  });

  it('undoes the latest allocations of the same line, source and payment first', () => {
    const history = [
      rent('old', 60_000),
      rent('new', 40_000),
      rent('other', 50_000, { paymentId: 'p2' }),
      rent('neg', -50_000),
    ];
    expect(undoings(history, new Set(['neg']))).toEqual([
      { allocationId: 'neg', undoesId: 'new', amountMinor: 40_000 },
      { allocationId: 'neg', undoesId: 'old', amountMinor: 10_000 },
    ]);
  });

  it('takes back nothing for money allocated before the terms began, and all of a wholly undone fee', () => {
    const charged = new Map<string, ChargedAllocation>([
      [
        'new',
        {
          allocationId: 'new',
          baseMinor: 40_000,
          feeMinor: 4_000,
          takenBaseMinor: 0,
          takenFeeMinor: 0,
        },
      ],
    ]);
    const back = takeBacks(
      [
        { allocationId: 'neg', undoesId: 'new', amountMinor: 40_000 },
        { allocationId: 'neg', undoesId: 'old', amountMinor: 10_000 },
      ],
      charged,
    );
    expect(back).toEqual([
      { allocationId: 'neg', chargedAllocationId: 'new', baseMinor: 40_000, feeMinor: 4_000 },
    ]);
  });

  /** A random history: charges at a rate (or none, before the terms), and undoings. */
  const history = fc
    .array(
      fc.record({
        line: fc.constantFrom('L1', 'L2'),
        payment: fc.constantFrom('p1', 'p2'),
        amount: fc.integer({ min: 1, max: 500_000 }),
        undo: fc.boolean(),
        rate: fc.constantFrom(null, 750, 1000, 1250),
      }),
      { minLength: 1, maxLength: 30 },
    )
    .map((steps) => steps);

  it('★ property: each allocation carries its fee once, and undoing takes back its exact share', () => {
    fc.assert(
      fc.property(history, (steps) => {
        const all: FeeAllocation[] = [];
        const charged = new Map<string, ChargedAllocation>();
        const live = new Map<string, number>();
        let posted = 0;
        steps.forEach((s, i) => {
          const id = `a${i}`;
          if (s.undo) {
            const row = rent(id, -s.amount, { lineId: s.line, paymentId: s.payment });
            all.push(row);
            const undone = undoings(all, new Set([id]));
            for (const u of undone)
              live.set(u.undoesId, (live.get(u.undoesId) ?? 0) - u.amountMinor);
            for (const t of takeBacks(undone, charged)) {
              const c = charged.get(t.chargedAllocationId)!;
              charged.set(c.allocationId, {
                ...c,
                takenBaseMinor: c.takenBaseMinor + t.baseMinor,
                takenFeeMinor: c.takenFeeMinor + t.feeMinor,
              });
              posted -= t.feeMinor;
            }
          } else {
            const row = rent(id, s.amount, { lineId: s.line, paymentId: s.payment });
            all.push(row);
            live.set(id, s.amount);
            if (s.rate !== null)
              for (const c of chargeAllocations([row], s.rate))
                for (const p of c.parts) {
                  charged.set(p.allocationId, {
                    allocationId: p.allocationId,
                    baseMinor: p.baseMinor,
                    feeMinor: p.feeMinor,
                    takenBaseMinor: 0,
                    takenFeeMinor: 0,
                  });
                  posted += p.feeMinor;
                }
          }
        });
        // The fees posted equal, allocation by allocation, the fee on what is still live.
        let expected = 0;
        for (const c of charged.values()) {
          expect(c.takenBaseMinor).toBeLessThanOrEqual(c.baseMinor);
          expect(c.takenFeeMinor).toBeLessThanOrEqual(c.feeMinor);
          const left = live.get(c.allocationId) ?? 0;
          expect(c.baseMinor - c.takenBaseMinor).toBe(left);
          expect(c.feeMinor - c.takenFeeMinor).toBe(
            liveFeeMinor({
              baseMinor: c.baseMinor,
              feeMinor: c.feeMinor,
              undoneBaseMinor: c.baseMinor - left,
            }),
          );
          expected += c.feeMinor - c.takenFeeMinor;
        }
        expect(posted).toBe(expected);
        // Undo everything: no fee is left.
        const rest = [...live.entries()].filter(([, v]) => v > 0);
        let n = steps.length;
        for (const [id, left] of rest) {
          const src = all.find((a) => a.id === id)!;
          const neg = rent(`z${n++}`, -left, { lineId: src.lineId, paymentId: src.paymentId });
          all.push(neg);
          for (const t of takeBacks(undoings(all, new Set([neg.id])), charged)) {
            const c = charged.get(t.chargedAllocationId)!;
            charged.set(c.allocationId, {
              ...c,
              takenBaseMinor: c.takenBaseMinor + t.baseMinor,
              takenFeeMinor: c.takenFeeMinor + t.feeMinor,
            });
            posted -= t.feeMinor;
          }
        }
        expect(posted).toBe(0);
        for (const c of charged.values()) expect(c.takenFeeMinor).toBe(c.feeMinor);
      }),
      { numRuns: 300 },
    );
  });
});
