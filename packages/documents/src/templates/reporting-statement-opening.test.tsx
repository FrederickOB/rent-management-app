import { ownerStatementFigures } from '@rent/domain/reporting';
import { describe, expect, it } from 'vitest';
import { renderHtml, templates } from './index';
import type { OwnerStatementDocumentData } from './reporting-statement';
import { sampleBranding } from './test-fixtures';

const OWNER = '019a3000-0000-7000-8000-00000000a011';
const LEGON = '019a3000-0000-7000-8000-00000000b011';

/** The first statement after a pilot company's cut-over (M11 decision 3; P25). */
function data(opening?: OwnerStatementDocumentData['opening']): OwnerStatementDocumentData {
  const figures = ownerStatementFigures({
    ownerId: OWNER,
    month: '2026-11',
    properties: [
      {
        propertyId: LEGON,
        collections: [],
        expenses: [],
        feesMinor: 0,
        rentTax: { accruedMinor: 0, paidMinor: 0, receiptItemsMinor: [] },
        rentEarnedMinor: 150_000,
        serviceChargeEarnedMinor: 0,
        unearnedRentMinor: 200_000,
        depositsHeldMinor: 350_000,
        arrears: [{ bucket: '31_60', amountMinor: 250_000 }],
        occupancy: { occupied: 2 },
      },
    ],
    // The rent tax brought in is part of the payable the month starts from.
    rentTaxPayable: { openingMinor: 24_000, closingMinor: 24_000 },
    agent: null,
  });
  return {
    statementId: '019a3000-0000-7000-8000-00000000c011',
    companyName: 'Demo Lettings Ltd',
    ownerName: 'Kwame Mensah',
    ownerReference: 'OWN-01',
    companyTimeZone: 'Africa/Accra',
    ownerTimeZone: 'Africa/Accra',
    generatedAt: '2026-12-01T06:00:00.000Z',
    issuedAt: '2026-12-02T10:30:00.000Z',
    issuedByName: 'Ama Owusu',
    propertyNames: [{ id: LEGON, name: 'Legon compound house' }],
    figures: figures as unknown as OwnerStatementDocumentData['figures'],
    payments: [],
    expenses: [],
    ...(opening ? { opening } : {}),
  };
}

describe('P25 the first owner statement shows opening balances in their own section', () => {
  const opening = {
    cutOver: '2026-11-01',
    arrearsMinor: 250_000,
    advancesMinor: 300_000,
    depositsMinor: 350_000,
    withholdingMinor: 30_000,
    agentCashMinor: 0,
    rentTaxOutstandingMinor: 24_000,
  };

  it('lists what was brought in at the cut-over, never as income', () => {
    const template = templates.get('reporting.owner-statement', 1);
    const html = renderHtml(template, data(opening), sampleBranding);
    expect(html).toContain('Opening balances brought in');
    expect(html).toContain('1 November 2026');
    expect(html).toContain('Arrears owed by tenants');
    expect(html).toContain('GH₵2,500.00');
    expect(html).toContain('Rent paid in advance');
    expect(html).toContain('GH₵3,000.00');
    expect(html).toContain('Withholding tax awaiting certificates');
    expect(html).toContain('Rent tax still owed to GRA');
    expect(html).toContain('GH₵240.00');
  });

  it('has no opening section on any other statement, and refuses a malformed one', () => {
    const template = templates.get('reporting.owner-statement', 1);
    expect(renderHtml(template, data(), sampleBranding)).not.toContain(
      'Opening balances brought in',
    );
    expect(() =>
      template.element(data({ ...opening, arrearsMinor: 12.5 }), sampleBranding),
    ).toThrow();
  });
});
