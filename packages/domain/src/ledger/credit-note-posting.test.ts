import { describe, expect, it } from 'vitest';
import { subscriptionCreditNoteLines, subscriptionPostingKeys } from './subscription-posting';

const base = { bookId: 'book-1', invoiceId: 'inv-1' };

describe('BE-6 P26 credit note (founder answer Q2)', () => {
  it('reverses net and VAT against what the invoice owed, the rest to prepaid credit', () => {
    const lines = subscriptionCreditNoteLines({
      ...base,
      netMinor: 10_000,
      vatMinor: 2_000,
      toReceivableMinor: 5_000,
      toCreditMinor: 7_000,
    });
    expect(lines.map((l) => [l.accountCode, l.amountMinor])).toEqual([
      ['4600', 10_000],
      ['2210', 2_000],
      ['1100', -5_000],
      ['2020', -7_000],
    ]);
    expect(lines.reduce((t, l) => t + l.amountMinor, 0)).toBe(0);
    expect(lines.every((l) => l.invoiceLineId === 'inv-1')).toBe(true);
    expect(subscriptionPostingKeys.creditNote('cn-1')).toBe('P26:cn-1');
  });

  it('posts no VAT or credit line when there is none, and refuses parts that do not add up', () => {
    expect(
      subscriptionCreditNoteLines({
        ...base,
        netMinor: 3_000,
        vatMinor: 0,
        toReceivableMinor: 3_000,
        toCreditMinor: 0,
      }).map((l) => l.accountCode),
    ).toEqual(['4600', '1100']);
    expect(() =>
      subscriptionCreditNoteLines({
        ...base,
        netMinor: 3_000,
        vatMinor: 0,
        toReceivableMinor: 1_000,
        toCreditMinor: 0,
      }),
    ).toThrow(/must equal/);
    expect(() =>
      subscriptionCreditNoteLines({
        ...base,
        netMinor: 0,
        vatMinor: 0,
        toReceivableMinor: 0,
        toCreditMinor: 0,
      }),
    ).toThrow(/nothing/);
  });
});
