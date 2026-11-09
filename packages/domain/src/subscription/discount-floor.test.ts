import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SUBSCRIPTION_TIERS } from '../settings/entitlements';
import {
  monthBounds,
  monthlyBill,
  proratedMinimumMinor,
  tierSpans,
  type DiscountTerms,
  type PriceList,
} from './pricing';

/**
 * Founder answer Q4 (M10 review BE-8): a discount code never takes the bill below the tier's
 * minimum, prorated for a part month. Property-based, on the bill itself.
 */
const MONTHS = ['2026-02', '2028-02', '2026-04', '2026-11', '2026-12'];

const priceArb = fc.record({
  single_room: fc.nat(20_000),
  self_contained: fc.nat(50_000),
  commercial: fc.nat(100_000),
  minimumMinor: fc.nat(1_000_000),
  annualDiscountBps: fc.nat(10_000),
});

const discountArb: fc.Arbitrary<DiscountTerms> = fc.oneof(
  fc.record({
    kind: fc.constant('percentage' as const),
    percentBps: fc.integer({ min: 1, max: 10_000 }),
    code: fc.constant('PCT'),
  }),
  fc.record({
    kind: fc.constant('fixed' as const),
    amountMinor: fc.integer({ min: 1, max: 10_000_000 }),
    code: fc.constant('FIX'),
  }),
);

describe('PB-05 discount codes floor at the prorated minimum (founder answer Q4)', () => {
  it('★ the net after a code is never below the prorated minimum, and never above the bill without it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MONTHS),
        fc.constantFrom(...SUBSCRIPTION_TIERS),
        priceArb,
        fc.record({ single_room: fc.nat(40), self_contained: fc.nat(40), commercial: fc.nat(40) }),
        fc.integer({ min: 0, max: 27 }),
        discountArb,
        fc.boolean(),
        (month, tier, p, counts, startOffset, discount, annual) => {
          const prices: PriceList = {
            tier,
            ratesMinor: {
              single_room: p.single_room,
              self_contained: p.self_contained,
              commercial: p.commercial,
            },
            minimumMinor: p.minimumMinor,
            annualDiscountBps: p.annualDiscountBps,
          };
          const first = monthBounds(month).first;
          const from = `${month}-${String(1 + startOffset).padStart(2, '0')}`;
          const spans = tierSpans({
            month,
            changes: [{ tier, from: first }],
            billFrom: from,
            billTo: null,
            pricesFor: () => prices,
          });
          const withCode = monthlyBill({ month, counts, spans, annual, discount, vat: null });
          const without = monthlyBill({ month, counts, spans, annual, discount: null, vat: null });
          const floor = proratedMinimumMinor(month, spans);
          expect(withCode.netMinor).toBeGreaterThanOrEqual(floor);
          expect(withCode.netMinor).toBeLessThanOrEqual(without.netMinor);
          expect(withCode.subtotalMinor).toBe(without.subtotalMinor);
          // The code takes what it asks for, down to the floor and no further.
          const wanted =
            discount.kind === 'percentage'
              ? Math.floor((without.subtotalMinor * discount.percentBps) / 10_000)
              : discount.amountMinor;
          const room = Math.max(0, without.subtotalMinor - floor);
          expect(-withCode.discountMinor).toBeLessThanOrEqual(Math.min(wanted + 1, room));
          expect(-withCode.discountMinor).toBeGreaterThanOrEqual(Math.min(wanted, room));
        },
      ),
      { numRuns: 500 },
    );
  });
});
