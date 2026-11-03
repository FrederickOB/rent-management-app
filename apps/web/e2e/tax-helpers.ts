import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { format, money, parseAmount } from '@rent/domain/money';

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
