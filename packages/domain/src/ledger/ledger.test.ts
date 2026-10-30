import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, accountAllowedIn, INCOME_ACCOUNTS, type BookKind } from './accounts';
import {
  balanceOf,
  checkEntry,
  compactLines,
  reversalLines,
  type JournalLineDraft,
} from './journal';
import { accountingDateFor, firstDayOfNextMonth, monthOf } from './periods';
import {
  accrualLines,
  bankingLines,
  carryOverLines,
  creditNoteLines,
  paymentReversalLines,
  receiptLines,
  unmatchedArrivalLines,
  unmatchedMatchLines,
  writeOffLines,
  type LeaseDimensions,
} from './posting';

const OWNER = 'book-owner';
const COMPANY = 'book-company';
const kinds: Record<string, BookKind> = { [OWNER]: 'owner', [COMPANY]: 'company' };
const kindOf = (bookId: string): BookKind => kinds[bookId] ?? 'owner';
const lease: LeaseDimensions = {
  propertyId: 'property-1',
  unitId: 'unit-1',
  leaseId: 'lease-1',
  tenantId: 'tenant-1',
};
const renewal: LeaseDimensions = { ...lease, leaseId: 'lease-2' };

const sumByBook = (lines: readonly JournalLineDraft[]) => {
  const totals = new Map<string, number>();
  for (const l of lines) totals.set(l.bookId, (totals.get(l.bookId) ?? 0) + l.amountMinor);
  return totals;
};

describe('AC-01 chart of accounts', () => {
  it('has the accounts of architecture section 4, each in its kinds of book', () => {
    expect(ACCOUNTS.map((a) => a.code)).toContain('2090');
    expect(accountAllowedIn('1060', 'owner')).toBe(true);
    expect(accountAllowedIn('1060', 'company')).toBe(false);
    expect(accountAllowedIn('1100', 'company')).toBe(false);
    expect(accountAllowedIn('2090', 'company')).toBe(true);
    expect(INCOME_ACCOUNTS).toEqual(['4000', '4100', '4200', '4300', '4600']);
  });
});

describe('AC-01 the ledger balances', () => {
  it('refuses an entry with one line, a zero line or an unbalanced book', () => {
    const line = { bookId: OWNER, accountCode: '1050', amountMinor: 100 } as const;
    expect(() => checkEntry([line], kindOf)).toThrow(/two lines/);
    expect(() =>
      checkEntry([line, { ...line, accountCode: '2010', amountMinor: 0 }], kindOf),
    ).toThrow(/non-zero/);
    expect(() =>
      checkEntry([line, { ...line, accountCode: '2010', amountMinor: -99 }], kindOf),
    ).toThrow(/does not balance/);
  });

  it('refuses an account in a book that may not hold it', () => {
    expect(() =>
      checkEntry(
        [
          { bookId: COMPANY, accountCode: '1060', amountMinor: 100 },
          { bookId: COMPANY, accountCode: '2090', amountMinor: -100 },
        ],
        kindOf,
      ),
    ).toThrow(/cannot be used in a company book/);
  });

  it('balances each book separately, not just the entry', () => {
    expect(() =>
      checkEntry(
        [
          { bookId: OWNER, accountCode: '1070', amountMinor: 100 },
          { bookId: COMPANY, accountCode: '2090', amountMinor: -100 },
        ],
        kindOf,
      ),
    ).toThrow(/does not balance in book/);
  });

  it('every posting function balances in each book, for any amounts', () => {
    const amount = fc.integer({ min: 1, max: 10_000_000_000 });
    fc.assert(
      fc.property(
        fc.array(fc.tuple(amount, fc.constantFrom('receivable', 'prepayment', 'deposit')), {
          maxLength: 6,
        }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.boolean(),
        (allocs, surplus, crossBook) => {
          const allocations = allocs.map(([amountMinor, postingClass], i) => ({
            lease,
            invoiceLineId: `line-${i}`,
            postingClass: postingClass as 'receivable' | 'prepayment' | 'deposit',
            amountMinor,
          }));
          if (allocations.length === 0 && surplus === 0) return;
          const entries = [
            receiptLines({
              cash: { bookId: OWNER, account: '1050', provider: 'paystack' },
              bookId: OWNER,
              paymentId: 'payment-1',
              lease,
              allocations,
              surplusMinor: surplus,
            }),
            paymentReversalLines({
              cash: { bookId: OWNER, account: '1060', collectorId: 'collector-1' },
              bookId: OWNER,
              paymentId: 'payment-1',
              allocations,
              credit: surplus > 0 ? { lease, amountMinor: surplus } : null,
            }),
            unmatchedMatchLines({
              suspenseBookId: crossBook ? COMPANY : OWNER,
              bookId: OWNER,
              holding: { bookId: COMPANY, account: '1070' },
              paymentId: 'payment-1',
              lease,
              allocations,
              surplusMinor: surplus,
            }),
          ];
          for (const lines of entries) {
            checkEntry(lines, kindOf);
            for (const total of sumByBook(lines).values()) expect(total).toBe(0);
          }
        },
      ),
    );
  });
});

describe('AC-01 posting rules (worked example A)', () => {
  // A two-year residential advance: GH₵36,000 by MoMo, then each month GH₵1,500 recognised.
  const advance = receiptLines({
    cash: { bookId: OWNER, account: '1050', provider: 'paystack' },
    bookId: OWNER,
    paymentId: 'payment-1',
    lease,
    allocations: Array.from({ length: 24 }, (_, i) => ({
      lease,
      invoiceLineId: `rent-${i}`,
      postingClass: 'prepayment' as const,
      amountMinor: 150_000,
    })),
    surplusMinor: 0,
  });

  it('P08 puts the advance in prepayments, line by line', () => {
    expect(balanceOf(advance, { accountCode: '1050' })).toBe(3_600_000);
    expect(balanceOf(advance, { accountCode: '2010' })).toBe(-3_600_000);
    expect(balanceOf(advance, { accountCode: '2010', invoiceLineId: 'rent-0' })).toBe(-150_000);
  });

  it('P02 recognises one month from its advance allocation and owes nothing', () => {
    const month = accrualLines({
      bookId: OWNER,
      lease,
      invoiceLineId: 'rent-0',
      chargeType: 'rent',
      amountMinor: 150_000,
      advance: [{ paymentId: 'payment-1', amountMinor: 150_000 }],
      draws: [],
    });
    expect(month).toHaveLength(2);
    expect(balanceOf(month, { accountCode: '4000' })).toBe(-150_000);
    expect(balanceOf(month, { accountCode: '2010', invoiceLineId: 'rent-0' })).toBe(150_000);
    const after = [...advance, ...month];
    expect(-balanceOf(after, { accountCode: '2010' })).toBe(3_450_000);
    expect(balanceOf(after, { accountCode: '2010', invoiceLineId: 'rent-0' })).toBe(0);
  });

  it('P02 owes what neither the advance nor credit covers, and keeps credit draws off the line', () => {
    const lines = accrualLines({
      bookId: OWNER,
      lease,
      invoiceLineId: 'rent-1',
      chargeType: 'service_charge',
      amountMinor: 20_000,
      advance: [],
      draws: [{ paymentId: 'payment-2', amountMinor: 5_000 }],
    });
    expect(balanceOf(lines, { accountCode: '4100' })).toBe(-20_000);
    expect(balanceOf(lines, { accountCode: '1100', invoiceLineId: 'rent-1' })).toBe(15_000);
    expect(
      balanceOf(lines, { accountCode: '2010', paymentId: 'payment-2', invoiceLineId: null }),
    ).toBe(5_000);
    expect(() =>
      accrualLines({
        bookId: OWNER,
        lease,
        invoiceLineId: 'rent-1',
        chargeType: 'rent',
        amountMinor: 100,
        advance: [{ paymentId: 'p', amountMinor: 101 }],
        draws: [],
      }),
    ).toThrow(/cannot draw more/);
  });

  it('P07 moves a collector’s cash to the owner’s account', () => {
    const lines = bankingLines({
      bookId: OWNER,
      collectorId: 'c-1',
      to: '1010',
      amountMinor: 50_000,
    });
    checkEntry(lines, kindOf);
    expect(balanceOf(lines, { accountCode: '1060', collectorId: 'c-1' })).toBe(-50_000);
  });

  it('P23 holds unknown money in the receiver’s book, and a cross-book match balances both', () => {
    const arrival = unmatchedArrivalLines({
      cash: { bookId: COMPANY, account: '1070' },
      paymentId: 'payment-9',
      amountMinor: 100_000,
    });
    const match = unmatchedMatchLines({
      suspenseBookId: COMPANY,
      bookId: OWNER,
      holding: { bookId: COMPANY, account: '1070' },
      paymentId: 'payment-9',
      lease,
      allocations: [
        { lease, invoiceLineId: 'rent-0', postingClass: 'receivable', amountMinor: 80_000 },
      ],
      surplusMinor: 20_000,
    });
    const all = [...arrival, ...match];
    expect(balanceOf(all, { bookId: COMPANY })).toBe(0);
    expect(balanceOf(all, { bookId: COMPANY, accountCode: '2090' })).toBe(0);
    expect(balanceOf(all, { bookId: COMPANY, accountCode: '1070' })).toBe(0);
    expect(balanceOf(all, { bookId: OWNER, accountCode: '1070' })).toBe(100_000);
    expect(balanceOf(all, { bookId: OWNER, accountCode: '1100' })).toBe(-80_000);
    expect(balanceOf(all, { bookId: OWNER, accountCode: '2010' })).toBe(-20_000);
  });

  it('P24 and P27 reverse what was charged, and a never-charged line only moves its money to credit', () => {
    const writeOff = writeOffLines({
      bookId: OWNER,
      lease,
      invoiceLineId: 'rent-3',
      amountMinor: 700,
    });
    expect(balanceOf(writeOff, { accountCode: '5900' })).toBe(700);
    const charged = creditNoteLines({
      bookId: OWNER,
      lease,
      invoiceLineId: 'rent-3',
      chargedTo: '4000',
      unpaidMinor: 300,
      released: [{ paymentId: 'payment-1', amountMinor: 200 }],
    });
    expect(balanceOf(charged, { accountCode: '4000' })).toBe(500);
    expect(balanceOf(charged, { accountCode: '1100' })).toBe(-300);
    expect(balanceOf(charged, { accountCode: '2010', paymentId: 'payment-1' })).toBe(-200);
    const unaccrued = creditNoteLines({
      bookId: OWNER,
      lease,
      invoiceLineId: 'rent-9',
      chargedTo: null,
      unpaidMinor: 1_000,
      released: [{ paymentId: 'payment-1', amountMinor: 150_000 }],
    });
    expect(balanceOf(unaccrued, { accountCode: '2010' })).toBe(0);
    expect(balanceOf(unaccrued, { accountCode: '2010', invoiceLineId: 'rent-9' })).toBe(150_000);
    expect(
      creditNoteLines({
        bookId: OWNER,
        lease,
        invoiceLineId: 'rent-9',
        chargedTo: null,
        unpaidMinor: 1_000,
        released: [],
      }),
    ).toEqual([]);
  });

  it('P29 carries credit payment by payment, and the deposit, to the renewal', () => {
    const lines = carryOverLines({
      bookId: OWNER,
      from: lease,
      to: renewal,
      credits: [
        { paymentId: 'payment-1', amountMinor: 10_000 },
        { paymentId: 'payment-2', amountMinor: 5_000 },
      ],
      depositMinor: 300_000,
    });
    checkEntry(lines, kindOf);
    expect(
      balanceOf(lines, { accountCode: '2010', leaseId: 'lease-2', paymentId: 'payment-2' }),
    ).toBe(-5_000);
    expect(balanceOf(lines, { accountCode: '2100', leaseId: 'lease-2' })).toBe(-300_000);
    expect(balanceOf(lines, { accountCode: '2100', leaseId: 'lease-1' })).toBe(300_000);
  });

  it('P21(a) flips every line', () => {
    const flipped = reversalLines(advance);
    expect(balanceOf([...advance, ...flipped], {})).toBe(0);
    expect(flipped[0]?.amountMinor).toBe(-3_600_000);
  });

  it('merges lines that share an account and dimensions, and drops zeros', () => {
    const merged = compactLines([
      { bookId: OWNER, accountCode: '2010', amountMinor: 5, paymentId: 'p' },
      { bookId: OWNER, accountCode: '2010', amountMinor: 7, paymentId: 'p' },
      { bookId: OWNER, accountCode: '1100', amountMinor: 0 },
    ]);
    expect(merged).toEqual([
      { bookId: OWNER, accountCode: '2010', amountMinor: 12, paymentId: 'p' },
    ]);
  });
});

describe('AC-04 accounting dates under a lock', () => {
  it('keeps the value date when its month is open', () => {
    expect(accountingDateFor('2026-11-14', new Set(['2026-10']))).toBe('2026-11-14');
  });

  it('moves a date in a locked month to the first open day after it', () => {
    expect(accountingDateFor('2026-10-03', new Set(['2026-10']))).toBe('2026-11-01');
    expect(accountingDateFor('2026-10-03', new Set(['2026-10', '2026-11', '2026-12']))).toBe(
      '2027-01-01',
    );
  });

  it('always lands in an open month on or after the value date', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1500 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 60 }), { maxLength: 30 }),
        (offset, locked) => {
          const base = new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
          const months = new Set(
            locked.map((m) => {
              const d = new Date(Date.UTC(2026, m, 1));
              return d.toISOString().slice(0, 7);
            }),
          );
          const date = accountingDateFor(base, months);
          expect(date >= base).toBe(true);
          expect(months.has(monthOf(date))).toBe(false);
          if (date !== base) expect(date.endsWith('-01')).toBe(true);
        },
      ),
    );
    expect(firstDayOfNextMonth('2026-12-31')).toBe('2027-01-01');
  });
});
