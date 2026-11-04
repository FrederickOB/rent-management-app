import { describe, expect, it } from 'vitest';
import { renderHtml, templates } from './index';
import { rentTaxReportV1, rentTaxReportV2, type RentTaxReportV2Data } from './tax';
import { sampleBranding } from './test-fixtures';

/** Worked example B with its certificate still awaited (M5 review 3). */
const report: RentTaxReportV2Data = {
  ownerId: '019a3000-0000-7000-8000-00000000bbbb',
  owner: { name: 'Kofi Asante', tin: null },
  from: '2026-11-01',
  to: '2026-11-30',
  items: [
    {
      valueDate: '2026-11-03',
      accountingDate: '2026-11-03',
      kind: 'Withheld by the tenant',
      receiptNumber: null,
      unitCode: 'ACC-OSU-G-01',
      tenantName: 'Corporate Tenant Ltd',
      baseMinor: 1_000_000,
      rateBps: 1500,
      taxMinor: 150_000,
      dueDate: '2026-12-03',
      status: 'Withheld by the tenant',
    },
  ],
  graPayments: [],
  totals: {
    baseMinor: 1_000_000,
    taxMinor: 150_000,
    withheldMinor: 150_000,
    paidToGraMinor: 0,
    settledByCertificatesMinor: 0,
    withheldAwaitingCertificateMinor: 150_000,
    outstandingMinor: 0,
  },
  warnings: [],
};

describe('TX-03 the rent tax report shows tax withheld awaiting its certificate on its own (M5 review 3)', () => {
  it('prints it beside a still owed of nothing, in version 2', () => {
    const html = renderHtml(rentTaxReportV2, report, sampleBranding);
    expect(html).toContain('Withheld by tenants, awaiting certificate');
    expect(html).toMatch(
      /Withheld by tenants, awaiting certificate<\/th><td class="amount">GH₵1,500\.00/,
    );
    expect(html).toMatch(/Still owed at the end of the period<\/th><td class="amount">GH₵0\.00/);
    expect(templates.get('tax.rent-tax-report', 2).pdfDate(report)).toBe('2026-11-30');
  });

  it('keeps version 1 as it was, for documents rendered with it', () => {
    const { withheldAwaitingCertificateMinor: _, ...totals } = report.totals;
    const v1 = { ...report, totals: { ...totals, outstandingMinor: 150_000 } };
    const html = renderHtml(rentTaxReportV1, v1, sampleBranding);
    expect(html).not.toContain('awaiting certificate');
    expect(() => rentTaxReportV1.element(report, sampleBranding)).toThrow();
  });
});
