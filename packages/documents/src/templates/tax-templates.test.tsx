import { PDFDocument } from '@cantoo/pdf-lib';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withFixedPdfDates } from '../pdf/normalise';
import { renderHtml, templates } from './index';
import { rentTaxReportV1, type RentTaxReportData } from './tax';
import { sampleBranding } from './test-fixtures';

const report: RentTaxReportData = {
  ownerId: '019a3000-0000-7000-8000-00000000aaaa',
  owner: { name: 'Akosua Mensah', tin: 'P0007654321' },
  from: '2026-10-01',
  to: '2026-10-31',
  items: [
    {
      valueDate: '2026-10-25',
      accountingDate: '2026-10-25',
      kind: 'Receipt',
      receiptNumber: 'RC-000123',
      unitCode: 'ACC-ELG-B1-04',
      tenantName: 'Two Year Tenant',
      baseMinor: 3_600_000,
      rateBps: 800,
      taxMinor: 288_000,
      dueDate: '2026-11-24',
      status: 'Open',
    },
  ],
  graPayments: [],
  totals: {
    baseMinor: 3_600_000,
    taxMinor: 288_000,
    withheldMinor: 0,
    paidToGraMinor: 0,
    settledByCertificatesMinor: 0,
    outstandingMinor: 288_000,
  },
  warnings: ['Rules not yet verified: rent_tax.base: unverified: counsel to confirm'],
};

describe('TX-03 the rent tax report document', () => {
  it('renders each receipt’s base, rate and tax, the totals and the unverified-rule warning', () => {
    const html = renderHtml(rentTaxReportV1, report, sampleBranding);
    for (const text of [
      'Rent tax report',
      'RC-000123',
      'GH₵36,000.00',
      '8%',
      'GH₵2,880.00',
      '24 November 2026',
    ])
      expect(html).toContain(text);
    expect(html).toContain('unverified');
    expect(templates.get('tax.rent-tax-report', 1).pdfDate(report)).toBe('2026-10-31');
    expect(templates.get('billing.receipt', 1).pdfDate({})).toBeNull();
  });

  it('refuses data that does not fit, so stored data is exactly what was rendered', () => {
    expect(() =>
      rentTaxReportV1.element({ ...report, generatedAt: 'now' }, sampleBranding),
    ).toThrow();
  });

  it('gives a PDF fixed dates, so two renders of the same report are the same bytes', async () => {
    const make = async (when: Date) => {
      const doc = await PDFDocument.create();
      doc.addPage();
      doc.setCreationDate(when);
      doc.setModificationDate(when);
      return doc.save();
    };
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
    const a = await withFixedPdfDates(await make(new Date('2026-11-01T10:00:00Z')), '2026-10-31');
    const b = await withFixedPdfDates(await make(new Date('2026-12-05T17:30:00Z')), '2026-10-31');
    expect(sha(a)).toBe(sha(b));
    const loaded = await PDFDocument.load(a, { updateMetadata: false });
    expect(loaded.getCreationDate()?.toISOString()).toBe('2026-10-31T00:00:00.000Z');
  });
});
