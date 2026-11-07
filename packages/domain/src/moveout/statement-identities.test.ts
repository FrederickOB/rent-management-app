import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { finalStatement, statementBalances, statementTotals } from './statement';

/**
 * M8 review: the statement as published reads credit and arrears after the early steps (charges,
 * P01; the break-clause credit, P27), and its two identities are checked directly over the fields
 * the API sends, whatever the charges and break credit are.
 */
const lines = fc.array(
  fc.record({
    lineId: fc.uuid(),
    outstandingMinor: fc.integer({ min: 1, max: 5_000_000 }),
    /** What the tenant had already paid on the line: P27 on a paid month frees it as credit. */
    paidMinor: fc.integer({ min: 0, max: 5_000_000 }),
  }),
  { maxLength: 6 },
);

/** The early steps as the settlement runs them, on plain numbers. */
function afterEarlySteps(input: {
  credit: number;
  open: readonly { lineId: string; outstandingMinor: number; paidMinor: number }[];
  charges: readonly number[];
  breakOn: number | null;
  breakMinor: number;
}) {
  let credit = input.credit;
  const open = input.open.map((l) => ({ ...l }));
  let breakCredit = 0;
  if (input.breakOn !== null && open.length > 0) {
    const line = open[input.breakOn % open.length]!;
    const total = line.outstandingMinor + line.paidMinor;
    const amount = Math.min(input.breakMinor, total);
    // A credit note takes what is owed first; what the tenant had paid becomes credit.
    const offOwed = Math.min(amount, line.outstandingMinor);
    line.outstandingMinor -= offOwed;
    credit += amount - offOwed;
    breakCredit = amount;
  }
  const charged = input.charges.map((c, i) => ({
    lineId: `charge-${i}`,
    outstandingMinor: c,
    paidMinor: 0,
  }));
  return { credit, open: [...open, ...charged], breakCredit };
}

describe('TL-11 and MI-11 the final statement identities hold with charges and break credit (M8 review)', () => {
  it('★ balances over the published fields with any charges, break-clause credit or both (property-based)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        lines,
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { maxLength: 3 }),
        fc.option(fc.nat(), { nil: null }),
        fc.integer({ min: 1, max: 200_000 }),
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { maxLength: 4 }),
        (deposit, credit, open, charges, breakOn, breakMinor, claims) => {
          const early = afterEarlySteps({ credit, open, charges, breakOn, breakMinor });
          let left = deposit;
          const deductions = claims
            .map((c) => {
              const take = Math.min(c, left);
              left -= take;
              return take;
            })
            .filter((c) => c > 0)
            .map((amountMinor) => ({ amountMinor }));
          const s = finalStatement({
            depositHeldMinor: deposit,
            creditMinor: early.credit,
            openLines: early.open
              .filter((l) => l.outstandingMinor > 0)
              .map((l) => ({ lineId: l.lineId, outstandingMinor: l.outstandingMinor })),
            deductions,
            chargesMinor: charges.reduce((a, b) => a + b, 0),
            breakCreditMinor: early.breakCredit,
          });
          const t = statementTotals(s);
          // The identities themselves, not a difference the module computes.
          expect(t.in).toBe(deposit + early.credit);
          expect(t.in).toBe(t.out);
          expect(t.owed).toBe(t.settled);
          expect(statementBalances(s)).toBe(true);
          // Charges are inside arrears; the break credit is inside credit or off arrears.
          const openBefore = open.reduce((a, l) => a + l.outstandingMinor, 0);
          const offOwed = early.breakCredit - (early.credit - credit);
          expect(s.arrearsMinor).toBe(openBefore + s.chargesMinor - offOwed);
          expect(s.creditMinor).toBe(credit + (early.breakCredit - offOwed));
        },
      ),
    );
  });

  it('fails a statement whose credit or arrears were taken before the early steps', () => {
    const deposit = 50_000;
    // Charges: a deduction of the whole deposit and a 20,000 charge (the reviewer's first case).
    const s = finalStatement({
      depositHeldMinor: deposit,
      creditMinor: 0,
      openLines: [{ lineId: 'charge', outstandingMinor: 20_000 }],
      deductions: [{ amountMinor: 50_000 }],
      chargesMinor: 20_000,
    });
    expect(statementBalances(s)).toBe(true);
    expect(statementBalances({ ...s, arrearsMinor: 0 })).toBe(false);
    // Break credit: 66,667 freed on a paid month, with a 200,000 deposit (the second case).
    const b = finalStatement({
      depositHeldMinor: 200_000,
      creditMinor: 66_667,
      openLines: [],
      deductions: [],
      breakCreditMinor: 66_667,
    });
    expect(statementBalances(b)).toBe(true);
    expect(statementTotals(b)).toMatchObject({ in: 266_667, out: 266_667 });
    expect(statementBalances({ ...b, creditMinor: 0 })).toBe(false);
  });
});
