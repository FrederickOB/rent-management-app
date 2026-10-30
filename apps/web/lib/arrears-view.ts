import type { Arrears } from '@rent/contracts';
import { AGE_BUCKETS, type AgeBucket } from '@rent/domain/billing';

// The arrears screen (BC-08; M4a plan 4.12): overdue invoice lines aged by days past their due
// date, as of a date, grouped by tenant, property or owner. The API ages them; this only lays
// the table out and links each row to the invoices behind it.

export type ArrearsBy = Arrears['by'];
export const ARREARS_BY: readonly ArrearsBy[] = ['tenant', 'property', 'owner'];

export const ARREARS_BY_LABELS: Record<ArrearsBy, string> = {
  tenant: 'By tenant',
  property: 'By property',
  owner: 'By owner',
};

/** The first column's heading. */
export const ARREARS_KEY_LABELS: Record<ArrearsBy, string> = {
  tenant: 'Tenant',
  property: 'Property',
  owner: 'Owner',
};

/** The invoice-list filter each grouping maps to. */
const FILTER_OF: Record<ArrearsBy, 'tenantId' | 'propertyId' | 'ownerId'> = {
  tenant: 'tenantId',
  property: 'propertyId',
  owner: 'ownerId',
};

/** Columns in age order, oldest last, as the PRD lists them (0–30 to 90+). */
export const BUCKET_COLUMNS: readonly AgeBucket[] = AGE_BUCKETS;

/** `by` from the address, or by tenant. */
export function parseArrearsBy(value: string | null | undefined): ArrearsBy {
  return ARREARS_BY.find((by) => by === value) ?? 'tenant';
}

/** The overdue invoices behind a row: the invoice list filtered to its tenant, property or owner. */
export function overdueInvoicesHref(by: ArrearsBy, key: string): string {
  return `/invoices?overdue=true&${FILTER_OF[by]}=${encodeURIComponent(key)}`;
}

/** The record a row is about, where the app has a page for it (owners are listed, not paged). */
export function recordHref(by: ArrearsBy, key: string): string {
  const pages: Record<ArrearsBy, string> = {
    tenant: `/tenants/${key}`,
    property: `/portfolio/properties/${key}`,
    owner: '/owners',
  };
  return pages[by];
}

/** Rows that open a tenant's page, which needs tenant.view. */
export const OPENS_TENANT: Record<ArrearsBy, boolean> = {
  tenant: true,
  property: false,
  owner: false,
};

/** A bucket's amount for a row, as pesewas; zero where the API sent none. */
export const bucketMinor = (
  buckets: Partial<Record<AgeBucket, number>>,
  bucket: AgeBucket,
): number => buckets[bucket] ?? 0;
