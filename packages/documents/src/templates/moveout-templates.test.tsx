import { describe, expect, it } from 'vitest';
import { templates } from './catalog';

const branding = { senderName: 'Osu Ridge', primaryColour: '#0F766E', accentColour: '#F59E0B' };

describe('TL-11 and TL-08 the move-out documents render from the data the server sends', () => {
  it('renders the final statement with its move-out id, and the move-in report with its title', () => {
    const statement = templates.get('tenancy.final-statement', 1);
    expect(() =>
      statement.element(
        {
          moveOutId: '0195f0a2-7c1e-7a10-9b4e-1a2b3c4d5e6f',
          generatedOn: '2026-11-05',
          timeZone: 'Africa/Accra',
          landlord: { name: 'Owner' },
          tenant: { name: 'Tenant' },
          unit: { code: 'ACC-LEG-B1-06', propertyName: 'Legon' },
          lastDay: '2026-11-05',
          early: true,
          depositHeldMinor: 120_000,
          creditMinor: 0,
          arrearsMinor: 20_000,
          chargesMinor: 0,
          breakCreditMinor: 0,
          creditToArrears: [],
          depositToArrears: [{ label: 'INV-000001 Rent', amountMinor: 20_000 }],
          deductions: [],
          retainedMinor: 0,
          deductionsChargedMinor: 0,
          creditRefundMinor: 0,
          depositRefundMinor: 100_000,
          refundMinor: 100_000,
          stillOwedMinor: 0,
        },
        branding,
      ),
    ).not.toThrow();
    const report = templates.get('inspection.move-in', 1);
    expect(() =>
      report.element(
        {
          title: 'Move-in report, ACC-LEG-B1-01',
          reference: 'ACC-LEG-B1-01',
          inspectionId: '0195f0a2-7c1e-7a10-9b4e-1a2b3c4d5e6f',
          submittedAt: '2026-11-05T10:00:00.000Z',
          timeZone: 'Africa/Accra',
          landlord: { name: 'Owner' },
          tenant: { name: 'Tenant' },
          unit: { code: 'ACC-LEG-B1-01', propertyName: 'Legon' },
          leaseStart: '2026-11-01',
          inspectedBy: null,
          items: [
            { roomLabel: 'Room', itemLabel: 'Walls', condition: 'good', note: null, photos: [] },
          ],
        },
        branding,
      ),
    ).not.toThrow();
  });
});
