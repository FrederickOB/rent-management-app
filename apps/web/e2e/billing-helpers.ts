import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ready } from './helpers';
import { newSmsCode, smsIds } from './register-helpers';

/**
 * Helpers for the M4a billing specs. They read the demo dataset `pnpm db:seed` loads, as plan
 * M4a section 5 lists it for a fresh database: the agency's Legon compound house (ACC-LEG),
 * looked after by Kojo the caretaker, the East Legon flats (ACC-ELG), and their tenancies with
 * money recorded through the real services.
 */

export interface PhonePerson {
  readonly phone: string;
  readonly name: string;
  /** How a person types the number on the form, the way it is written in Ghana. */
  readonly typed: string;
  /** A short name for the saved session's file, never the phone number. */
  readonly label: string;
}

/**
 * Signs in by phone through the real screens (AD-06): one code per call, read from the fake SMS
 * provider and never printed. The API sends at most 3 codes per phone in 15 minutes.
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

/**
 * A browser context signed in by phone, at most once per person per test run: the session is
 * saved in the run's output folder (emptied when a run starts) and reused by a CI retry, so a
 * retried spec does not spend another of the person's 3 codes in 15 minutes.
 */
export async function phoneSession(
  browser: Browser,
  baseURL: string | undefined,
  person: PhonePerson,
): Promise<BrowserContext> {
  const saved = join(test.info().project.outputDir, `.session-${person.label}.json`);
  if (existsSync(saved)) {
    const context = await browser.newContext({ baseURL, storageState: saved });
    const me = await context.request.get('/api/v1/me');
    if (me.status() === 200 && ((await me.json()) as { name: string }).name === person.name)
      return context;
    await context.close();
  }
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await phoneSignIn(page, person);
  await context.storageState({ path: saved });
  await page.close();
  return context;
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
  readonly bankableMinor: number;
}

/** A collector's cash for an owner, in pesewas, as the API reports it to this session. */
export async function cashFor(
  page: Page,
  collectorName: string,
  ownerName: string,
): Promise<CollectorCashRow> {
  const rows = await ok<CollectorCashRow[]>(
    await page.request.get('/api/v1/collectors/cash'),
    'list cash on hand',
  );
  const row = rows.find((r) => r.collectorName === collectorName && r.ownerName === ownerName);
  if (!row) throw new Error(`${collectorName} holds nothing for ${ownerName}: run pnpm db:seed`);
  return row;
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
