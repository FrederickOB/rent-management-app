import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { money, multiplyBps } from '../money/money';
import type { BookKind } from './accounts';
import {
  creditDrawFee,
  creditDrawFeeLines,
  feeMirrorLines,
  managementFeeKeys,
  percentageFee,
  type FeeDimensions,
} from './fees';
import { balanceOf, checkEntry } from './journal';

const OWNER = 'book-owner';
const kindOf = (): BookKind => 'owner';
const tenPercent = { kind: 'percentage', rateBps: 1_000 } as const;
const december: FeeDimensions = {
  propertyId: 'property-1',
  unitId: 'unit-1',
  leaseId: 'lease-1',
  tenantId: 'tenant-1',
  invoiceLineId: 'line-dec',
};

describe('AC-02 a fee on surplus when it is drawn (founder decision, 2026-11-05)', () => {
  it('charges an overpayment nothing when it arrives, and the drawn amount when it pays a month', () => {
    // GH₵2,000 paid against GH₵1,500 of rent: the GH₵500 surplus is not charged on arrival.
    expect(
      percentageFee({
        terms: tenPercent,
        parts: [
          { kind: 'rent', source: 'payment', amountMinor: 150_000 },
          { kind: 'surplus', source: 'payment', amountMinor: 50_000 },
        ],
      })?.feeMinor,
    ).toBe(15_000);
    // When December starts, P02 draws the GH₵500 onto it: GH₵500 of rent settled, charged 10%.
    const drawn = creditDrawFee({
      terms: tenPercent,
      kind: 'rent',
      draws: [{ paymentId: 'pay-1', amountMinor: 50_000 }],
      guard: { settledMinor: 200_000, chargedBaseMinor: 150_000 },
    });
    expect(drawn).toEqual({
      baseMinor: 50_000,
      rateBps: 1_000,
      feeMinor: 5_000,
      shares: [{ paymentId: 'pay-1', baseMinor: 50_000, feeMinor: 5_000 }],
    });
    const lines = creditDrawFeeLines({
      bookId: OWNER,
      dims: december,
      fee: drawn ?? { shares: [] },
    });
    checkEntry(lines, kindOf);
    expect(lines).toEqual([
      { ...december, paymentId: 'pay-1', bookId: OWNER, accountCode: '5100', amountMinor: 5_000 },
      { ...december, paymentId: 'pay-1', bookId: OWNER, accountCode: '2300', amountMinor: -5_000 },
    ]);
  });

  it('keys each draw’s fee on the entry that posted the draw', () => {
    expect(managementFeeKeys.creditDraw('P02:line-dec')).toBe('P14:P02:line-dec');
    expect(managementFeeKeys.creditDraw('P13:term-1:apply')).toBe('P14:P13:term-1:apply');
    expect(managementFeeKeys.creditDraw('P02:line-dec')).not.toBe(
      managementFeeKeys.event('line-dec'),
    );
  });

  it('charges credit drawn onto service charge, never onto VAT, levies or a deposit', () => {
    const draws = [{ paymentId: 'pay-1', amountMinor: 20_000 }];
    expect(creditDrawFee({ terms: tenPercent, kind: 'service_charge', draws })?.feeMinor).toBe(
      2_000,
    );
    for (const kind of ['vat', 'nhil', 'getfund', 'deposit', 'one_off'] as const)
      expect(creditDrawFee({ terms: tenPercent, kind, draws })).toEqual({
        baseMinor: 0,
        rateBps: 1_000,
        feeMinor: 0,
        shares: [],
      });
    expect(creditDrawFee({ terms: null, kind: 'rent', draws })).toBeNull();
    expect(
      creditDrawFee({ terms: { kind: 'fixed_per_unit', amountMinor: 5_000 }, kind: 'rent', draws }),
    ).toBeNull();
  });

  it('rounds once on the whole draw and splits the fee by payment, so a reversal mirrors its part', () => {
    const drawn = creditDrawFee({
      terms: { kind: 'percentage', rateBps: 5_000 },
      kind: 'rent',
      draws: [
        { paymentId: 'pay-1', amountMinor: 1 },
        { paymentId: 'pay-2', amountMinor: 1 },
        { paymentId: 'pay-3', amountMinor: 1 },
      ],
    });
    // 50% of 3 pesewas is 1.5, rounded once to 2; never three halves rounded to 3.
    expect(drawn?.feeMinor).toBe(2);
    expect(drawn?.shares).toEqual([
      { paymentId: 'pay-1', baseMinor: 1, feeMinor: 1 },
      { paymentId: 'pay-2', baseMinor: 1, feeMinor: 1 },
      { paymentId: 'pay-3', baseMinor: 1, feeMinor: 0 },
    ]);
    const lines = creditDrawFeeLines({
      bookId: OWNER,
      dims: december,
      fee: drawn ?? { shares: [] },
    });
    checkEntry(lines, kindOf);
    // pay-2 bounces: P21b mirrors what is left of its fees, this draw's part included.
    const net = balanceOf(lines, { accountCode: '5100', paymentId: 'pay-2' });
    const mirror = feeMirrorLines({
      bookId: OWNER,
      fees: [{ dims: { ...december, paymentId: 'pay-2' }, netMinor: net }],
    });
    expect(balanceOf([...lines, ...mirror], { accountCode: '5100', paymentId: 'pay-2' })).toBe(0);
    expect(balanceOf([...lines, ...mirror], { accountCode: '5100' })).toBe(1);
  });

  it('never charges credit twice: money a credit note released, drawn again, was charged once', () => {
    // November's GH₵1,500 was paid and charged; a credit note returns it to credit; December
    // starts and P02 draws it back. The lease has settled GH₵1,500 and been charged on GH₵1,500.
    expect(
      creditDrawFee({
        terms: tenPercent,
        kind: 'rent',
        draws: [{ paymentId: 'pay-1', amountMinor: 150_000 }],
        guard: { settledMinor: 150_000, chargedBaseMinor: 150_000 },
      }),
    ).toEqual({ baseMinor: 0, rateBps: 1_000, feeMinor: 0, shares: [] });
    // Cash a later withholding freed (P19 review 2), drawn onto the next month, is new rent.
    expect(
      creditDrawFee({
        terms: tenPercent,
        kind: 'rent',
        draws: [{ paymentId: 'pay-1', amountMinor: 150_000 }],
        guard: { settledMinor: 1_150_000, chargedBaseMinor: 1_000_000 },
      })?.feeMinor,
    ).toBe(15_000);
  });

  it('splits the base and the fee across payments exactly, never more fee than base on any', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 50_000_000 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.option(fc.integer({ min: 0, max: 300_000_000 }), { nil: undefined }),
        (amounts, rateBps, room) => {
          const draws = amounts.map((amountMinor, i) => ({ paymentId: `pay-${i}`, amountMinor }));
          const total = amounts.reduce((a, b) => a + b, 0);
          const drawn = creditDrawFee({
            terms: { kind: 'percentage', rateBps },
            kind: 'rent',
            draws,
            guard: room === undefined ? null : { settledMinor: room, chargedBaseMinor: 0 },
          });
          const base = drawn?.baseMinor ?? -1;
          expect(base).toBe(room === undefined ? total : Math.min(total, room));
          expect(drawn?.feeMinor).toBe(multiplyBps(money(base), rateBps).amountMinor);
          const shares = drawn?.shares ?? [];
          expect(shares.reduce((a, s) => a + s.baseMinor, 0)).toBe(base);
          expect(shares.reduce((a, s) => a + s.feeMinor, 0)).toBe(drawn?.feeMinor);
          for (const s of shares) {
            expect(s.baseMinor > 0).toBe(true);
            expect(s.feeMinor <= s.baseMinor).toBe(true);
            const drawnBy = draws.find((d) => d.paymentId === s.paymentId)?.amountMinor ?? -1;
            expect(s.baseMinor <= drawnBy).toBe(true);
          }
        },
      ),
    );
  });
});

describe('AC-02 the guard with fee-bearing credit draws', () => {
  type LeaseEvent =
    | { readonly type: 'receipt'; readonly rent: number; readonly surplus: number }
    | { readonly type: 'withholding_after_cash'; readonly amount: number }
    | { readonly type: 'credit_note'; readonly amount: number }
    | { readonly type: 'draw'; readonly amount: number };

  const amount = fc.integer({ min: 0, max: 5_000_000 });
  const leaseEvent: fc.Arbitrary<LeaseEvent> = fc.oneof(
    fc.record({ type: fc.constant('receipt' as const), rent: amount, surplus: amount }),
    fc.record({ type: fc.constant('withholding_after_cash' as const), amount }),
    fc.record({ type: fc.constant('credit_note' as const), amount }),
    fc.record({ type: fc.constant('draw' as const), amount }),
  );

  /**
   * One lease, every fee event through the guard: what is settled on rent, the credit it holds,
   * the base charged, the fees, and what credit notes released.
   */
  function run(events: readonly LeaseEvent[], rateBps: number, onEvent: (s: State) => void) {
    const s: State = { settled: 0, credit: 0, charged: 0, fees: 0, released: 0 };
    const terms = { kind: 'percentage', rateBps } as const;
    for (const e of events) {
      const before = { ...s };
      const guard = () => ({ settledMinor: s.settled, chargedBaseMinor: s.charged });
      let fee: { baseMinor: number; feeMinor: number } | null = null;
      if (e.type === 'receipt') {
        s.settled += e.rent;
        s.credit += e.surplus;
        fee = percentageFee({
          terms,
          parts: [
            { kind: 'rent', source: 'payment', amountMinor: e.rent },
            { kind: 'surplus', source: 'payment', amountMinor: e.surplus },
          ],
          guard: guard(),
        });
      } else if (e.type === 'withholding_after_cash') {
        // The tenant's cash on a paid month returns to credit; the withholding settles it instead.
        const w = Math.min(e.amount, s.settled);
        s.credit += w;
        fee = percentageFee({
          terms,
          parts: [{ kind: 'rent', source: 'withholding', amountMinor: w }],
          guard: guard(),
        });
      } else if (e.type === 'credit_note') {
        const c = Math.min(e.amount, s.settled);
        s.settled -= c;
        s.credit += c;
        s.released += c;
      } else {
        const d = Math.min(e.amount, s.credit);
        s.credit -= d;
        s.settled += d;
        fee = creditDrawFee({
          terms,
          kind: 'rent',
          draws: [{ paymentId: 'pay', amountMinor: d }],
          guard: guard(),
        });
      }
      if (fee) {
        expect(fee.feeMinor).toBe(multiplyBps(money(fee.baseMinor), rateBps).amountMinor);
        s.charged += fee.baseMinor;
        s.fees += fee.feeMinor;
        // No event takes the base charged above the rent settled.
        expect(s.charged <= Math.max(before.charged, s.settled)).toBe(true);
      }
      onEvent(s);
    }
  }
  interface State {
    settled: number;
    credit: number;
    charged: number;
    fees: number;
    released: number;
  }

  it('charges every pesewa of rent settled exactly once, drawn surplus included', () => {
    fc.assert(
      fc.property(
        fc.array(
          leaseEvent.filter((e) => e.type !== 'credit_note'),
          { maxLength: 25 },
        ),
        fc.integer({ min: 1, max: 10_000 }),
        (events, rateBps) => run(events, rateBps, (s) => expect(s.charged).toBe(s.settled)),
      ),
    );
  });

  it('charges above the rent settled only by money a credit note released, which is never charged again', () => {
    fc.assert(
      fc.property(
        fc.array(leaseEvent, { maxLength: 25 }),
        fc.integer({ min: 1, max: 10_000 }),
        (events, rateBps) =>
          run(events, rateBps, (s) => {
            expect(s.charged >= s.settled).toBe(true);
            expect(s.charged - s.settled <= s.released).toBe(true);
          }),
      ),
    );
  });
});
