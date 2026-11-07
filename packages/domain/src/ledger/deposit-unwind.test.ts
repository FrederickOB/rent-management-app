import { describe, expect, it } from 'vitest';
import { checkEntry } from './journal';
import { depositApplicationLines, depositUnwindLines } from './moveout-posting';

const lease = { propertyId: 'p', unitId: 'u', leaseId: 'l', tenantId: 't' };

describe('P21b a chargeback takes a settled deposit share back (M8 review)', () => {
  it('mirrors P11 and P12 for one payment: Cr 2100, Dr 1100 on the lines, 4300 and 2400', () => {
    const lines = depositUnwindLines({
      bookId: 'b',
      lease,
      paymentId: 'pay',
      lines: [{ invoiceLineId: 'line', amountMinor: 30_000 }],
      retainedMinor: 10_000,
      refundMinor: 5_000,
    });
    expect(() => checkEntry(lines, () => 'owner')).not.toThrow();
    const by = (account: string) =>
      lines.filter((l) => l.accountCode === account).reduce((s, l) => s + l.amountMinor, 0);
    expect(by('2100')).toBe(-45_000);
    expect(by('1100')).toBe(30_000);
    expect(by('4300')).toBe(10_000);
    expect(by('2400')).toBe(5_000);
    expect(lines.find((l) => l.accountCode === '2100')!.paymentId).toBe('pay');
    // With the P11 it undoes, 2100 for the payment is back where it was.
    const applied = depositApplicationLines({
      bookId: 'b',
      lease,
      shares: [{ paymentId: 'pay', amountMinor: 40_000 }],
      lines: [{ invoiceLineId: 'line', amountMinor: 30_000 }],
      retainedMinor: 10_000,
    });
    const net = [...applied, ...lines]
      .filter((l) => l.accountCode === '2100')
      .reduce((s, l) => s + l.amountMinor, 0);
    expect(net).toBe(-5_000);
  });

  it('refuses an empty or negative unwind', () => {
    expect(() =>
      depositUnwindLines({
        bookId: 'b',
        lease,
        paymentId: 'p',
        lines: [],
        retainedMinor: 0,
        refundMinor: 0,
      }),
    ).toThrow();
    expect(() =>
      depositUnwindLines({
        bookId: 'b',
        lease,
        paymentId: 'p',
        lines: [],
        retainedMinor: -1,
        refundMinor: 5,
      }),
    ).toThrow();
  });
});
