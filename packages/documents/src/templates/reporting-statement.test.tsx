import { ownerStatementFigures } from '@rent/domain/reporting';
import { describe, expect, it } from 'vitest';
import { renderHtml, templates } from './index';
import type { OwnerStatementDocumentData } from './reporting-statement';
import { sampleBranding } from './test-fixtures';

const OWNER = '019a3000-0000-7000-8000-00000000a001';
const OSU = '019a3000-0000-7000-8000-00000000b001';
const LEGON = '019a3000-0000-7000-8000-00000000b002';

/** Two properties and an agency, as the server works them out (AC-04; decisions 5 to 7). */
function data(): OwnerStatementDocumentData {
  const figures = ownerStatementFigures({
    ownerId: OWNER,
    month: '2026-10',
    properties: [
      {
        propertyId: OSU,
        collections: [
          { method: 'momo', amountMinor: 150_000 },
          { method: 'cash', amountMinor: 50_000 },
        ],
        expenses: [{ category: 'repairs', amountMinor: 12_500 }],
        feesMinor: 20_000,
        rentTax: { accruedMinor: 16_000, paidMinor: 0, receiptItemsMinor: [12_000, 4_000] },
        rentEarnedMinor: 200_000,
        serviceChargeEarnedMinor: 0,
        unearnedRentMinor: 300_000,
        depositsHeldMinor: 400_000,
        arrears: [{ bucket: '31_60', amountMinor: 81_000 }],
        occupancy: { occupied: 3, vacant: 1, under_repair: 1 },
      },
      {
        propertyId: LEGON,
        collections: [],
        expenses: [],
        feesMinor: 0,
        rentTax: { accruedMinor: 0, paidMinor: 0, receiptItemsMinor: [] },
        rentEarnedMinor: 0,
        serviceChargeEarnedMinor: 0,
        unearnedRentMinor: 0,
        depositsHeldMinor: 0,
        arrears: [],
        occupancy: { vacant: 2 },
      },
    ],
    processingFeesMinor: 1_950,
    rentTaxPayable: { openingMinor: 0, closingMinor: 16_000 },
    agent: {
      cash: {
        openingMinor: 0,
        closingMinor: 187_500,
        in: [{ kind: 'collections', amountMinor: 200_000 }],
        out: [{ kind: 'expenses_paid', amountMinor: 12_500 }],
      },
      feesDue: { openingMinor: 0, closingMinor: 20_000 },
      graPaidBy: 'agency',
    },
  });
  return {
    statementId: '019a3000-0000-7000-8000-00000000c001',
    companyName: 'Demo Lettings Ltd',
    ownerName: 'Kwame Mensah',
    ownerReference: 'OWN-01',
    companyTimeZone: 'Africa/Accra',
    ownerTimeZone: 'Europe/London',
    generatedAt: '2026-11-01T06:00:00.000Z',
    issuedAt: '2026-11-02T10:30:00.000Z',
    issuedByName: 'Ama Owusu',
    propertyNames: [
      { id: OSU, name: 'Osu mixed-use building' },
      { id: LEGON, name: 'Legon compound house' },
    ],
    figures: figures as unknown as OwnerStatementDocumentData['figures'],
    payments: [
      {
        propertyId: OSU,
        unitCode: 'ACC-OSU-B1-01',
        kind: 'received',
        method: 'momo',
        receivedOn: '2026-10-10',
        recordedAt: '2026-10-10T09:15:00.000Z',
        amountMinor: 150_000,
      },
    ],
    expenses: [
      {
        id: '019a3000-0000-7000-8000-00000000d001',
        propertyId: OSU,
        category: 'repairs',
        supplierName: 'Nii Plumbing',
        expenseDate: '2026-10-12',
        amountMinor: 12_500,
        noReceipt: true,
      },
    ],
  };
}

describe('AC-04 the owner statement PDF', () => {
  it('shows a page per property, then the summary with the agent’s side, in the owner’s time zone', () => {
    const template = templates.get('reporting.owner-statement', 1);
    const html = renderHtml(template, data(), sampleBranding);
    expect(html).toContain('Owner statement: October 2026');
    expect(html).toContain('Osu mixed-use building');
    expect(html).toContain('Legon compound house');
    expect(html).toContain('Summary: every property');
    // The month is the company's; every time is the owner's, named (decision 5; DO-04).
    expect(html).toContain('1 October 2026 to 31 October 2026 (Africa/Accra)');
    expect(html).toContain('(Europe/London)');
    expect(html).toContain('2 Nov 2026, 10:30 GMT (Europe/London)');
    // Cash, accrual and occupancy; amounts in cedis.
    expect(html).toContain('GH₵2,000.00');
    expect(html).toContain('GH₵810.00');
    expect(html).toContain('Occupancy (occupied of lettable)');
    expect(html).toContain('60.00%');
    // M8 F3: an expense without a receipt says so.
    expect(html).toContain('No receipt');
    // The agency pays GRA: the rent tax payable is held back from the net remittable.
    expect(html).toContain('Rent tax held back for GRA');
    expect(html).toContain('The agency');
    expect(html).toContain('Passed');
  });

  it('refuses data that does not fit: amounts that are not whole pesewas, or unknown fields', () => {
    const template = templates.get('reporting.owner-statement', 1);
    const good = data();
    expect(() => template.element(good, sampleBranding)).not.toThrow();
    expect(() =>
      template.element(
        { ...good, expenses: [{ ...good.expenses[0]!, amountMinor: 12.5 }] },
        sampleBranding,
      ),
    ).toThrow();
    expect(() => template.element({ ...good, extra: true }, sampleBranding)).toThrow();
    expect(() =>
      template.element({ ...good, ownerTimeZone: 'Mars/Olympus' }, sampleBranding),
    ).toThrow();
  });
});
