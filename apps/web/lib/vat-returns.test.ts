import { describe, expect, it } from 'vitest';
import { byTaxPoint, emptyVatPayment, vatPaymentForm } from './vat-returns';

describe('P33 the VAT and levies report, by tax point', () => {
  it('lists invoices by tax point, then invoice number', () => {
    const rows = [
      { invoiceNumber: 'INV-000402', taxPoint: '2026-11-05' },
      { invoiceNumber: 'INV-000403', taxPoint: '2026-11-01' },
      { invoiceNumber: 'INV-000401', taxPoint: '2026-11-01' },
    ];
    expect(byTaxPoint(rows).map((r) => r.invoiceNumber)).toEqual([
      'INV-000401',
      'INV-000403',
      'INV-000402',
    ]);
  });
});

describe('P33 VAT paid to GRA is recorded with the return’s month and the GRA receipt', () => {
  const today = '2026-12-10';

  it('turns the form into the API’s input for the whole month', () => {
    expect(
      vatPaymentForm(
        {
          ...emptyVatPayment('2026-11', today, false),
          amount: '2,000',
          graReceiptNumber: 'GRA-VAT-11',
        },
        'owner-1',
        today,
      ).input,
    ).toEqual({
      ownerId: 'owner-1',
      periodMonth: '2026-11-01',
      paidOn: today,
      amountMinor: 200_000,
      graReceiptNumber: 'GRA-VAT-11',
      paidFrom: 'owner_account',
      note: null,
    });
  });

  it('asks for the owner, a month gone or under way, the amount, receipt and account', () => {
    expect(
      vatPaymentForm({ ...emptyVatPayment('2027-01', today, true) }, null, today).errors,
    ).toEqual({
      owner: 'Choose the owner',
      month: 'The month cannot be in the future',
      amount: 'Enter the amount',
      graReceiptNumber: 'Enter the number on the GRA receipt',
      paidFrom: 'Choose the account it was paid from',
    });
    expect(
      vatPaymentForm(
        { ...emptyVatPayment('', today, false), amount: '1', graReceiptNumber: 'x' },
        'o',
        today,
      ).errors,
    ).toEqual({ month: 'Choose the month of the return' });
  });
});
