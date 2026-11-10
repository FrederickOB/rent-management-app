import { describe, expect, it } from 'vitest';
import { renderHtml, templates } from './index';
import {
  subscriptionInvoiceV1,
  subscriptionReceiptV1,
  type SubscriptionInvoiceDocumentData,
  type SubscriptionReceiptDocumentData,
} from './subscription';
import { sampleBranding } from './test-fixtures';

/** The platform's own letterhead (fictional, as in the demo dataset). */
const platform = { ...sampleBranding, senderName: 'Rent Platform' };

const invoice: SubscriptionInvoiceDocumentData = {
  platformName: 'Rent Platform',
  subscriberName: 'Osu Ridge Property Managers',
  subscriberLegalName: 'Osu Ridge Property Managers Ltd (demo)',
  number: 'SUB-2026-000012',
  month: '2026-10',
  monthLabel: 'October 2026',
  issuedOn: '2026-11-01',
  dueOn: '2026-11-08',
  lines: [
    { description: 'Growth: 12 single rooms, the whole month at GH₵8.00', amountMinor: 9_600 },
    {
      description: 'Growth: 8 self-contained units, the whole month at GH₵15.00',
      amountMinor: 12_000,
    },
    { description: 'Discount code PILOT-10: 10% off', amountMinor: -2_160 },
  ],
  subtotalMinor: 21_600,
  discountMinor: -2_160,
  netMinor: 19_440,
  vatMinor: 0,
  totalMinor: 19_440,
  prepaidMinor: 5_000,
  amountDueMinor: 14_440,
  vatUnverified: false,
  placeholderPrices: true,
  billableUnits: { singleRoom: 12, selfContained: 8, commercial: 0 },
};

const receipt: SubscriptionReceiptDocumentData = {
  platformName: 'Rent Platform',
  subscriberName: 'Osu Ridge Property Managers',
  number: 'SUBR-2026-000003',
  paidOn: '2026-11-04',
  amountMinor: 20_000,
  channel: 'momo',
  reference: 'SUB-0192f5a8111172228333444455556666',
  purpose: 'invoices',
  invoices: [{ number: 'SUB-2026-000012', amountMinor: 14_440 }],
  creditMinor: 5_560,
};

describe('PB-07 subscription invoices in cedis, from the platform to the subscriber', () => {
  it('renders the month, the billable units by band, each line and what is due', () => {
    const html = renderHtml(subscriptionInvoiceV1, invoice, platform);
    expect(html).toContain('<h1>Subscription invoice</h1>');
    expect(html).toContain('SUB-2026-000012');
    expect(html).toContain('October 2026');
    expect(html).toContain('Osu Ridge Property Managers Ltd (demo) (trading as Osu Ridge');
    expect(html).toContain('12 single rooms, 8 self-contained units, 0 commercial units');
    expect(html).toContain('GH₵96.00');
    expect(html).toContain('-GH₵21.60');
    expect(html).toContain('GH₵194.40');
    expect(html).toContain('Paid from prepaid credit');
    expect(html).toContain('GH₵144.40');
    expect(html).toContain('8 November 2026');
    expect(html).toContain('provisional');
    // No VAT is charged by default (decision 10): no VAT line and no warning.
    expect(html).not.toContain('VAT and levies');
    expect(html).not.toContain('tax adviser');
  });

  it('shows VAT and levies, with the warning while the rule is unverified', () => {
    const html = renderHtml(
      subscriptionInvoiceV1,
      {
        ...invoice,
        lines: [
          ...invoice.lines,
          { description: 'VAT at 15%', amountMinor: 2_916 },
          { description: 'NHIL at 2.5%', amountMinor: 486 },
          { description: 'GETFund levy at 2.5%', amountMinor: 486 },
        ],
        vatMinor: 3_888,
        totalMinor: 23_328,
        prepaidMinor: 0,
        amountDueMinor: 23_328,
        vatUnverified: true,
        placeholderPrices: false,
      },
      platform,
    );
    expect(html).toContain('VAT and levies');
    expect(html).toContain('GH₵38.88');
    expect(html).toContain('GH₵233.28');
    expect(html).toContain('still to be confirmed by a tax adviser');
    expect(html).not.toContain('provisional');
    expect(html).not.toContain('Paid from prepaid credit');
  });
});

describe('PB-07 subscription receipts name what was paid and the credit held', () => {
  it('renders the receipt with the invoices paid and the prepaid credit', () => {
    const html = renderHtml(subscriptionReceiptV1, receipt, platform);
    expect(html).toContain('<h1>Subscription receipt</h1>');
    expect(html).toContain('SUBR-2026-000003');
    expect(html).toContain('4 November 2026, Mobile money');
    expect(html).toContain('Invoice SUB-2026-000012');
    expect(html).toContain('GH₵200.00');
    expect(html).toContain('Held as prepaid credit for later invoices');
    expect(html).toContain('GH₵55.60');
    expect(html).toContain('Rent Platform');
  });

  it('says an annual prepayment is held as credit for the next 12 months', () => {
    const html = renderHtml(
      subscriptionReceiptV1,
      { ...receipt, purpose: 'annual', channel: 'card', invoices: [], creditMinor: 20_000 },
      platform,
    );
    expect(html).toContain('Card');
    expect(html).toContain('annual prepayment');
    expect(html).not.toContain('Invoice SUB-');
  });

  it('are registered, and refuse data they do not define or numbers of another kind', () => {
    expect(templates.get('subscription.invoice', 1)).toBe(subscriptionInvoiceV1);
    expect(templates.get('subscription.receipt', 1)).toBe(subscriptionReceiptV1);
    expect(() => renderHtml(subscriptionReceiptV1, { ...receipt, extra: 1 }, platform)).toThrow();
    expect(() =>
      renderHtml(subscriptionReceiptV1, { ...receipt, number: 'RC-000045' }, platform),
    ).toThrow();
    expect(() =>
      renderHtml(subscriptionInvoiceV1, { ...invoice, number: 'INV-000123' }, platform),
    ).toThrow();
    expect(() =>
      renderHtml(subscriptionReceiptV1, { ...receipt, amountMinor: 200.5 }, platform),
    ).toThrow();
  });
});
