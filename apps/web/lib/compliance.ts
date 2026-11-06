import type { ApiClient } from '@rent/contracts/client';
import { formatBusinessDate } from './business-dates';

// The compliance list (M9 decision 14): what needs doing for tax and Rent Control, read-only,
// each with a link to the screen where it is dealt with.

export type ComplianceItem = Awaited<ReturnType<ApiClient['compliance']['list']>>[number];

export const COMPLIANCE_KIND_LABELS: Record<ComplianceItem['kind'], string> = {
  rent_tax_due: 'Rent tax due to GRA',
  rent_tax_overdue: 'Rent tax overdue to GRA',
  rent_control_registration: 'Rent Control registration outstanding',
  withholding_certificate: 'Withholding tax certificate awaited',
  vat_return: 'VAT return due',
  advance_over_cap: 'Advance rent over the limit',
};

/** Overdue first, then by the date it falls due (undated last), then by kind. */
export function sortCompliance<T extends Pick<ComplianceItem, 'kind' | 'dueDate'>>(
  items: readonly T[],
): T[] {
  const rank = (i: T) => (i.kind === 'rent_tax_overdue' ? 0 : 1);
  return [...items].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.dueDate ?? '9999-99-99').localeCompare(b.dueDate ?? '9999-99-99') ||
      a.kind.localeCompare(b.kind),
  );
}

/** Where the item is dealt with: the screens that exist, or the lease. */
export function complianceHref(item: Pick<ComplianceItem, 'link' | 'lease'>): string | null {
  const leaseId = item.link.id ?? item.lease?.id ?? null;
  switch (item.link.screen) {
    case 'rent_tax':
      return '/tax/rent';
    case 'vat':
      return '/tax/vat';
    case 'advance_rent':
      return '/compliance/advance-rent';
    case 'rent_control':
    case 'withholding':
    case 'lease':
      return leaseId ? `/leases/${leaseId}` : null;
  }
}

export const COMPLIANCE_LINK_TEXT: Record<ComplianceItem['link']['screen'], string> = {
  rent_tax: 'Open rent tax',
  vat: 'Open VAT returns',
  advance_rent: 'Open the advance rent report',
  rent_control: 'Open the lease’s trackers',
  withholding: 'Open the lease’s withholding',
  lease: 'Open the lease',
};

/** "Due 15 Nov 2026", "Overdue since 1 Nov 2026", or nothing when no date applies. */
export function dueText(item: Pick<ComplianceItem, 'kind' | 'dueDate'>): string | null {
  if (!item.dueDate) return null;
  return item.kind === 'rent_tax_overdue'
    ? `Overdue since ${formatBusinessDate(item.dueDate)}`
    : `Due ${formatBusinessDate(item.dueDate)}`;
}
