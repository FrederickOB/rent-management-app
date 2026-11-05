import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LINE_KINDS } from '../billing/lines';
import { allocate, money, multiplyBps } from '../money/money';
import type { BookKind } from './accounts';
import {
  billableInMonth,
  chargeableFeeBase,
  checkFeeTerms,
  FEE_BASE_SOURCES,
  feeBaseOf,
  feeMirrorLines,
  feeOnBaseMinor,
  feeTermsOn,
  fixedFeesForMonth,
  managementFeeKeys,
  managementFeeLines,
  managementFeeReversalLines,
  percentageFee,
  refundedFeeBaseMinor,
  refundFeeReversalMinor,
  type FeeBasePart,
  type FeeDimensions,
  type FeeTermsVersion,
} from './fees';
import { balanceOf, checkEntry } from './journal';

const OWNER = 'book-owner';
const kindOf = (): BookKind => 'owner';
const receiptDims: FeeDimensions = {
  propertyId: 'property-1',
  unitId: 'unit-1',
  leaseId: 'lease-1',
  tenantId: 'tenant-1',
  paymentId: 'payment-1',
};
const tenPercent = { kind: 'percentage', rateBps: 1_000 } as const;

const part = (
  kind: FeeBasePart['kind'],
  amountMinor: number,
  source: FeeBasePart['source'] = 'payment',
): FeeBasePart => ({ kind, amountMinor, source });

describe('AC-02 management fee terms', () => {
  it('takes a percentage in basis points or a fixed amount per unit, or no fee', () => {
    expect(checkFeeTerms({ kind: 'percentage', rateBps: 800 })).toEqual({
      kind: 'percentage',
      rateBps: 800,
    });
    expect(checkFeeTerms({ kind: 'fixed_per_unit', amountMinor: 5_000 })).toEqual({
      kind: 'fixed_per_unit',
      amountMinor: 5_000,
    });
    expect(checkFeeTerms({ kind: 'none' })).toEqual({ kind: 'none' });
  });

  it('refuses a rate that is not whole basis points from 1 to 10,000, and a fixed fee of nothing', () => {
    for (const rateBps of [0, -1, 10_001, 7.5])
      expect(() => checkFeeTerms({ kind: 'percentage', rateBps })).toThrow(/basis points/);
    for (const amountMinor of [0, -5, 1.5])
      expect(() => checkFeeTerms({ kind: 'fixed_per_unit', amountMinor })).toThrow(/positive/);
  });

  it('uses the version in force on the date, with no backfill before the first', () => {
    const versions: FeeTermsVersion[] = [
      { effectiveFrom: '2026-11-01', terms: tenPercent },
      { effectiveFrom: '2027-01-01', terms: { kind: 'fixed_per_unit', amountMinor: 10_000 } },
      { effectiveFrom: '2026-12-01', terms: { kind: 'percentage', rateBps: 900 } },
    ];
    expect(feeTermsOn(versions, '2026-10-31')).toBeNull();
    expect(feeTermsOn(versions, '2026-11-01')?.terms).toEqual(tenPercent);
    expect(feeTermsOn(versions, '2026-12-15')?.terms).toEqual({ kind: 'percentage', rateBps: 900 });
    expect(feeTermsOn(versions, '2027-03-01')?.terms.kind).toBe('fixed_per_unit');
    expect(feeTermsOn([], '2026-11-01')).toBeNull();
  });

  it('takes the later of two versions made for the same day', () => {
    const versions: FeeTermsVersion[] = [
      { effectiveFrom: '2026-11-01', terms: tenPercent },
      { effectiveFrom: '2026-11-01', terms: { kind: 'none' } },
    ];
    expect(feeTermsOn(versions, '2026-11-20')?.terms).toEqual({ kind: 'none' });
  });
});

describe('AC-02 management fee base (OQ-31)', () => {
  it('counts rent and service charge settled, advances, deposits applied to rent and tax withheld', () => {
    expect(
      feeBaseOf([
        part('rent', 150_000),
        part('service_charge', 20_000),
        part('rent', 300_000, 'payment'),
        part('rent', 50_000, 'deposit'),
        part('rent', 22_500, 'withholding'),
      ]),
    ).toBe(542_500);
  });

  it('leaves out deposits paid in, VAT and levies, one-off charges and surplus', () => {
    expect(
      feeBaseOf([
        part('deposit', 300_000),
        part('vat', 22_500),
        part('nhil', 3_750),
        part('getfund', 3_750),
        part('one_off', 10_000),
        part('surplus', 7_000),
        part('rent', 150_000),
      ]),
    ).toBe(150_000);
  });

  it('worked example B: 10% of GH₵8,500 cash and GH₵1,500 withheld is GH₵1,000', () => {
    expect(
      percentageFee({
        terms: tenPercent,
        parts: [part('rent', 850_000), part('rent', 150_000, 'withholding')],
      }),
    ).toEqual({ baseMinor: 1_000_000, rateBps: 1_000, feeMinor: 100_000 });
  });

  it('charges a two-year advance on receipt, in full', () => {
    expect(percentageFee({ terms: tenPercent, parts: [part('rent', 3_600_000)] })?.feeMinor).toBe(
      360_000,
    );
  });

  it('rounds half up to the pesewa, once on the whole base', () => {
    expect(feeOnBaseMinor(1_234, 750)).toBe(93); // 92.55
    expect(feeOnBaseMinor(1_233, 750)).toBe(92); // 92.475
    expect(feeOnBaseMinor(10, 500)).toBe(1); // 0.5
    // Three lines of 5 pesewas at 10%: once on 15 (1.5 → 2), never 3 × 0.5 → 3.
    expect(
      percentageFee({
        terms: tenPercent,
        parts: [part('rent', 5), part('rent', 5), part('service_charge', 5)],
      })?.feeMinor,
    ).toBe(2);
  });

  it('charges nothing without percentage terms: none, fixed, or before the agreement', () => {
    const parts = [part('rent', 150_000)];
    expect(percentageFee({ terms: null, parts })).toBeNull();
    expect(percentageFee({ terms: { kind: 'none' }, parts })).toBeNull();
    expect(
      percentageFee({ terms: { kind: 'fixed_per_unit', amountMinor: 5_000 }, parts }),
    ).toBeNull();
  });

  it('never charges a month twice when withholding arrives after the cash paid it (P19 review 2)', () => {
    // GH₵10,000 paid in cash and charged; GH₵1,500 withheld later returns that much cash to credit.
    expect(
      percentageFee({
        terms: tenPercent,
        parts: [part('rent', 150_000, 'withholding')],
        guard: { settledMinor: 1_000_000, chargedBaseMinor: 1_000_000 },
      }),
    ).toEqual({ baseMinor: 0, rateBps: 1_000, feeMinor: 0 });
    // Withholding on a month the cash had not paid is charged in full.
    expect(
      chargeableFeeBase(150_000, { settledMinor: 1_150_000, chargedBaseMinor: 1_000_000 }),
    ).toBe(150_000);
  });

  it('refuses negative parts and money from sources that settle nothing', () => {
    expect(() => feeBaseOf([part('rent', -1)])).toThrow(/zero or more/);
    expect(() =>
      feeBaseOf([{ kind: 'rent', amountMinor: 100, source: 'credit_note' as never }]),
    ).toThrow(/carries no fee/);
  });
});

describe('AC-02 P14 management fee posting', () => {
  it('posts Dr 5100, Cr 2300 on the receipt’s lease and payment', () => {
    const lines = managementFeeLines({ bookId: OWNER, dims: receiptDims, amountMinor: 100_000 });
    checkEntry(lines, kindOf);
    expect(lines).toEqual([
      { ...receiptDims, bookId: OWNER, accountCode: '5100', amountMinor: 100_000 },
      { ...receiptDims, bookId: OWNER, accountCode: '2300', amountMinor: -100_000 },
    ]);
  });

  it('posts nothing for a zero fee, and needs the property', () => {
    expect(managementFeeLines({ bookId: OWNER, dims: receiptDims, amountMinor: 0 })).toEqual([]);
    expect(() =>
      managementFeeLines({
        bookId: OWNER,
        dims: { ...receiptDims, propertyId: '' },
        amountMinor: 100,
      }),
    ).toThrow(/names its property/);
    expect(() => managementFeeLines({ bookId: OWNER, dims: receiptDims, amountMinor: -1 })).toThrow(
      /zero or more/,
    );
  });

  it('mirrors what is left of a payment’s fee on its reversal (P21b)', () => {
    const fee = managementFeeLines({ bookId: OWNER, dims: receiptDims, amountMinor: 100_000 });
    const refunded = managementFeeReversalLines({
      bookId: OWNER,
      dims: receiptDims,
      amountMinor: 60_000,
    });
    const net = balanceOf([...fee, ...refunded], { accountCode: '5100', paymentId: 'payment-1' });
    const mirror = feeMirrorLines({ bookId: OWNER, fees: [{ dims: receiptDims, netMinor: net }] });
    checkEntry(mirror, kindOf);
    const all = [...fee, ...refunded, ...mirror];
    expect(balanceOf(all, { accountCode: '5100' })).toBe(0);
    expect(balanceOf(all, { accountCode: '2300' })).toBe(0);
    expect(feeMirrorLines({ bookId: OWNER, fees: [{ dims: receiptDims, netMinor: 0 }] })).toEqual(
      [],
    );
  });

  it('keys each event (plan 4.2)', () => {
    expect(managementFeeKeys.event('payment-1')).toBe('P14:payment-1');
    expect(managementFeeKeys.fixed('owner-1', 'unit-1', '2026-11')).toBe(
      'P14:owner-1:unit-1:2026-11',
    );
    expect(managementFeeKeys.paymentReversal('payment-1')).toBe('P21:payment-1:fee');
    expect(managementFeeKeys.refund('refund-1', 'payment-1')).toBe('P14:refund-1:payment-1:refund');
  });
});

describe('AC-02 fixed fee per billable unit (D8)', () => {
  const fixed: FeeTermsVersion[] = [
    { effectiveFrom: '2026-01-01', terms: { kind: 'fixed_per_unit', amountMinor: 20_000 } },
  ];

  it('bills a unit with an active lease on any day of the month', () => {
    expect(billableInMonth([{ startDate: '2026-06-01', lastDay: '2026-11-01' }], '2026-11')).toBe(
      true,
    );
    expect(billableInMonth([{ startDate: '2026-11-30', lastDay: null }], '2026-11')).toBe(true);
    expect(billableInMonth([{ startDate: '2025-01-15', lastDay: null }], '2026-11')).toBe(true);
    expect(billableInMonth([{ startDate: '2026-06-01', lastDay: '2026-10-31' }], '2026-11')).toBe(
      false,
    );
    expect(billableInMonth([{ startDate: '2026-12-01', lastDay: null }], '2026-11')).toBe(false);
    expect(billableInMonth([], '2026-11')).toBe(false);
    expect(billableInMonth([{ startDate: '2028-02-29', lastDay: null }], '2028-02')).toBe(true);
  });

  it('charges each billable unit once, in property and unit order, keyed per owner, unit and month', () => {
    const fees = fixedFeesForMonth({
      ownerId: 'owner-1',
      month: '2026-11',
      versions: fixed,
      units: [
        { propertyId: 'p2', unitId: 'u3', leases: [{ startDate: '2026-01-01', lastDay: null }] },
        { propertyId: 'p1', unitId: 'u2', leases: [] },
        {
          propertyId: 'p1',
          unitId: 'u1',
          leases: [
            { startDate: '2026-01-01', lastDay: '2026-11-10' },
            { startDate: '2026-11-20', lastDay: null },
          ],
        },
      ],
    });
    expect(fees).toEqual([
      { key: 'P14:owner-1:u1:2026-11', propertyId: 'p1', unitId: 'u1', amountMinor: 20_000 },
      { key: 'P14:owner-1:u3:2026-11', propertyId: 'p2', unitId: 'u3', amountMinor: 20_000 },
    ]);
  });

  it('counts only days on or after the terms took effect, and the terms in force at the month’s end', () => {
    const midMonth: FeeTermsVersion[] = [
      { effectiveFrom: '2026-11-15', terms: { kind: 'fixed_per_unit', amountMinor: 20_000 } },
    ];
    const units = [
      {
        propertyId: 'p1',
        unitId: 'gone',
        leases: [{ startDate: '2026-01-01', lastDay: '2026-11-14' }],
      },
      { propertyId: 'p1', unitId: 'stays', leases: [{ startDate: '2026-01-01', lastDay: null }] },
    ];
    expect(
      fixedFeesForMonth({ ownerId: 'o', month: '2026-11', versions: midMonth, units }).map(
        (f) => f.unitId,
      ),
    ).toEqual(['stays']);
    expect(
      fixedFeesForMonth({ ownerId: 'o', month: '2026-10', versions: midMonth, units }),
    ).toEqual([]);
    const switched: FeeTermsVersion[] = [
      ...fixed,
      { effectiveFrom: '2026-11-20', terms: tenPercent },
    ];
    expect(
      fixedFeesForMonth({ ownerId: 'o', month: '2026-11', versions: switched, units }),
    ).toEqual([]);
  });

  it('refuses a unit listed twice and a month that is not one', () => {
    const unit = { propertyId: 'p1', unitId: 'u1', leases: [] };
    expect(() =>
      fixedFeesForMonth({ ownerId: 'o', month: '2026-11', versions: fixed, units: [unit, unit] }),
    ).toThrow(/listed twice/);
    expect(() => billableInMonth([], '2026-13')).toThrow(/Not a month/);
  });
});

describe('AC-02 a fee on advance rent later refunded (M9 decision 3)', () => {
  it('takes back the fee on the refunded part, in proportion', () => {
    // GH₵10,000 of rent at 10%; an early end refunds GH₵6,000 of it.
    expect(
      refundFeeReversalMinor({
        feeMinor: 100_000,
        baseMinor: 1_000_000,
        refundedBaseBeforeMinor: 0,
        refundedBaseMinor: 600_000,
      }),
    ).toBe(60_000);
  });

  it('adds up to the fee exactly when the base is refunded in parts', () => {
    const parts = [1, 1, 1].map((now, i) =>
      refundFeeReversalMinor({
        feeMinor: 100,
        baseMinor: 3,
        refundedBaseBeforeMinor: i,
        refundedBaseMinor: now,
      }),
    );
    expect(parts).toEqual([33, 34, 33]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('treats the released advance as refunded before surplus that never bore a fee', () => {
    // A receipt of GH₵12,000: GH₵10,000 of rent (the base) and GH₵2,000 surplus. The early end
    // releases GH₵6,000 of the rent, so the owner keeps GH₵4,000.
    const base = { baseMinor: 1_000_000, keptBaseMinor: 400_000, refundedBaseBeforeMinor: 0 };
    expect(refundedFeeBaseMinor({ ...base, refundMinor: 800_000 })).toBe(600_000);
    expect(refundedFeeBaseMinor({ ...base, refundMinor: 300_000 })).toBe(300_000);
    expect(
      refundedFeeBaseMinor({ ...base, refundedBaseBeforeMinor: 300_000, refundMinor: 500_000 }),
    ).toBe(300_000);
    // Credit applied to open rent since the release is kept, and bears its fee.
    expect(refundedFeeBaseMinor({ ...base, keptBaseMinor: 1_100_000, refundMinor: 800_000 })).toBe(
      0,
    );
  });

  it('refuses a refund beyond the base', () => {
    expect(() =>
      refundFeeReversalMinor({
        feeMinor: 100,
        baseMinor: 1_000,
        refundedBaseBeforeMinor: 600,
        refundedBaseMinor: 401,
      }),
    ).toThrow(/than the fee base/);
  });
});

describe('AC-02 management fee properties', () => {
  const amount = fc.integer({ min: 0, max: 1_000_000_000 });
  const rate = fc.integer({ min: 1, max: 10_000 });

  it('a fee never exceeds rate × base, rounded half up once', () => {
    fc.assert(
      fc.property(fc.array(amount, { minLength: 1, maxLength: 6 }), rate, (amounts, rateBps) => {
        const parts = amounts.map((a, i) => part(i % 2 === 0 ? 'rent' : 'service_charge', a));
        const fee = percentageFee({ terms: { kind: 'percentage', rateBps }, parts });
        const base = amounts.reduce((a, b) => a + b, 0);
        expect(fee?.baseMinor).toBe(base);
        const exact = BigInt(base) * BigInt(rateBps);
        const charged = BigInt(fee?.feeMinor ?? -1) * 10_000n;
        // Within half a pesewa of the exact product, and only ever above it by rounding half up.
        expect(charged * 2n - exact * 2n <= 10_000n).toBe(true);
        expect(exact * 2n - charged * 2n < 10_000n).toBe(true);
        expect(fee?.feeMinor).toBe(multiplyBps(money(base), rateBps).amountMinor);
        expect((fee?.feeMinor ?? 0) <= base).toBe(true);
      }),
    );
  });

  it('a fee with the guard never exceeds rate × the rent its lease has not been charged on', () => {
    fc.assert(
      fc.property(amount, amount, amount, rate, (event, settled, charged, rateBps) => {
        const fee = percentageFee({
          terms: { kind: 'percentage', rateBps },
          parts: [part('rent', event)],
          guard: { settledMinor: settled, chargedBaseMinor: charged },
        });
        const base = fee?.baseMinor ?? -1;
        expect(base >= 0 && base <= event).toBe(true);
        expect(base <= Math.max(0, settled - charged)).toBe(true);
      }),
    );
  });

  it('the reversals of a fee sum back to it exactly, however the base is refunded', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        rate,
        fc.array(fc.integer({ min: 1, max: 1_000 }), { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        (base, rateBps, weights, mirrorTheRest) => {
          const fee = feeOnBaseMinor(base, rateBps);
          // Split the base into refunds in proportion to the weights, by largest remainder.
          const refunds = allocate(money(base), weights).map((m) => m.amountMinor);
          // Optionally stop part way and let a payment reversal mirror what is left (P21b).
          const taken = mirrorTheRest ? refunds.slice(0, Math.ceil(refunds.length / 2)) : refunds;
          let before = 0;
          let reversed = 0;
          for (const now of taken) {
            const back = refundFeeReversalMinor({
              feeMinor: fee,
              baseMinor: base,
              refundedBaseBeforeMinor: before,
              refundedBaseMinor: now,
            });
            expect(back >= 0).toBe(true);
            reversed += back;
            before += now;
            expect(reversed <= fee).toBe(true);
          }
          const mirror = fee - reversed;
          const lines = [
            ...managementFeeLines({ bookId: OWNER, dims: receiptDims, amountMinor: fee }),
            ...managementFeeReversalLines({
              bookId: OWNER,
              dims: receiptDims,
              amountMinor: reversed,
            }),
            ...feeMirrorLines({ bookId: OWNER, fees: [{ dims: receiptDims, netMinor: mirror }] }),
          ];
          if (!mirrorTheRest) expect(mirror).toBe(0);
          expect(balanceOf(lines, { accountCode: '5100' })).toBe(0);
          expect(balanceOf(lines, { accountCode: '2300' })).toBe(0);
        },
      ),
    );
  });

  it('fees are zero for deposits, VAT, one-off charges and surplus, from any source', () => {
    const notFeeBearing = LINE_KINDS.filter((k) => k !== 'rent' && k !== 'service_charge');
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom<FeeBasePart['kind']>(...notFeeBearing, 'surplus'),
            source: fc.constantFrom(...FEE_BASE_SOURCES),
            amountMinor: amount,
          }),
          { maxLength: 8 },
        ),
        rate,
        (parts, rateBps) => {
          const fee = percentageFee({ terms: { kind: 'percentage', rateBps }, parts });
          expect(fee).toEqual({ baseMinor: 0, rateBps, feeMinor: 0 });
          expect(
            managementFeeLines({
              bookId: OWNER,
              dims: receiptDims,
              amountMinor: fee?.feeMinor ?? 0,
            }),
          ).toEqual([]);
        },
      ),
    );
  });

  it('every fee entry balances in the owner’s book', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), (fee) => {
        checkEntry(
          managementFeeLines({ bookId: OWNER, dims: receiptDims, amountMinor: fee }),
          kindOf,
        );
        checkEntry(
          managementFeeReversalLines({ bookId: OWNER, dims: receiptDims, amountMinor: fee }),
          kindOf,
        );
      }),
    );
  });
});
