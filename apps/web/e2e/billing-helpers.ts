import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { ready } from './helpers';
import { newSmsCode, smsIds } from './register-helpers';

/**
 * Helpers for the M4a billing specs. They read the demo dataset `pnpm db:seed` loads (plan 4.21):
 * the agency's Legon compound house (ACC-LEG), looked after by Kojo the caretaker, the East Legon
 * flats (ACC-ELG), and their tenancies with money recorded through the real services.
 */

export interface PhonePerson {
  readonly phone: string;
  readonly name: string;
  /** How a person types the number on the form, the way it is written in Ghana. */
  readonly typed: string;
}

/**
 * Signs in by phone through the real screens (AD-06): one code per call, read from the fake SMS
 * provider and never printed. The API sends at most 3 codes per phone in 15 minutes, so a spec
 * signs in once and keeps the page.
 */
export async function phoneSignIn(page: Page, person: PhonePerson): Promise<void> {
  await page.goto('/sign-in/phone');
  await ready(page, 'Send code');
  const seen = await smsIds(page.request, person.phone);
  await page.getByLabel('Phone number').fill(person.typed);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  const code = await newSmsCode(page.request, person.phone, seen);
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('shell-person')).toHaveText(person.name);
}

async function ok<T>(response: Awaited<ReturnType<APIRequestContext['get']>>, what: string) {
  expect(response.status(), `${what}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

export interface CollectorCashRow {
  readonly collectorPersonId: string;
  readonly collectorName: string;
  readonly ownerName: string;
  readonly heldMinor: number;
  readonly bankingPendingMinor: number;
}

/** What a collector holds for an owner, in pesewas, as the API reports it to this session. */
export async function heldFor(
  page: Page,
  collectorName: string,
  ownerName: string,
): Promise<number> {
  const rows = await ok<CollectorCashRow[]>(
    await page.request.get('/api/v1/collectors/cash'),
    'list cash on hand',
  );
  return (
    rows.find((r) => r.collectorName === collectorName && r.ownerName === ownerName)?.heldMinor ?? 0
  );
}

/** A lease's id by its unit code, as the signed-in person sees it. */
export async function leaseIdByUnit(page: Page, unitCode: string): Promise<string> {
  const rows = await ok<{ id: string; status: string; unit: { code: string } }[]>(
    await page.request.get(`/api/v1/leases?search=${encodeURIComponent(unitCode)}`),
    `find the lease on ${unitCode}`,
  );
  const found = rows.find((r) => r.unit.code === unitCode && r.status !== 'cancelled');
  if (!found) throw new Error(`No lease on ${unitCode}: run pnpm db:seed`);
  return found.id;
}

/**
 * Chooses a lease in the lease picker by its unit code, once the search has found it (the picker
 * searches as you type, after a short pause).
 */
export async function pickLease(scope: Locator, unitCode: string): Promise<void> {
  await scope.getByLabel('Find a lease').fill(unitCode);
  const select = scope.getByLabel('The lease', { exact: true });
  const option = select.locator('option', { hasText: unitCode });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute('value');
  await select.selectOption(value!);
}

/** A distinctive amount for one run, so its approvals are told apart from leftovers: GH₵50.xx. */
export function runAmount(): {
  readonly typed: string;
  readonly minor: number;
  readonly shown: string;
} {
  const pesewas = 1 + Math.trunc(Math.random() * 98);
  const minor = 5_000 + pesewas;
  const typed = `50.${String(pesewas).padStart(2, '0')}`;
  return { typed, minor, shown: `GH₵${typed}` };
}

/** Polls a short-lived document link until the PDF is rendered (a worker job), then fetches it. */
export async function fetchPdf(
  page: Page,
  linkPath: string,
): Promise<{ readonly contentType: string; readonly head: string }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await page.request.get(linkPath);
    if (response.status() === 200) {
      const { url } = (await response.json()) as { url: string };
      const file = await page.request.get(url);
      expect(file.status(), 'download the PDF').toBe(200);
      const body = await file.body();
      return {
        contentType: file.headers()['content-type'] ?? '',
        head: body.subarray(0, 5).toString('latin1'),
      };
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`The document at ${linkPath} was never ready`);
}
