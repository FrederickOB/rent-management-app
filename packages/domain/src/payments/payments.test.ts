import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { referenceFrom } from '../billing/references';
import { balanceOf, checkEntry } from '../ledger/journal';
import { settlementLines, unmatchedRefundLines } from '../ledger/settlement-posting';
import { exactMatch, referencesIn, suggestMatches, type MatchCandidate } from './matching';
import { checkPayAmount, payLinkAmounts, syntheticCustomerEmail } from './pay-links';
import {
  checkSettlementTransition,
  maskAccountNumber,
  providersToTry,
  usableFrom,
} from './providers';
import { reconcileSettlement, reconcileTransactions } from './reconciliation';
import { carriesInvoice, ladderFor, reminderDue } from './reminders';
import { compareVerified } from './verification';

const owner = () => 'owner' as const;
const REF = referenceFrom([10, 7, 22, 21, 2, 30]) as string;

describe('BC-02 a tampered amount or bad reference posts nothing', () => {
  const intent = { reference: 'pi-1', amountMinor: 150_000, currency: 'GHS' };

  it('posts only a successful charge whose reference and currency match exactly', () => {
    expect(compareVerified(intent, { ...intent, status: 'success' })).toEqual({
      kind: 'post',
      amountMinor: 150_000,
    });
    expect(compareVerified(intent, { ...intent, status: 'success', reference: 'pi-2' })).toEqual({
      kind: 'reject',
      reason: 'reference_differs',
    });
    expect(compareVerified(intent, { ...intent, status: 'success', currency: 'NGN' })).toEqual({
      kind: 'reject',
      reason: 'currency_differs',
    });
  });

  it('posts what was actually paid when the amount differs, flagged for a person', () => {
    expect(compareVerified(intent, { ...intent, status: 'success', amountMinor: 100_000 })).toEqual(
      {
        kind: 'post_and_flag',
        amountMinor: 100_000,
        reason: 'amount_differs',
      },
    );
  });

  it('never posts a charge that is not successful, whatever else it says', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('failed', 'abandoned', 'pending', 'ongoing', 'reversed', 'pay_offline', ''),
        fc.integer({ min: 1, max: 10_000_000 }),
        (status, amountMinor) => {
          const outcome = compareVerified(intent, { ...intent, status, amountMinor });
          expect(outcome.kind === 'post' || outcome.kind === 'post_and_flag').toBe(false);
        },
      ),
    );
  });
});

describe('BC-03 automatic matching only on metadata or an exact reference', () => {
  it('finds a whole reference in a narration, split or not, in any case', () => {
    expect(referencesIn(`Rent ${REF} Nov`)).toEqual([REF]);
    expect(referencesIn(`rent ${REF.slice(0, 3).toLowerCase()} ${REF.slice(3)}`)).toEqual([REF]);
    expect(referencesIn(`${REF.slice(0, 3)}-${REF.slice(3)}`)).toEqual([REF]);
  });

  it('ignores near-misses: a slip in one character is not a reference', () => {
    const typo = `${REF.slice(0, 6)}${REF[6] === 'A' ? 'B' : 'A'}`;
    expect(referencesIn(`Rent ${typo}`)).toEqual([]);
    expect(exactMatch({ intentId: null, narration: `Rent ${typo}` })).toEqual({
      kind: 'none',
      reason: 'nothing',
    });
  });

  it('prefers the intent, and never guesses between two references', () => {
    const other = referenceFrom([1, 2, 3, 4, 5, 6]) as string;
    expect(exactMatch({ intentId: 'pi-1', narration: `${REF}` })).toEqual({
      kind: 'intent',
      intentId: 'pi-1',
    });
    expect(exactMatch({ intentId: null, narration: `${REF} ${other}` })).toEqual({
      kind: 'none',
      reason: 'several_references',
    });
    expect(exactMatch({ intentId: null, narration: REF })).toEqual({
      kind: 'reference',
      reference: REF,
    });
  });
});

describe('BC-12 suggestions for the unmatched queue', () => {
  const candidate = (over: Partial<MatchCandidate>): MatchCandidate => ({
    leaseId: 'lease-x',
    tenantName: 'Someone Else',
    dueNowMinor: 0,
    openInvoiceMinor: [],
    monthlyMinor: 0,
    phones: [],
    dueDates: [],
    previousPayerPhones: [],
    ...over,
  });

  it('ranks the exact amount due, the tenant’s phone and an earlier payer above a name alone', () => {
    const payment = {
      amountMinor: 150_000,
      receivedOn: '2026-11-03',
      payerPhone: '+233200000021',
      payerName: 'Kofi Boateng',
    };
    const ranked = suggestMatches(payment, [
      candidate({ leaseId: 'a-name', tenantName: 'Kofi Asante' }),
      candidate({
        leaseId: 'b-best',
        dueNowMinor: 150_000,
        phones: ['+233200000021'],
        dueDates: ['2026-11-01'],
      }),
      candidate({ leaseId: 'c-history', previousPayerPhones: ['+233200000021'] }),
      candidate({ leaseId: 'd-nothing' }),
    ]);
    expect(ranked.map((s) => s.leaseId)).toEqual(['b-best', 'c-history', 'a-name']);
    expect(ranked[0]?.reasons).toEqual(['amount_is_due_now', 'phone_is_tenant', 'near_due_date']);
  });
});

describe('BC-09 the reminder ladder', () => {
  const offsets = [-7, 0, 3, 7, 14];

  it('puts the steps at the company’s offsets from the due date', () => {
    expect(ladderFor('2026-11-01', offsets).map((s) => s.date)).toEqual([
      '2026-10-25',
      '2026-11-01',
      '2026-11-04',
      '2026-11-08',
      '2026-11-15',
    ]);
    expect(carriesInvoice({ offsetDays: -7, date: '2026-10-25' }, offsets)).toBe(true);
  });

  it('sends each step once, by the clock, and stops when nothing is left to pay', () => {
    const done = new Set<number>();
    const sent: number[] = [];
    for (let d = 20; d <= 40; d += 1) {
      const today = new Date(Date.UTC(2026, 9, d)).toISOString().slice(0, 10);
      const decision = reminderDue({
        dueDate: '2026-11-01',
        offsetsDays: offsets,
        today,
        done,
        outstandingMinor: today < '2026-11-06' ? 150_000 : 0,
      });
      if (decision.send) {
        sent.push(decision.send.offsetDays);
        done.add(decision.send.offsetDays);
      }
    }
    expect(sent).toEqual([-7, 0, 3]);
  });

  it('sends only the latest missed step, recording the earlier ones as skipped', () => {
    const decision = reminderDue({
      dueDate: '2026-11-01',
      offsetsDays: offsets,
      today: '2026-11-05',
      done: new Set(),
      outstandingMinor: 1,
    });
    expect(decision.send?.offsetDays).toBe(3);
    expect(decision.skip.map((s) => s.offsetDays)).toEqual([-7, 0]);
  });
});

describe('P22 settlement', () => {
  it('splits a settlement by book with fees in proportion to gross, adding up exactly', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            book: fc.constantFrom('book-a', 'book-b', 'book-c'),
            amount: fc.integer({ min: 100, max: 5_000_000 }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        fc.integer({ min: 0, max: 300 }),
        (charges, feeBps) => {
          const payments = charges.map((c, i) => ({
            reference: `r-${i}`,
            paymentId: `p-${i}`,
            bookId: c.book,
            amountMinor: c.amount,
          }));
          const gross = payments.reduce((s, p) => s + p.amountMinor, 0);
          const fees = Math.floor((gross * feeBps) / 10_000);
          const result = reconcileSettlement(
            {
              settlementId: 's-1',
              grossMinor: gross,
              feesMinor: fees,
              netMinor: gross - fees,
              references: payments.map((p) => p.reference),
            },
            payments,
          );
          expect(result.grossDifferenceMinor).toBe(0);
          expect(result.arithmeticHolds).toBe(true);
          expect(result.parts.reduce((s, p) => s + p.feesMinor, 0)).toBe(fees);
          for (const part of result.parts) {
            const lines = settlementLines({
              bookId: part.bookId,
              to: '1010',
              provider: 'paystack',
              settlementId: 's-1',
              settlementAccountId: null,
              payments: payments
                .filter((p) => p.bookId === part.bookId)
                .map((p) => ({ paymentId: p.paymentId, amountMinor: p.amountMinor })),
              feesMinor: part.feesMinor,
              deductionsMinor: 0,
              netMinor: part.netMinor,
            });
            checkEntry(lines, owner);
          }
        },
      ),
    );
  });

  it('raises a difference instead of absorbing it', () => {
    const result = reconcileSettlement(
      {
        settlementId: 's-1',
        grossMinor: 200_000,
        feesMinor: 3_900,
        netMinor: 196_100,
        references: ['a', 'zz'],
      },
      [{ reference: 'a', paymentId: 'p-a', bookId: 'b', amountMinor: 150_000 }],
    );
    expect(result.unknownReferences).toEqual(['zz']);
    expect(result.grossDifferenceMinor).toBe(50_000);
  });

  it('clears a chargeback deducted from the settlement', () => {
    const lines = settlementLines({
      bookId: 'b',
      to: '1070',
      provider: 'paystack',
      settlementId: 's-2',
      settlementAccountId: 'sa-1',
      payments: [{ paymentId: 'p-1', amountMinor: 100_000 }],
      feesMinor: 1_950,
      deductionsMinor: 20_000,
      netMinor: 78_050,
    });
    checkEntry(lines, owner);
    expect(balanceOf(lines, { accountCode: '1050' })).toBe(-80_000);
    expect(() =>
      settlementLines({
        bookId: 'b',
        to: '1070',
        provider: 'paystack',
        settlementId: 's-2',
        settlementAccountId: null,
        payments: [{ paymentId: 'p-1', amountMinor: 100_000 }],
        feesMinor: 1_950,
        deductionsMinor: 0,
        netMinor: 98_000,
      }),
    ).toThrow(/must equal/);
  });
});

describe('Reconciliation of provider transactions', () => {
  it('sends missing successful charges through the normal path and flags the rest', () => {
    const result = reconcileTransactions(
      [
        { reference: 'ok', status: 'success', amountMinor: 100, currency: 'GHS' },
        { reference: 'lost', status: 'success', amountMinor: 200, currency: 'GHS' },
        { reference: 'declined', status: 'failed', amountMinor: 300, currency: 'GHS' },
        { reference: 'differs', status: 'success', amountMinor: 400, currency: 'GHS' },
      ],
      [
        { reference: 'ok', amountMinor: 100, reversed: false },
        { reference: 'differs', amountMinor: 450, reversed: false },
        { reference: 'phantom', amountMinor: 500, reversed: false },
      ],
    );
    expect(result.toProcess).toEqual(['lost']);
    expect(result.matched).toBe(1);
    expect(result.exceptions.map((e) => `${e.kind}:${e.reference}`)).toEqual([
      'missing_here:lost',
      'amount_differs:differs',
      'missing_at_provider:phantom',
    ]);
  });
});

describe('P31 unmatched refund', () => {
  it('takes the money out of suspense and out of where it sits, in the same book', () => {
    const lines = unmatchedRefundLines({
      from: { bookId: 'company', account: '1050', provider: 'paystack' },
      paymentId: 'p-9',
      amountMinor: 40_000,
    });
    checkEntry(lines, () => 'company');
    expect(balanceOf(lines, { accountCode: '2090' })).toBe(40_000);
  });
});

describe('BC-04 what a pay link accepts', () => {
  it('is pre-filled with what is due, and takes GH₵1 up to the rent left in the term', () => {
    const limits = payLinkAmounts({ dueNowMinor: 150_000, remainingTermMinor: 1_800_000 });
    expect(limits).toEqual({ prefillMinor: 150_000, minMinor: 100, maxMinor: 1_800_000 });
    expect(checkPayAmount(100, limits)).toBe(100);
    expect(() => checkPayAmount(99, limits)).toThrow(/at least/);
    expect(() => checkPayAmount(1_800_001, limits)).toThrow(/more than the rent left/);
  });

  it('gives each tenant without an email a platform address from their id, never their phone', () => {
    expect(syntheticCustomerEmail('0192f5a8-1111-7222-8333-444455556666', 'pay.example.com')).toBe(
      'tenant-0192f5a8111172228333444455556666@pay.example.com',
    );
    expect(() => syntheticCustomerEmail('+233200000021', 'pay.example.com')).toThrow();
  });
});

describe('BC-02 failover only to providers that settle directly', () => {
  it('tries the company’s order, skipping any provider that cannot carry rent (D1)', () => {
    const options = [
      { provider: 'paystack', configured: true, settlesDirect: true, hasSubaccount: true },
      { provider: 'second', configured: true, settlesDirect: true, hasSubaccount: true },
      { provider: 'hubtel', configured: true, settlesDirect: false, hasSubaccount: true },
      { provider: 'unset', configured: false, settlesDirect: true, hasSubaccount: true },
    ];
    expect(providersToTry(['paystack', 'hubtel', 'second', 'unset'], options)).toEqual([
      'paystack',
      'second',
    ]);
    expect(providersToTry(['hubtel'], options)).toEqual([]);
  });
});

describe('ADR-008 settlement accounts', () => {
  it('need approval, then 24 hours, and show only the last four digits', () => {
    expect(() => checkSettlementTransition('awaiting_approval', 'active')).toThrow();
    expect(() => checkSettlementTransition('awaiting_approval', 'cooling_off')).not.toThrow();
    expect(usableFrom(new Date('2026-11-01T10:00:00Z')).toISOString()).toBe(
      '2026-11-02T10:00:00.000Z',
    );
    expect(maskAccountNumber('1441000123456')).toBe('•••• 3456');
  });
});
