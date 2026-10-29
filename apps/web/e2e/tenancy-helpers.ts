import { expect, type Page } from '@playwright/test';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { readFileSync } from 'node:fs';
import { fixture, freePropertyPart } from './register-helpers';

/**
 * Helpers for the M3 specs (tenants, leases, templates, approvals). Each run makes its own
 * property, tenants and leases, because the e2e database persists and a unit can hold only one
 * lease at a time; nothing a run makes is reused by the next.
 */

/** A phone in the fake +233 20 9xx xxxx block, so a run's tenants never share a number. */
export function freshPhone(): string {
  return `+233209${String(Math.trunc(Math.random() * 1_000_000)).padStart(6, '0')}`;
}

/** A Ghana Card number in the right format (GHA- plus 9 digits, a hyphen and a check digit). */
export function ghanaCardNumber(): string {
  const digits = String(Math.trunc(Math.random() * 1_000_000_000)).padStart(9, '0');
  return `GHA-${digits}-${Math.trunc(Math.random() * 10)}`;
}

/** Today in Accra (the demo companies' time zone), and dates around it, as YYYY-MM-DD. */
export const today = (): string =>
  toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
export const daysFromToday = (days: number): string =>
  toIsoDate(addDays(parseBusinessDate(today()), days));
export const monthsFromToday = (months: number): string =>
  toIsoDate(addMonths(parseBusinessDate(today()), months));
export const dayAfter = (iso: string): string => toIsoDate(addDays(parseBusinessDate(iso), 1));
/** The last day of a term of `months` months from `start`. */
export const termEnd = (start: string, months: number): string =>
  toIsoDate(addDays(addMonths(parseBusinessDate(start), months), -1));

async function ok<T>(response: Awaited<ReturnType<Page['request']['get']>>, what: string) {
  expect(response.status(), `${what}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

/** Owner A (OWN-01) in the agency, as the signed-in person sees them. */
export async function ownerA(page: Page): Promise<string> {
  const owners = await ok<{ id: string; reference: string }[]>(
    await page.request.get('/api/v1/owners'),
    'list owners',
  );
  const found = owners.find((o) => o.reference === 'OWN-01');
  if (!found) throw new Error('No OWN-01: run pnpm db:seed');
  return found.id;
}

export interface NewUnit {
  readonly id: string;
  readonly code: string;
}

/** A new property of single rooms for Owner A, made through the API; its units are vacant. */
export async function newPropertyWithUnits(
  page: Page,
  count = 1,
): Promise<{ propertyId: string; units: NewUnit[] }> {
  const part = await freePropertyPart(page, 'ACC');
  const property = await ok<{ id: string; blocks: { units: NewUnit[] }[] }>(
    await page.request.post('/api/v1/properties', {
      data: {
        areaCode: 'ACC',
        propertyPart: part,
        name: `Lease test rooms ${part} (e2e)`,
        propertyType: 'compound_house',
        use: 'residential',
        ownerId: await ownerA(page),
        address: { region: 'Greater Accra' },
        units: [{ unitType: 'single_room', count }],
      },
    }),
    'create a property',
  );
  return {
    propertyId: property.id,
    units: property.blocks.flatMap((b) => b.units.map((u) => ({ id: u.id, code: u.code }))),
  };
}

/** A new individual tenant, made through the API, with no consent and no ID number. */
export async function newTenant(
  page: Page,
  displayName: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; phone: string }> {
  const phone = freshPhone();
  const saved = await ok<{ tenant: { id: string } }>(
    await page.request.post('/api/v1/tenants', {
      data: { kind: 'individual', displayName, phone, ...extra },
    }),
    'create a tenant',
  );
  return { id: saved.tenant.id, phone };
}

/**
 * A lease already signed on paper, recorded through the API with a scan sent straight to storage
 * (decision 7). A start in the future leaves it signed, with the unit reserved.
 */
export async function recordPaperLease(
  page: Page,
  lease: {
    readonly unitId: string;
    readonly tenantId: string;
    readonly tenantName: string;
    readonly startDate: string;
    readonly months: number;
    readonly monthlyRentMinor: number;
    readonly signedOn: string;
  },
): Promise<string> {
  const scan = readFileSync(fixture('title-deed.pdf'));
  const slot = await ok<{ uploadId: string; url: string; fields: Record<string, string> }>(
    await page.request.post('/api/v1/lease-uploads', {
      data: { contentType: 'application/pdf', sizeBytes: scan.length },
    }),
    'ask for an upload',
  );
  // Storage wants the policy fields first and the file last, as the browser sends them.
  const form = new FormData();
  for (const [key, value] of Object.entries(slot.fields)) form.append(key, value);
  form.append('file', new Blob([scan], { type: 'application/pdf' }), 'paper-lease.pdf');
  const stored = await fetch(slot.url, { method: 'POST', body: form });
  expect(stored.ok, `upload the scan: ${stored.status}`).toBe(true);
  const saved = await ok<{ id: string }>(
    await page.request.post('/api/v1/leases/paper', {
      data: {
        unitId: lease.unitId,
        tenantId: lease.tenantId,
        startDate: lease.startDate,
        endDate: termEnd(lease.startDate, lease.months),
        monthlyRentMinor: lease.monthlyRentMinor,
        cycle: 'monthly',
        noticeDays: 30,
        parties: [{ role: 'tenant', name: lease.tenantName, paperSignedOn: lease.signedOn }],
        scanUploadId: slot.uploadId,
        signedOn: lease.signedOn,
      },
    }),
    'record the paper lease',
  );
  return saved.id;
}

/** A lease as the API shows it to the signed-in person. */
export async function leaseById<
  T = { status: string; renewal: { id: string; status: string } | null },
>(page: Page, leaseId: string): Promise<T> {
  return ok<T>(await page.request.get(`/api/v1/leases/${leaseId}`), 'read the lease');
}
