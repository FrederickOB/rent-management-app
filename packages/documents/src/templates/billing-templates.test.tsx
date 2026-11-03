import { describe, expect, it } from 'vitest';
import { invoiceV1, receiptV1 } from './billing';
import { renderHtml, templates } from './index';
import { sampleBranding } from './test-fixtures';

const invoice = {
  number: 'INV-000123',
  kind: 'cycle' as const,
  issueDate: '2026-10-18',
  dueDate: '2026-11-01',
  periodFrom: '2026-11-01',
  periodTo: '2026-11-30',
  paymentReference: 'K7QM2XA',
  billedTo: { name: 'Osu Traders Ltd', tin: 'C0001234567' },
  billedFrom: { name: 'Akosua Mensah', tin: 'P0007654321' },
  unit: { code: 'ACC-OSU-B1-01', propertyName: 'Osu Mixed-Use' },
  lines: [
    {
      label: 'Rent',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      rateBps: null,
      amountMinor: 1_000_000,
      isTax: false,
    },
    {
      label: 'VAT',
      periodStart: null,
      periodEnd: null,
      rateBps: 1500,
      amountMinor: 150_000,
      isTax: true,
    },
    {
      label: 'NHIL',
      periodStart: null,
      periodEnd: null,
      rateBps: 250,
      amountMinor: 25_000,
      isTax: true,
    },
    {
      label: 'GETFund levy',
      periodStart: null,
      periodEnd: null,
      rateBps: 250,
      amountMinor: 25_000,
      isTax: true,
    },
  ],
  totalMinor: 1_200_000,
  vatTotalMinor: 200_000,
  notes: [],
};

const receipt = {
  number: 'RC-000045',
  kind: 'receipt' as const,
  issuedAt: '2026-11-02T10:15:00Z',
  timeZone: 'Africa/Accra',
  receivedOn: '2026-11-02',
  method: 'Cash',
  receivedFrom: 'Kofi Boateng',
  tenant: { name: 'Kofi Boateng', tin: null },
  billedFrom: { name: 'Akosua Mensah', tin: null },
  unit: { code: 'ACC-LEG-B1-04', propertyName: 'Legon Compound House' },
  paymentReference: 'K7QM2XA',
  amountMinor: 200_000,
  allocations: [
    { label: 'Rent, November 2026', invoiceNumber: 'INV-000120', amountMinor: 150_000 },
  ],
  creditMinor: 50_000,
  vatMinor: null,
  paidUntil: '2026-11-30',
  partial: { monthStart: '2026-12-01', amountMinor: 50_000 },
  receivedBy: 'Yaw Caretaker',
  reverses: null,
};

describe('CT-04 commercial invoices name both parties with their TINs and show VAT line by line', () => {
  it('renders a tax invoice', () => {
    const html = renderHtml(invoiceV1, invoice, sampleBranding);
    expect(html).toContain('<h1>Tax invoice</h1>');
    expect(html).toContain('Osu Traders Ltd (TIN C0001234567)');
    expect(html).toContain('Akosua Mensah (TIN P0007654321)');
    expect(html).toContain('VAT at 15%');
    expect(html).toContain('NHIL at 2.5%');
    expect(html).toContain('GH₵12,000.00');
    expect(html).toContain('K7QM2XA');
  });

  it('renders a plain rent invoice without a VAT total', () => {
    const html = renderHtml(
      invoiceV1,
      {
        ...invoice,
        vatTotalMinor: null,
        lines: [invoice.lines[0]],
        totalMinor: 1_000_000,
        billedTo: { name: 'Kofi Boateng', tin: null },
      },
      sampleBranding,
    );
    expect(html).toContain('<h1>Rent invoice</h1>');
    expect(html).not.toContain('VAT and levies');
  });
});

describe('BC-06 receipts show what was paid, the credit and paid-until', () => {
  it('renders the allocations, the receiver, the credit and partial cover', () => {
    const html = renderHtml(receiptV1, receipt, sampleBranding);
    expect(html).toContain('RC-000045');
    expect(html).toContain('(Africa/Accra)');
    expect(html).toContain('Yaw Caretaker');
    expect(html).toContain('Held as credit for later months');
    expect(html).toContain(
      'Rent is paid until 30 November 2026, plus GH₵500.00 towards the month starting 1 December 2026.',
    );
  });

  it('renders a credit receipt naming the receipt it reverses', () => {
    const html = renderHtml(
      receiptV1,
      {
        ...receipt,
        kind: 'credit_receipt',
        reverses: { number: 'RC-000044', reason: 'The cheque bounced' },
        paidUntil: null,
        partial: null,
      },
      sampleBranding,
    );
    expect(html).toContain('<h1>Credit receipt</h1>');
    expect(html).toContain('Receipt RC-000044: The cheque bounced');
  });

  it('are registered, and refuse data they do not define', () => {
    expect(templates.get('billing.invoice', 1)).toBeDefined();
    expect(templates.get('billing.receipt', 1)).toBeDefined();
    expect(() => renderHtml(receiptV1, { ...receipt, extra: true }, sampleBranding)).toThrow();
  });
});
