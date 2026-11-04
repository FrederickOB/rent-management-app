import { describe, expect, it } from 'vitest';
import {
  ARREARS_KEY_LABELS,
  BUCKET_COLUMNS,
  bucketMinor,
  overdueInvoicesHref,
  parseArrearsBy,
  recordHref,
} from './arrears-view';
import { ageBucketLabel } from './billing-format';

const KEY = '019a3000-0000-7000-8000-0000000000c9';

describe('BC-08 arrears ageing on screen', () => {
  it('shows the four buckets in age order, as the PRD names them', () => {
    expect(BUCKET_COLUMNS.map(ageBucketLabel)).toEqual([
      '0–30 days',
      '31–60 days',
      '61–90 days',
      'Over 90 days',
    ]);
  });

  it('groups by tenant unless the address asks for property or owner', () => {
    expect(parseArrearsBy('property')).toBe('property');
    expect(parseArrearsBy('owner')).toBe('owner');
    expect(parseArrearsBy(null)).toBe('tenant');
    expect(parseArrearsBy('landlord')).toBe('tenant');
    expect(ARREARS_KEY_LABELS.owner).toBe('Owner');
  });

  it('links each row to its overdue invoices and to its record', () => {
    expect(overdueInvoicesHref('tenant', KEY)).toBe(`/invoices?overdue=true&tenantId=${KEY}`);
    expect(overdueInvoicesHref('property', KEY)).toBe(`/invoices?overdue=true&propertyId=${KEY}`);
    expect(overdueInvoicesHref('owner', KEY)).toBe(`/invoices?overdue=true&ownerId=${KEY}`);
    expect(recordHref('tenant', KEY)).toBe(`/tenants/${KEY}`);
    expect(recordHref('property', KEY)).toBe(`/portfolio/properties/${KEY}`);
    expect(recordHref('owner', KEY)).toBe('/owners');
  });

  it('reads a bucket the API left out as nothing owed', () => {
    expect(bucketMinor({ '0_30': 40_000 }, '0_30')).toBe(40_000);
    expect(bucketMinor({ '0_30': 40_000 }, '90_plus')).toBe(0);
  });
});
