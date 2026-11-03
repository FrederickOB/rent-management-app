import { buildLeaseDocument, checkLeaseTerms, STARTER_TEMPLATES } from '@rent/domain/tenancy';
import { describe, expect, it } from 'vitest';
import { renderHtml } from './index';
import { leaseV1 } from './lease';
import { sampleBranding } from './test-fixtures';

describe('TL-06 a two-yearly lease document (M4b decision 9)', () => {
  it('says the rent is billed every two years, in the frozen lease the tenant signs', () => {
    const terms = checkLeaseTerms({
      startDate: '2026-11-01',
      endDate: '2028-10-31',
      monthlyRentMinor: 150_000,
      cycle: 'two_yearly',
      noticeDays: 90,
      use: 'residential',
    });
    const document = buildLeaseDocument(STARTER_TEMPLATES.residential, {
      title: 'Residential tenancy agreement',
      reference: 'L-0024',
      landlordName: 'Ama Owner',
      agentName: null,
      tenantName: 'Yaw Two-Year',
      tenantPhone: null,
      tenantEmail: null,
      signatoryNames: ['Yaw Two-Year'],
      guarantorName: null,
      propertyName: 'East Legon Flats',
      propertyAddress: 'East Legon, Accra',
      unitCode: 'ACC-ELG-B1-04',
      unitDescription: 'Two-bedroom flat',
      terms,
      servicePhones: [],
      serviceEmails: [],
      parties: [{ role: 'tenant', name: 'Yaw Two-Year' }],
    });
    const html = renderHtml(leaseV1, document, sampleBranding);
    expect(html).toContain('billed every two years');
    expect(html).toContain('24 months');
  });
});
