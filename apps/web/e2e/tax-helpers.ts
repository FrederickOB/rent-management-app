import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { format, money, parseAmount } from '@rent/domain/money';
import { fixture } from './register-helpers';
import { today } from './tenancy-helpers';

/**
 * Helpers for the M5 specs (rent tax, withholding, early termination, VAT, advance rent). They
 * read the demo dataset `pnpm db:seed` loads, as plan M5 section 5.10 lists it for a fresh
 * database: rent tax on every seeded receipt; a GRA payment settling part of an owner's items; the
 * commercial tenant on ACC-OSU-G-01 withholding tax, one certificate confirmed and one waiting; a
 * VAT payment; an early termination with its refund request waiting; and a lease flagged under
 * `warn` in a second demo company. Figures are read from the API, never assumed.
 */

/** `GH₵1,500.00` for pesewas, as the screens show it. */
export const cedis = (minor: number): string => format(money(minor));

/** Pesewas for an amount the screen shows, such as `GH₵1,500.00` or `-GH₵7.00`. */
export function pesewasOf(text: string): number {
  const trimmed = text.trim();
  const negative = trimmed.startsWith('-');
  const minor = parseAmount(trimmed.replace(/^-/, '').replace(/^GH₵/, '')).amountMinor;
  return negative ? -minor : minor;
}

/** A GET of the API as the signed-in person, which must answer 200. */
export async function apiGet<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`/api/v1${path}`);
  expect(response.status(), `GET ${path}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

/** An owner's id by their name, as the signed-in person sees owners. */
export async function ownerIdByName(page: Page, name: string): Promise<string> {
  const owners = await apiGet<{ id: string; displayName: string }[]>(page.request, '/owners');
  const owner = owners.find((o) => o.displayName === name);
  if (!owner) throw new Error(`No owner ${name}: run pnpm db:seed`);
  return owner.id;
}

/** The signed-in person's id. */
export async function myPersonId(page: Page): Promise<string> {
  return (await apiGet<{ personId: string }>(page.request, '/me')).personId;
}

/** `2026-11` for a date such as `2026-11-03`. */
export const monthOf = (date: string): string => date.slice(0, 7);

/**
 * The owner whose book a lease's money is in, as the API resolves it: the owner on the lease's
 * first invoice, or else the property's one current owner.
 */
export async function leaseOwnerId(page: Page, leaseId: string): Promise<string> {
  const invoices = await apiGet<{ number: string; ownerId: string }[]>(
    page.request,
    `/invoices?leaseId=${leaseId}&limit=500`,
  );
  const first = [...invoices].sort((a, b) => (a.number < b.number ? -1 : 1))[0];
  if (first) return first.ownerId;
  const lease = await apiGet<{ unit: { propertyId: string } }>(page.request, `/leases/${leaseId}`);
  const property = await apiGet<{ ownership: { ownerId: string; current: boolean }[] }>(
    page.request,
    `/properties/${lease.unit.propertyId}`,
  );
  const owners = property.ownership.filter((o) => o.current);
  expect(owners, 'the lease’s property has one current owner').toHaveLength(1);
  return owners[0]!.ownerId;
}

/**
 * F3 setup (founder-approved class, 2026-11-07): money the owner sent the agency (P30), recorded
 * through the API with its proof, so the agency holds at least `amountMinor` for the lease's owner
 * before a refund is paid from the agency's account.
 */
export async function fundLeaseOwner(
  page: Page,
  leaseId: string,
  amountMinor: number,
): Promise<void> {
  const ownerId = await leaseOwnerId(page, leaseId);
  const proof = readFileSync(fixture('title-deed.pdf'));
  const slotResponse = await page.request.post('/api/v1/owner-money-uploads', {
    data: { contentType: 'application/pdf', sizeBytes: proof.length },
  });
  expect(slotResponse.status(), `ask for a proof upload: ${await slotResponse.text()}`).toBe(200);
  const slot = (await slotResponse.json()) as {
    uploadId: string;
    url: string;
    fields: Record<string, string>;
  };
  const form = new FormData();
  for (const [key, value] of Object.entries(slot.fields)) form.append(key, value);
  form.append('file', new Blob([proof], { type: 'application/pdf' }), 'funding.pdf');
  const stored = await fetch(slot.url, { method: 'POST', body: form });
  expect(stored.ok, `upload the proof: ${stored.status}`).toBe(true);
  const funded = await page.request.post('/api/v1/owner-funding', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      ownerId,
      on: today(),
      method: 'bank',
      reference: `FUND-E2E-${randomUUID().slice(0, 8)}`,
      amountMinor,
      proofUploadId: slot.uploadId,
    },
  });
  expect(funded.status(), `record the owner’s funding: ${await funded.text()}`).toBe(200);
}
