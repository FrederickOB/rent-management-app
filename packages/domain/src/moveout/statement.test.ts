import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkEntry } from '../ledger/journal';
import {
  depositApplicationLines,
  depositRefundApprovedLines,
  expenseLines,
  expensePaymentLines,
  tenantRefundPaidLines,
} from '../ledger/moveout-posting';
import { expenseAccountOf } from '../maintenance/expenses';
import { checkDeductionsWithinDeposit, nextMoveOutStatus } from './moveout';
import { finalStatement, statementDifference } from './statement';

/** M8 plan section 6: the final statement, the deposit postings (P11, P12) and P15. */
const lease = { propertyId: 'p', unitId: 'u', leaseId: 'l', tenantId: 't' };
const owner = () => 'owner' as const;

const lines = fc.array(
  fc.record({ lineId: fc.uuid(), outstandingMinor: fc.integer({ min: 1, max: 5_000_000 }) }),
  { maxLength: 8 },
);

describe('TL-11 and MI-11 the final statement', () => {
  it('★ always balances to zero, never retains more than the deposit, and never refunds below zero (property-based)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        lines,
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { maxLength: 5 }),
        (deposit, credit, open, claims) => {
          // Keep the claims within the deposit, as the domain requires.
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
            creditMinor: credit,
            openLines: open,
            deductions,
          });
          expect(statementDifference(s)).toBe(0);
          expect(s.arrearsMinor + s.deductionsChargedMinor).toBe(
            s.creditAppliedMinor + s.depositAppliedMinor + s.stillOwedMinor,
          );
          expect(s.retainedMinor).toBeLessThanOrEqual(deposit);
          expect(s.retainedMinor + s.depositAppliedMinor + s.depositRefundMinor).toBe(deposit);
          expect(s.creditRefundMinor).toBeGreaterThanOrEqual(0);
          expect(s.depositRefundMinor).toBeGreaterThanOrEqual(0);
          expect(s.stillOwedMinor).toBeGreaterThanOrEqual(0);
          // Nothing is refunded while anything is still owed.
          if (s.stillOwedMinor > 0) expect(s.refundMinor).toBe(0);
          // Each line is paid no more than it owed.
          for (const l of open) {
            const paid = [...s.creditToArrears, ...s.depositToArrears]
              .filter((x) => x.lineId === l.lineId)
              .reduce((sum, x) => sum + x.amountMinor, 0);
            expect(paid).toBeLessThanOrEqual(l.outstandingMinor);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('★ refuses deductions that exceed the deposit held (property-based)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (deposit, over) => {
          expect(() =>
            finalStatement({
              depositHeldMinor: deposit,
              creditMinor: 0,
              openLines: [],
              deductions: [{ amountMinor: deposit + over }],
            }),
          ).toThrow(/more than the deposit held/);
          expect(() =>
            checkDeductionsWithinDeposit(
              [{ amountMinor: deposit }, { amountMinor: over }],
              deposit,
            ),
          ).toThrow();
        },
      ),
    );
  });

  it('pays arrears from the credit first, then the deposit, keeps the deductions, and refunds the rest', () => {
    const s = finalStatement({
      depositHeldMinor: 300_000,
      creditMinor: 50_000,
      openLines: [
        { lineId: 'old', outstandingMinor: 80_000 },
        { lineId: 'new', outstandingMinor: 100_000 },
      ],
      deductions: [{ amountMinor: 40_000 }],
    });
    expect(s.creditToArrears).toEqual([{ lineId: 'old', amountMinor: 50_000 }]);
    expect(s.depositToArrears).toEqual([
      { lineId: 'old', amountMinor: 30_000 },
      { lineId: 'new', amountMinor: 100_000 },
    ]);
    expect(s).toMatchObject({
      retainedMinor: 40_000,
      deductionsChargedMinor: 0,
      creditRefundMinor: 0,
      depositRefundMinor: 130_000,
      refundMinor: 130_000,
      stillOwedMinor: 0,
    });
  });

  it('charges a deduction the deposit can no longer cover after paying arrears, and it stays owed', () => {
    const s = finalStatement({
      depositHeldMinor: 100_000,
      creditMinor: 0,
      openLines: [{ lineId: 'rent', outstandingMinor: 90_000 }],
      deductions: [{ amountMinor: 30_000 }],
    });
    expect(s).toMatchObject({
      depositAppliedMinor: 90_000,
      retainedMinor: 10_000,
      deductionsChargedMinor: 20_000,
      stillOwedMinor: 20_000,
      refundMinor: 0,
    });
  });
});

describe('TL-11 the move-out steps', () => {
  it('moves from planned to closed, and refuses steps out of order', () => {
    expect(nextMoveOutStatus('planned', 'inspect')).toBe('inspected');
    expect(nextMoveOutStatus('inspected', 'draft')).toBe('settlement_drafted');
    expect(nextMoveOutStatus('settlement_drafted', 'submit')).toBe('awaiting_approval');
    expect(nextMoveOutStatus('awaiting_approval', 'return')).toBe('settlement_drafted');
    expect(nextMoveOutStatus('awaiting_approval', 'approve')).toBe('approved');
    expect(nextMoveOutStatus('approved', 'pay_refund')).toBe('refund_paid');
    expect(nextMoveOutStatus('refund_paid', 'close')).toBe('closed');
    expect(() => nextMoveOutStatus('planned', 'approve')).toThrow(/cannot do that now/);
    expect(() => nextMoveOutStatus('approved', 'cancel')).toThrow();
  });
});

describe('P11, P12 and P15 postings', () => {
  it('P11 balances: the deposit pays the lines and keeps the deductions; never income except 4300', () => {
    const entry = depositApplicationLines({
      bookId: 'b',
      lease,
      shares: [
        { paymentId: 'dep1', amountMinor: 100_000 },
        { paymentId: 'dep2', amountMinor: 20_000 },
      ],
      lines: [{ invoiceLineId: 'rent', amountMinor: 90_000 }],
      retainedMinor: 30_000,
    });
    checkEntry(entry, owner);
    expect(entry.find((l) => l.accountCode === '4300')?.amountMinor).toBe(-30_000);
    expect(entry.some((l) => l.accountCode === '4000')).toBe(false);
    expect(() =>
      depositApplicationLines({
        bookId: 'b',
        lease,
        shares: [{ paymentId: 'dep1', amountMinor: 10 }],
        lines: [{ invoiceLineId: 'rent', amountMinor: 20 }],
        retainedMinor: 0,
      }),
    ).toThrow(/equal/);
  });

  it('P12 approved and paid, and P15 with each source, balance', () => {
    checkEntry(
      depositRefundApprovedLines({
        bookId: 'b',
        lease,
        shares: [{ paymentId: 'd', amountMinor: 5 }],
      }),
      owner,
    );
    checkEntry(tenantRefundPaidLines({ bookId: 'b', lease, from: '1010', amountMinor: 5 }), owner);
    for (const from of ['1010', '1070', '2500'] as const)
      checkEntry(
        expenseLines({
          bookId: 'b',
          account: expenseAccountOf('repairs'),
          from,
          propertyId: 'p',
          unitId: null,
          amountMinor: 12_000,
        }),
        owner,
      );
    expect(expenseAccountOf('utilities')).toBe('5400');
    checkEntry(
      expensePaymentLines({
        bookId: 'b',
        from: '1070',
        propertyId: 'p',
        unitId: 'u',
        amountMinor: 1,
      }),
      owner,
    );
  });
});
