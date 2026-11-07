import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GRA_PAYERS,
  remittanceProblems,
  rentTaxHoldBackMinor,
  suggestRemittance,
  type GraPayer,
} from './owner-posting';

describe('AC-05 rent tax held back when the agency pays GRA (founder decision, 2026-11-05)', () => {
  it('holds back the owner’s rent tax payable when the agency pays GRA', () => {
    expect(
      suggestRemittance({
        agentHeldMinor: 1_000_000,
        feesDueMinor: 100_000,
        rentTax: { graPaidBy: 'agency', payableMinor: 150_000 },
      }),
    ).toEqual({ totalMinor: 850_000, feesRetainedMinor: 100_000, netMinor: 750_000 });
  });

  it('holds back nothing when the owner pays GRA, or when nobody said', () => {
    const owner = suggestRemittance({
      agentHeldMinor: 1_000_000,
      feesDueMinor: 100_000,
      rentTax: { graPaidBy: 'owner', payableMinor: 150_000 },
    });
    expect(owner).toEqual({ totalMinor: 1_000_000, feesRetainedMinor: 100_000, netMinor: 900_000 });
    expect(suggestRemittance({ agentHeldMinor: 1_000_000, feesDueMinor: 100_000 })).toEqual(owner);
    expect(rentTaxHoldBackMinor({ graPaidBy: 'owner', payableMinor: 150_000 })).toBe(0);
    expect(rentTaxHoldBackMinor(null)).toBe(0);
  });

  it('holds back nothing when no rent tax is payable', () => {
    expect(rentTaxHoldBackMinor({ graPaidBy: 'agency', payableMinor: 0 })).toBe(0);
    // Tax paid ahead of what was accrued (a reversal after payment) leaves 2200 in debit.
    expect(rentTaxHoldBackMinor({ graPaidBy: 'agency', payableMinor: -12_000 })).toBe(0);
  });

  it('holds back rent tax before retaining fees when the cash is short', () => {
    const rentTax = { graPaidBy: 'agency', payableMinor: 150_000 } as const;
    expect(suggestRemittance({ agentHeldMinor: 120_000, feesDueMinor: 50_000, rentTax })).toEqual({
      totalMinor: 0,
      feesRetainedMinor: 0,
      netMinor: 0,
    });
    expect(suggestRemittance({ agentHeldMinor: 180_000, feesDueMinor: 50_000, rentTax })).toEqual({
      totalMinor: 30_000,
      feesRetainedMinor: 30_000,
      netMinor: 0,
    });
    expect(
      suggestRemittance({
        agentHeldMinor: 500_000,
        feesDueMinor: 50_000,
        reserveMinor: 20_000,
        rentTax,
      }),
    ).toEqual({ totalMinor: 330_000, feesRetainedMinor: 50_000, netMinor: 280_000 });
  });

  it('flags a remittance that reaches into the rent tax the agency must pay', () => {
    const base = { agentHeldMinor: 1_000_000, feesDueMinor: 100_000, feesRetainedMinor: 100_000 };
    const agency = { graPaidBy: 'agency', payableMinor: 150_000 } as const;
    expect(remittanceProblems({ ...base, totalMinor: 850_000, rentTax: agency })).toEqual([]);
    expect(remittanceProblems({ ...base, totalMinor: 850_001, rentTax: agency })).toEqual([
      'into_rent_tax',
    ]);
    expect(remittanceProblems({ ...base, totalMinor: 1_000_001, rentTax: agency })).toEqual([
      'over_agent_cash',
    ]);
    expect(
      remittanceProblems({
        ...base,
        totalMinor: 1_000_000,
        rentTax: { graPaidBy: 'owner', payableMinor: 150_000 },
      }),
    ).toEqual([]);
  });

  it('refuses a GRA payer that is neither', () => {
    expect(() =>
      rentTaxHoldBackMinor({ graPaidBy: 'landlord' as GraPayer, payableMinor: 1 }),
    ).toThrow(/agency or the owner/);
    expect(() => rentTaxHoldBackMinor({ graPaidBy: 'agency', payableMinor: 1.5 })).toThrow(
      /whole numbers/,
    );
  });

  it('never suggests remitting the rent tax the agency must pay', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000_000 }),
        fc.constantFrom(...GRA_PAYERS),
        (held, due, payable, graPaidBy) => {
          const rentTax = { graPaidBy, payableMinor: payable };
          const s = suggestRemittance({ agentHeldMinor: held, feesDueMinor: due, rentTax });
          const holdBack = rentTaxHoldBackMinor(rentTax);
          expect(holdBack).toBe(graPaidBy === 'agency' ? Math.max(0, payable) : 0);
          expect(s.netMinor + s.feesRetainedMinor).toBe(s.totalMinor);
          expect(s.totalMinor).toBe(Math.max(0, held - holdBack));
          expect(
            remittanceProblems({
              agentHeldMinor: held,
              feesDueMinor: due,
              totalMinor: s.totalMinor,
              feesRetainedMinor: s.feesRetainedMinor,
              rentTax,
            }),
          ).toEqual([]);
        },
      ),
    );
  });
});
