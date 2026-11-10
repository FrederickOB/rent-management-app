import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, parseBusinessDate, toIsoDate } from '../dates';
import { BILLING_BANDS } from '../portfolio/unit-types';
import { SUBSCRIPTION_TIERS, type SubscriptionTier } from '../settings/entitlements';
import {
  compareMonths,
  daysInMonth,
  monthBounds,
  monthlyBill,
  monthOf,
  monthsBetween,
  nextMonth,
  percentText,
  previousMonth,
  proratedMinimumMinor,
  shiftMonth,
  tierSpans,
  type BandCounts,
  type DiscountTerms,
  type PriceList,
  type TierSpan,
} from './pricing';

/** The placeholder price lists of M10 decision 3 (OQ-37): test values, not real rates. */
const PRICES: Record<SubscriptionTier, PriceList> = {
  starter: {
    tier: 'starter',
    ratesMinor: { single_room: 500, self_contained: 1_000, commercial: 2_000 },
    minimumMinor: 5_000,
    annualDiscountBps: 1_000,
  },
  growth: {
    tier: 'growth',
    ratesMinor: { single_room: 800, self_contained: 1_500, commercial: 3_000 },
    minimumMinor: 15_000,
    annualDiscountBps: 1_000,
  },
  portfolio: {
    tier: 'portfolio',
    ratesMinor: { single_room: 1_200, self_contained: 2_200, commercial: 4_500 },
    minimumMinor: 40_000,
    annualDiscountBps: 1_000,
  },
};
const pricesFor = (tier: SubscriptionTier): PriceList => PRICES[tier];

/** VAT rates are inputs from the rules table (decision 10); these are only numbers for the test. */
const TEST_VAT = { vatBps: 1_500, nhilBps: 250, getfundBps: 250 };

const counts = (single_room = 0, self_contained = 0, commercial = 0): BandCounts => ({
  single_room,
  self_contained,
  commercial,
});

const wholeMonth = (month: string, tier: SubscriptionTier = 'growth'): TierSpan[] =>
  tierSpans({
    month,
    changes: [{ tier, from: '2025-01-01' }],
    billFrom: null,
    billTo: null,
    pricesFor,
  });

const bill = (
  spans: TierSpan[],
  c: BandCounts,
  extra: Partial<{
    annual: boolean;
    discount: DiscountTerms | null;
    vat: typeof TEST_VAT | null;
  }> = {},
  month = '2026-11',
) =>
  monthlyBill({
    month,
    counts: c,
    spans,
    annual: extra.annual ?? false,
    discount: extra.discount ?? null,
    vat: extra.vat ?? null,
  });

const dayOf = (month: string, offset: number): string =>
  toIsoDate(addDays(parseBusinessDate(`${month}-01`), offset));

describe('PB-02 calendar months (decision 2)', () => {
  it('knows each month’s days, bounds and neighbours', () => {
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
    expect(daysInMonth('2026-11')).toBe(30);
    expect(daysInMonth('2026-12')).toBe(31);
    expect(monthBounds('2026-11')).toEqual({ first: '2026-11-01', last: '2026-11-30' });
    expect(monthOf('2026-11-07')).toBe('2026-11');
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(shiftMonth('2026-11', 11)).toBe('2027-10');
    expect(monthsBetween('2026-11', '2027-01')).toBe(2);
    expect(monthsBetween('2027-01', '2026-11')).toBe(-2);
    expect(compareMonths('2026-11', '2026-12')).toBe(-1);
  });

  it('refuses what is not a month', () => {
    for (const bad of ['2026-13', '2026-1', 'Nov', '2026-11-01', ''])
      expect(() => daysInMonth(bad)).toThrow(/Not a month/);
  });

  it('writes rates in basis points for people', () => {
    expect(percentText(1_000)).toBe('10%');
    expect(percentText(1_250)).toBe('12.5%');
    expect(percentText(1_205)).toBe('12.05%');
    expect(percentText(25)).toBe('0.25%');
    expect(percentText(0)).toBe('0%');
  });
});

describe('PB-03 units lines by band', () => {
  it('charges each band’s units at its rate for the month, in plain words', () => {
    const result = bill(wholeMonth('2026-11'), counts(0, 12, 0));
    expect(result.lines).toEqual([
      {
        kind: 'units',
        description: 'Growth: 12 self-contained units, 30 of 30 days at GH₵15.00',
        tier: 'growth',
        band: 'self_contained',
        units: 12,
        rateMinor: 1_500,
        days: 30,
        daysInMonth: 30,
        rateBps: null,
        amountMinor: 18_000,
      },
    ]);
    expect(result).toMatchObject({
      subtotalMinor: 18_000,
      discountMinor: 0,
      netMinor: 18_000,
      vatMinor: 0,
      totalMinor: 18_000,
    });
  });

  it('lists the bands in order, with singular and plural nouns', () => {
    const result = bill(wholeMonth('2026-11'), counts(3, 2, 1));
    expect(result.lines.map((l) => [l.kind, l.description, l.amountMinor])).toEqual([
      ['units', 'Growth: 3 single rooms, 30 of 30 days at GH₵8.00', 2_400],
      ['units', 'Growth: 2 self-contained units, 30 of 30 days at GH₵15.00', 3_000],
      ['units', 'Growth: 1 commercial unit, 30 of 30 days at GH₵30.00', 3_000],
      ['minimum', 'Growth: top-up to the GH₵150.00 monthly minimum, 30 of 30 days', 6_600],
    ]);
    expect(result.totalMinor).toBe(15_000);
  });

  it('refuses counts that are not whole numbers and a price list for another tier', () => {
    expect(() => bill(wholeMonth('2026-11'), counts(-1))).toThrow(/whole number/);
    expect(() => bill(wholeMonth('2026-11'), counts(1.5))).toThrow(/whole number/);
    const [span] = wholeMonth('2026-11');
    expect(() => bill([{ ...span!, prices: PRICES.starter }], counts(1))).toThrow(/price list/);
  });
});

describe('PB-05 minimum', () => {
  it('bills a company with no billable units the minimum', () => {
    const result = bill(wholeMonth('2026-11'), counts());
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      kind: 'minimum',
      description: 'Growth: top-up to the GH₵150.00 monthly minimum, 30 of 30 days',
      tier: 'growth',
      rateMinor: 15_000,
      days: 30,
      amountMinor: 15_000,
    });
    expect(result.totalMinor).toBe(15_000);
  });

  it('prorates the minimum by days from the trial’s end (decision 5)', () => {
    // The trial's last day is 13 November: 17 billed days.
    const spans = tierSpans({
      month: '2026-11',
      changes: [{ tier: 'growth', from: '2026-10-15' }],
      billFrom: '2026-11-14',
      billTo: null,
      pricesFor,
    });
    expect(spans).toEqual([
      { tier: 'growth', firstDay: '2026-11-14', lastDay: '2026-11-30', prices: PRICES.growth },
    ]);
    expect(bill(spans, counts()).lines).toMatchObject([
      {
        kind: 'minimum',
        description: 'Growth: top-up to the GH₵150.00 monthly minimum, 17 of 30 days',
        amountMinor: 8_500,
      },
    ]);
    // 12 × GH₵15 × 17/30 = GH₵102 is above the prorated minimum: no top-up.
    expect(bill(spans, counts(0, 12)).lines.map((l) => [l.kind, l.amountMinor])).toEqual([
      ['units', 10_200],
    ]);
  });

  it('bills nothing in a month with no billable day', () => {
    const spans = tierSpans({
      month: '2026-10',
      changes: [{ tier: 'growth', from: '2026-10-15' }],
      billFrom: '2026-11-14',
      billTo: null,
      pricesFor,
    });
    expect(spans).toEqual([]);
    expect(bill(spans, counts(0, 12), { discount: null, vat: TEST_VAT }, '2026-10')).toEqual({
      lines: [],
      subtotalMinor: 0,
      discountMinor: 0,
      netMinor: 0,
      vatMinor: 0,
      totalMinor: 0,
    });
  });
});

describe('PB-05 proration across tier spans (decision 6)', () => {
  it('charges each tier for its own days on an upgrade', () => {
    const spans = tierSpans({
      month: '2026-11',
      changes: [
        { tier: 'growth', from: '2026-03-01' },
        { tier: 'portfolio', from: '2026-11-11' },
      ],
      billFrom: null,
      billTo: null,
      pricesFor,
    });
    expect(spans.map((s) => [s.tier, s.firstDay, s.lastDay])).toEqual([
      ['growth', '2026-11-01', '2026-11-10'],
      ['portfolio', '2026-11-11', '2026-11-30'],
    ]);
    const result = bill(spans, counts(0, 20));
    expect(result.lines.map((l) => [l.kind, l.description, l.amountMinor])).toEqual([
      // 20 × GH₵15 × 10/30 = GH₵100, above Growth's prorated GH₵50.
      ['units', 'Growth: 20 self-contained units, 10 of 30 days at GH₵15.00', 10_000],
      // 20 × GH₵22 × 20/30 = GH₵293.333…, rounded once; above Portfolio's prorated GH₵266.67.
      ['units', 'Portfolio: 20 self-contained units, 20 of 30 days at GH₵22.00', 29_333],
    ]);
    expect(result.totalMinor).toBe(39_333);
  });

  it('tops up each span to its own prorated minimum', () => {
    const spans = tierSpans({
      month: '2026-11',
      changes: [
        { tier: 'starter', from: '2026-01-01' },
        { tier: 'growth', from: '2026-11-21' },
      ],
      billFrom: null,
      billTo: null,
      pricesFor,
    });
    const result = bill(spans, counts(2));
    expect(result.lines.map((l) => [l.kind, l.tier, l.days, l.amountMinor])).toEqual([
      ['units', 'starter', 20, 667], // 2 × GH₵5 × 20/30
      ['minimum', 'starter', 20, 2_666], // GH₵50 × 20/30 = 3,333 less 667
      ['units', 'growth', 10, 533], // 2 × GH₵8 × 10/30
      ['minimum', 'growth', 10, 4_467], // GH₵150 × 10/30 = 5,000 less 533
    ]);
    expect(result.subtotalMinor).toBe(3_333 + 5_000);
  });

  it('stops at a cancellation and ignores days before the subscription', () => {
    expect(
      tierSpans({
        month: '2026-11',
        changes: [{ tier: 'starter', from: '2026-11-05' }],
        billFrom: null,
        billTo: '2026-11-20',
        pricesFor,
      }).map((s) => [s.firstDay, s.lastDay]),
    ).toEqual([['2026-11-05', '2026-11-20']]);
  });

  it('lets the later of two same-day changes win, and joins neighbouring spans on one tier', () => {
    const spans = tierSpans({
      month: '2026-11',
      changes: [
        { tier: 'growth', from: '2026-01-01' },
        { tier: 'portfolio', from: '2026-11-10' },
        { tier: 'growth', from: '2026-11-10' },
        { tier: 'growth', from: '2026-11-20' },
      ],
      billFrom: null,
      billTo: null,
      pricesFor,
    });
    expect(spans.map((s) => [s.tier, s.firstDay, s.lastDay])).toEqual([
      ['growth', '2026-11-01', '2026-11-30'],
    ]);
  });

  it('refuses a tier history out of date order and spans outside the month or overlapping', () => {
    expect(() =>
      tierSpans({
        month: '2026-11',
        changes: [
          { tier: 'growth', from: '2026-11-10' },
          { tier: 'starter', from: '2026-11-01' },
        ],
        billFrom: null,
        billTo: null,
        pricesFor,
      }),
    ).toThrow(/date order/);
    const [span] = wholeMonth('2026-11');
    expect(() => bill([{ ...span!, lastDay: '2026-12-01' }], counts())).toThrow(/inside the month/);
    expect(() =>
      bill(
        [
          { ...span!, lastDay: '2026-11-10' },
          { ...span!, firstDay: '2026-11-10' },
        ],
        counts(),
      ),
    ).toThrow(/overlapping/);
  });
});

describe('PB-05 annual rates (decision 7)', () => {
  it('discounts the units lines while an annual term runs', () => {
    const result = bill(wholeMonth('2026-11'), counts(0, 12), { annual: true });
    expect(result.lines).toMatchObject([
      {
        kind: 'units',
        description:
          'Growth: 12 self-contained units, 30 of 30 days at GH₵15.00, less the 10% annual discount',
        rateMinor: 1_500,
        rateBps: 1_000,
        amountMinor: 16_200,
      },
    ]);
  });

  it('never discounts the minimum: it is the floor', () => {
    const result = bill(wholeMonth('2026-11'), counts(0, 5), { annual: true });
    expect(result.lines.map((l) => [l.kind, l.amountMinor])).toEqual([
      ['units', 6_750],
      ['minimum', 8_250],
    ]);
    expect(result.subtotalMinor).toBe(15_000);
  });
});

describe('PB-05 discount codes (decision 8)', () => {
  const full = () => bill(wholeMonth('2026-11'), counts(0, 12)); // GH₵180

  it('takes a percentage off the subtotal as its own line', () => {
    const result = bill(wholeMonth('2026-11'), counts(0, 12), {
      discount: { kind: 'percentage', percentBps: 2_000, code: 'WELCOME20' },
    });
    expect(result.lines.at(-1)).toEqual({
      kind: 'discount',
      description: 'Discount code WELCOME20: 20% off',
      tier: null,
      band: null,
      units: null,
      rateMinor: null,
      days: null,
      daysInMonth: null,
      rateBps: 2_000,
      amountMinor: -3_000,
    });
    expect(result).toMatchObject({
      subtotalMinor: 18_000,
      discountMinor: -3_000,
      netMinor: 15_000,
    });
    expect(full().netMinor).toBe(18_000);
  });

  it('takes a fixed amount off, never more than the subtotal', () => {
    const fixed = (amountMinor: number) =>
      bill(wholeMonth('2026-11'), counts(0, 12), {
        discount: { kind: 'fixed', amountMinor, code: 'LAUNCH' },
      });
    expect(fixed(5_000).lines.at(-1)).toMatchObject({
      description: 'Discount code LAUNCH: GH₵50.00 off, down to the monthly minimum',
      rateMinor: 5_000,
      amountMinor: -3_000,
    });
    expect(fixed(50_000).lines.at(-1)).toMatchObject({
      description: 'Discount code LAUNCH: GH₵500.00 off, down to the monthly minimum',
      amountMinor: -3_000,
    });
    expect(fixed(50_000).netMinor).toBe(15_000);
  });

  it('adds no discount line when there is nothing to take off, and refuses bad terms', () => {
    const none = bill(wholeMonth('2026-11'), counts(0, 12), {
      discount: { kind: 'percentage', percentBps: 0, code: 'ZERO' },
    });
    expect(none.lines.map((l) => l.kind)).toEqual(['units']);
    expect(() =>
      bill(wholeMonth('2026-11'), counts(), {
        discount: { kind: 'percentage', percentBps: 10_001, code: 'X' },
      }),
    ).toThrow(/basis points/);
    expect(() =>
      bill(wholeMonth('2026-11'), counts(), {
        discount: { kind: 'fixed', amountMinor: -1, code: 'X' },
      }),
    ).toThrow(/zero or more/);
  });
});

describe('OQ-48 VAT on subscription invoices (decision 10)', () => {
  it('adds no VAT lines while the platform is not VAT-registered (rates null)', () => {
    expect(bill(wholeMonth('2026-11'), counts(0, 12)).lines.map((l) => l.kind)).toEqual(['units']);
  });

  it('adds VAT and levy lines on the net after the discount, each rounded once', () => {
    const result = bill(wholeMonth('2026-11'), counts(0, 12), {
      discount: { kind: 'percentage', percentBps: 2_000, code: 'WELCOME20' },
      vat: TEST_VAT,
    });
    expect(
      result.lines.slice(-3).map((l) => [l.kind, l.description, l.rateBps, l.amountMinor]),
    ).toEqual([
      ['vat', 'VAT at 15%', 1_500, 2_250],
      ['nhil', 'NHIL at 2.5%', 250, 375],
      ['getfund', 'GETFund levy at 2.5%', 250, 375],
    ]);
    expect(result).toMatchObject({ netMinor: 15_000, vatMinor: 3_000, totalMinor: 18_000 });
  });

  it('refuses a negative or fractional rate', () => {
    expect(() =>
      bill(wholeMonth('2026-11'), counts(), { vat: { ...TEST_VAT, vatBps: -1 } }),
    ).toThrow(/basis points/);
  });
});

// Property-based: random tier histories, trials, cancellations, counts, prices, codes and VAT.

const MONTHS = ['2026-02', '2028-02', '2026-04', '2026-11', '2026-12'];
const tierArb = fc.constantFrom(...SUBSCRIPTION_TIERS);
const priceListArb = (tier: SubscriptionTier) =>
  fc.record({
    tier: fc.constant(tier),
    ratesMinor: fc.record({
      single_room: fc.nat(20_000),
      self_contained: fc.nat(50_000),
      commercial: fc.nat(100_000),
    }),
    minimumMinor: fc.nat(1_000_000),
    annualDiscountBps: fc.nat(10_000),
  });
const pricesArb = fc.record({
  starter: priceListArb('starter'),
  growth: priceListArb('growth'),
  portfolio: priceListArb('portfolio'),
});
const discountArb: fc.Arbitrary<DiscountTerms | null> = fc.option(
  fc.oneof(
    fc.nat(10_000).map((percentBps) => ({ kind: 'percentage' as const, percentBps, code: 'P' })),
    fc.nat(2_000_000).map((amountMinor) => ({ kind: 'fixed' as const, amountMinor, code: 'F' })),
  ),
  { nil: null },
);
const vatArb = fc.option(
  fc.record({ vatBps: fc.nat(3_000), nhilBps: fc.nat(1_000), getfundBps: fc.nat(1_000) }),
  { nil: null },
);

const scenarioArb = fc.constantFrom(...MONTHS).chain((month) =>
  fc.record({
    month: fc.constant(month),
    changes: fc
      .array(fc.record({ tier: tierArb, offset: fc.integer({ min: -60, max: 35 }) }), {
        minLength: 1,
        maxLength: 4,
      })
      .map((cs) =>
        [...cs]
          .sort((a, b) => a.offset - b.offset)
          .map((c) => ({ tier: c.tier, from: dayOf(month, c.offset) })),
      ),
    billFrom: fc.option(
      fc.integer({ min: -5, max: 35 }).map((n) => dayOf(month, n)),
      { nil: null },
    ),
    billTo: fc.option(
      fc.integer({ min: -5, max: 35 }).map((n) => dayOf(month, n)),
      { nil: null },
    ),
    counts: fc.record({
      single_room: fc.nat(300),
      self_contained: fc.nat(300),
      commercial: fc.nat(100),
    }),
    prices: pricesArb,
    annual: fc.boolean(),
    discount: discountArb,
    vat: vatArb,
  }),
);

/** |amount − num/den| ≤ ½, checked exactly: the value was rounded once from the exact fraction. */
const roundedOnce = (amount: number, num: bigint, den: bigint): boolean => {
  const twiceError = 2n * BigInt(amount) * den - 2n * num;
  return twiceError <= den && twiceError >= -den;
};

describe('PB-05 the bill (property-based)', () => {
  it('is never below the prorated minimum, its lines add up, and each line is rounded once', () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const spans = tierSpans({
          month: s.month,
          changes: s.changes,
          billFrom: s.billFrom,
          billTo: s.billTo,
          pricesFor: (tier) => s.prices[tier],
        });
        const result = monthlyBill({
          month: s.month,
          counts: s.counts,
          spans,
          annual: s.annual,
          discount: s.discount,
          vat: s.vat,
        });
        const sumOf = (kinds: string[]) =>
          result.lines.filter((l) => kinds.includes(l.kind)).reduce((t, l) => t + l.amountMinor, 0);

        // Lines add up.
        expect(result.lines.every((l) => l.amountMinor !== 0)).toBe(true);
        expect(sumOf(['units', 'minimum'])).toBe(result.subtotalMinor);
        expect(sumOf(['discount'])).toBe(result.discountMinor);
        expect(sumOf(['vat', 'nhil', 'getfund'])).toBe(result.vatMinor);
        expect(result.netMinor).toBe(result.subtotalMinor + result.discountMinor);
        expect(result.totalMinor).toBe(result.netMinor + result.vatMinor);
        expect(result.lines.reduce((t, l) => t + l.amountMinor, 0)).toBe(result.totalMinor);
        expect(result.discountMinor).toBeLessThanOrEqual(0);
        expect(result.netMinor).toBeGreaterThanOrEqual(0);
        expect(result.lines.filter((l) => l.kind === 'discount').length).toBeLessThanOrEqual(1);

        // Never below the prorated minimum. Each span is billed on its own (the same lines as a
        // bill of that span alone), on its own floor, and a top-up meets the floor exactly.
        expect(result.subtotalMinor).toBeGreaterThanOrEqual(proratedMinimumMinor(s.month, spans));
        const inMonth = BigInt(daysInMonth(s.month));
        const perSpan = spans.map((span) =>
          monthlyBill({ ...s, spans: [span], discount: null, vat: null }),
        );
        expect(result.lines.filter((l) => l.kind === 'units' || l.kind === 'minimum')).toEqual(
          perSpan.flatMap((b) => b.lines),
        );
        spans.forEach((span, i) => {
          const spanBill = perSpan[i]!;
          const days = BigInt(
            daysBetween(parseBusinessDate(span.firstDay), parseBusinessDate(span.lastDay)) + 1,
          );
          const floorNum = BigInt(span.prices.minimumMinor) * days;
          if (spanBill.lines.some((l) => l.kind === 'minimum'))
            expect(roundedOnce(spanBill.subtotalMinor, floorNum, inMonth)).toBe(true);
          // subtotal ≥ floor − ½, in whole numbers.
          expect(2n * BigInt(spanBill.subtotalMinor) * inMonth + inMonth).toBeGreaterThanOrEqual(
            2n * floorNum,
          );
        });

        // One rounding per units line and per tax line.
        for (const line of result.lines) {
          if (line.kind === 'units') {
            const keep = BigInt(10_000 - (line.rateBps ?? 0));
            const num = BigInt(line.units!) * BigInt(line.rateMinor!) * BigInt(line.days!) * keep;
            expect(roundedOnce(line.amountMinor, num, inMonth * 10_000n)).toBe(true);
            expect(line.rateBps ?? 0).toBe(s.annual ? s.prices[line.tier!].annualDiscountBps : 0);
          }
          if (line.kind === 'vat' || line.kind === 'nhil' || line.kind === 'getfund')
            expect(
              roundedOnce(
                line.amountMinor,
                BigInt(result.netMinor) * BigInt(line.rateBps!),
                10_000n,
              ),
            ).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('splits the month’s billable days among the tiers in force, each day once', () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const spans = tierSpans({
          month: s.month,
          changes: s.changes,
          billFrom: s.billFrom,
          billTo: s.billTo,
          pricesFor: (tier) => s.prices[tier],
        });
        for (let i = 0; i < daysInMonth(s.month); i += 1) {
          const day = dayOf(s.month, i);
          // The tier in force: the last change on or before the day (the later of a same-day pair).
          const inForce = s.changes.filter((c) => c.from <= day).at(-1);
          const billable =
            inForce !== undefined &&
            (s.billFrom === null || day >= s.billFrom) &&
            (s.billTo === null || day <= s.billTo);
          const holding = spans.filter((sp) => sp.firstDay <= day && day <= sp.lastDay);
          expect(holding.length).toBe(billable ? 1 : 0);
          if (billable) expect(holding[0]!.tier).toBe(inForce!.tier);
        }
        // In order, and never touching another span of the same tier.
        spans.forEach((span, i) => {
          const prior = spans[i - 1];
          if (!prior) return;
          const gap = daysBetween(
            parseBusinessDate(prior.lastDay),
            parseBusinessDate(span.firstDay),
          );
          expect(gap).toBeGreaterThanOrEqual(1);
          if (prior.tier === span.tier) expect(gap).toBeGreaterThan(1);
        });
      }),
      { numRuns: 300 },
    );
  });

  it('charges each tier of an upgrade for its own days, within a pesewa of the exact split', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MONTHS),
        fc.integer({ min: 1, max: 27 }),
        fc.nat(500),
        (month, split, units) => {
          // An upgrade on day `split + 1`: the two units lines add up to within one pesewa (two
          // roundings of at most half a pesewa) of the exact charge at each rate for its days.
          const spans = tierSpans({
            month,
            changes: [
              { tier: 'growth', from: '2020-01-01' },
              { tier: 'portfolio', from: dayOf(month, split) },
            ],
            billFrom: null,
            billTo: null,
            pricesFor,
          });
          expect(spans.map((sp) => sp.tier)).toEqual(['growth', 'portfolio']);
          const result = bill(spans, counts(0, units), {}, month);
          const unitsTotal = result.lines
            .filter((l) => l.kind === 'units')
            .reduce((t, l) => t + l.amountMinor, 0);
          const inMonth = BigInt(daysInMonth(month));
          const exactNum =
            BigInt(units) * (1_500n * BigInt(split) + 2_200n * (inMonth - BigInt(split)));
          const error = BigInt(unitsTotal) * inMonth - exactNum; // inMonth × (charged − exact)
          expect(error <= inMonth && error >= -inMonth).toBe(true);
          for (const band of BILLING_BANDS)
            if (band !== 'self_contained')
              expect(result.lines.some((l) => l.band === band)).toBe(false);
        },
      ),
    );
  });
});
