import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * Helpers for the property register specs (M2). They rely on the demo register that
 * `pnpm db:seed` loads (packages/server/scripts/seed.ts, CLAUDE.md section 14):
 * - Owner A, OWN-01, Ama Owner-London (lives in London): ACC-LEG (compound house, blocks B1 and
 *   B2) and ACC-ELG (8 flats);
 * - Owner B, OWN-02, Nana Owner-Accra: ACC-OSU (shops in block G, offices in block F1);
 * - Kojo the caretaker looks after ACC-LEG only; each client owner sees only their own record.
 */
export const FAKE_PROVIDERS = process.env.FAKE_PROVIDERS_URL ?? 'http://localhost:4010';

export const OWNER_A = {
  email: 'owner.london@demo.invalid',
  name: 'Ama Owner-London (demo)',
  option: 'Ama Owner-London (demo) (OWN-01)',
};
export const OWNER_B = {
  email: 'owner.accra@demo.invalid',
  name: 'Nana Owner-Accra (demo)',
  option: 'Nana Owner-Accra (demo) (OWN-02)',
};
export const CARETAKER_LEGON = { phone: '+233200000011', name: 'Kojo Caretaker (demo)' };

export const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

interface PropertyRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

interface UnitRef {
  readonly id: string;
  readonly code: string;
  readonly availability: string;
}

/** A property by its code, through the API as the person signed in on this page. */
export async function propertyByCode(page: Page, code: string): Promise<PropertyRef> {
  const response = await page.request.get(
    `/api/v1/properties?search=${encodeURIComponent(code)}&includeArchived=true`,
  );
  expect(response.status(), `list properties matching ${code}`).toBe(200);
  const { rows } = (await response.json()) as { rows: PropertyRef[] };
  const found = rows.find((r) => r.code === code);
  if (!found) throw new Error(`No property ${code}: run pnpm db:seed`);
  return found;
}

/** A unit by its code, through the API as the person signed in on this page. */
export async function unitByCode(page: Page, code: string): Promise<UnitRef> {
  const response = await page.request.get(
    `/api/v1/units?search=${encodeURIComponent(code)}&includeArchived=true&limit=10`,
  );
  expect(response.status(), `list units matching ${code}`).toBe(200);
  const { rows } = (await response.json()) as { rows: UnitRef[] };
  const found = rows.find((r) => r.code === code);
  if (!found) throw new Error(`No unit ${code}: run pnpm db:seed`);
  return found;
}

/**
 * A property part nobody has used in `area`, archived properties included: the e2e database
 * persists between runs and codes are never reused (M2 plan 4.3), so each run takes a new one.
 */
export async function freePropertyPart(page: Page, area: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const part = `Q${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    if (!/^Q[A-Z0-9]{3}$/.test(part)) continue;
    const response = await page.request.get(
      `/api/v1/properties?search=${area}-${part}&includeArchived=true`,
    );
    expect(response.status()).toBe(200);
    const { rows } = (await response.json()) as { rows: PropertyRef[] };
    if (!rows.some((r) => r.code === `${area}-${part}`)) return part;
  }
  throw new Error(`No free property code in ${area}`);
}

/** The SMS already in the fake provider's inbox for a phone, so a new one can be told apart. */
export async function smsIds(request: APIRequestContext, phone: string): Promise<Set<string>> {
  const response = await request.get(
    `${FAKE_PROVIDERS}/messages?channel=sms&to=${encodeURIComponent(phone)}`,
  );
  return new Set(((await response.json()) as { id: string }[]).map((m) => m.id));
}

/**
 * The code in the first SMS to reach `phone` that is not in `seen`. Codes only ever go to the
 * fake provider's inbox; the test reads them there and never prints them.
 */
export async function newSmsCode(
  request: APIRequestContext,
  phone: string,
  seen: ReadonlySet<string>,
): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await request.get(
      `${FAKE_PROVIDERS}/messages?channel=sms&to=${encodeURIComponent(phone)}`,
    );
    const messages = (await response.json()) as { id: string; body: string }[];
    const fresh = messages.find((m) => !seen.has(m.id));
    const code = fresh && /\b(\d{6})\b/.exec(fresh.body)?.[1];
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('No sign-in code reached the fake SMS provider');
}

/** Uploads a photo or paper through the property page's own form (PR-04). */
export async function uploadOnPropertyPage(
  page: Page,
  file: { readonly kind: string; readonly caption: string; readonly path: string },
): Promise<void> {
  const form = page.getByRole('form', { name: 'Upload a photo or paper' });
  await form.getByLabel('What is it?').selectOption({ label: file.kind });
  await form.getByLabel('Caption (optional)').fill(file.caption);
  await form.getByLabel('File', { exact: true }).setInputFiles(file.path);
  await form.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(form.getByRole('status').filter({ hasText: /^Uploaded / })).toBeVisible();
}

/** Archives the files a run added, so the demo properties do not fill up (removal keeps the record). */
export async function removeFiles(page: Page, propertyId: string, tag: string): Promise<void> {
  const response = await page.request.get(`/api/v1/properties/${propertyId}/files`);
  if (response.status() !== 200) return;
  const files = (await response.json()) as { id: string; caption: string | null }[];
  for (const file of files.filter((f) => f.caption?.includes(tag)))
    await page.request.post(`/api/v1/property-files/${file.id}/archive`);
}

/** No sideways scrolling: the page fits the screen it is on (360 px for a 5-inch phone). */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}
