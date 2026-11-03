import { RENT_CYCLES } from '@rent/domain/tenancy';
import {
  dueNowLabel,
  nextDueLabel,
  paidUntilLabel,
  paymentMethodLabel,
  rentLabel,
  rentToCome,
} from '../src/format';
import { byLandlord } from '../src/payment-groups';
import { TWO_LANDLORDS } from './fixtures';
import { PAYMENTS } from './money-fixtures';

describe('TL-01 and BC-04 the tenant app’s money in words', () => {
  it('says what is due, paid-until with any part month, and the next payment, from pesewas', () => {
    expect(dueNowLabel(220_050)).toBe('GH₵2,200.50');
    expect(dueNowLabel(0)).toBe('Nothing due now');
    expect(paidUntilLabel('2026-11-14', null)).toBe('Paid until 14 November 2026');
    expect(paidUntilLabel('2026-11-14', { monthStart: '2026-11-15', amountMinor: 7 })).toBe(
      'Paid until 14 November 2026, and GH₵0.07 paid towards the month from 15 November 2026',
    );
    expect(paidUntilLabel(null, { monthStart: '2026-09-01', amountMinor: 50_000 })).toBe(
      'GH₵500.00 paid towards the month from 1 September 2026',
    );
    expect(paidUntilLabel(null, null)).toBe('No rent paid yet');
    expect(nextDueLabel({ dueDate: '2027-01-01', amountMinor: 2_640_000 })).toBe(
      'GH₵26,400.00 on 1 January 2027',
    );
    expect(nextDueLabel(null)).toBe('Nothing more to pay on this lease');
  });

  it('names how each payment was made', () => {
    expect(paymentMethodLabel('momo')).toBe('Mobile money');
    expect(paymentMethodLabel('bank_transfer')).toBe('Bank transfer');
    expect(paymentMethodLabel('direct_debit')).toBe('direct debit');
    expect(paymentMethodLabel('constructor')).toBe('constructor');
  });
});

describe('TL-06 and M4b decision 9 the two-yearly cycle in the tenant app', () => {
  it('names every cycle, the two-yearly one included', () => {
    expect(RENT_CYCLES).toContain('two_yearly');
    expect(rentLabel(450_050, 'two_yearly')).toBe('GH₵4,500.50 a month, paid every two years');
    expect(rentLabel(220_000, 'six_monthly')).toBe('GH₵2,200.00 a month, paid every six months');
    expect(rentLabel(220_000, 'annual')).toBe('GH₵2,200.00 a month, paid annually');
    for (const cycle of RENT_CYCLES)
      expect(rentLabel(100, cycle)).toMatch(/^GH₵1\.00 a month, paid [a-z ]+$/);
  });
});

describe('TL-12 one landlord never sees another landlord’s money', () => {
  it('puts each payment in the box of the landlord whose lease it is on', () => {
    const boxes = byLandlord(PAYMENTS, TWO_LANDLORDS);
    expect(boxes.map((b) => [b.name, b.payments.map((p) => p.receiptNumber)])).toEqual([
      ['Osu Ridge Property Managers', ['RCT-2026-000057', 'RCT-2026-000041']],
      ['Kwabena Owusu', ['KO-000012']],
    ]);
    // Before the tenancies arrive, the name the payment came with groups it.
    expect(byLandlord(PAYMENTS, null).map((b) => b.key)).toEqual([
      'name:Osu Ridge Property Managers',
      'name:Kwabena Owusu',
    ]);
  });
});

describe('TL-01 and BC-04 the next payment when no invoice is out yet', () => {
  it('says the next invoice is not out yet while the lease has rent to come', () => {
    // The API names only issued invoices, 14 days before they fall due.
    expect(nextDueLabel(null, true)).toBe('The next invoice is not out yet');
    expect(nextDueLabel(null, false)).toBe('Nothing more to pay on this lease');
    expect(nextDueLabel({ dueDate: '2026-12-01', amountMinor: 140_000 }, true)).toBe(
      'GH₵1,400.00 on 1 December 2026',
    );
  });

  it('knows which leases have rent to come', () => {
    expect(rentToCome('active', '2027-11-02', null)).toBe(true);
    expect(rentToCome('active', '2027-11-02', '2027-10-31')).toBe(true);
    expect(rentToCome('active', '2027-11-02', '2027-11-02')).toBe(false);
    expect(rentToCome('signed', '2027-11-02', null)).toBe(true);
    expect(rentToCome('ending', '2026-12-31', '2026-11-30')).toBe(true);
    expect(rentToCome('holding_over', '2026-01-31', '2026-10-31')).toBe(true);
    expect(rentToCome('ended', '2026-10-31', '2026-09-30')).toBe(false);
    expect(rentToCome('terminated', '2027-10-31', null)).toBe(false);
  });
});
