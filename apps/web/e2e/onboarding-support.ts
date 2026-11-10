import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { codeFor, DEMO_PASSWORD, ready, submitAuth, unique } from './helpers';
import { invitationToken } from './subscription-support';

/**
 * Helpers for the M11 onboarding spec (plan section 6; P25). The workbooks are built at run time
 * with the same Excel writer the server uses, loaded from packages/server so the web app gains no
 * dependency (the lead's answer, option b). Their sheet names and column headers come from
 * `@rent/domain/onboarding`, the constants the template generator uses.
 */

type Cell = string | number | null;
type WriteXlsx = (sheets: { readonly sheet: string; readonly data: { value: Cell }[][] }[]) => {
  toBuffer(): Promise<Buffer>;
};

const serverRequire = createRequire(
  fileURLToPath(new URL('../../../packages/server/package.json', import.meta.url)),
);

function writer(): WriteXlsx {
  const loaded = serverRequire('write-excel-file/node') as WriteXlsx | { default: WriteXlsx };
  return typeof loaded === 'function' ? loaded : loaded.default;
}

/**
 * An .xlsx workbook: for each sheet, its header row in the order given, then one row per record,
 * each cell taken from the record by its header. A header missing from a record is left blank.
 */
export async function workbook(
  sheets: readonly {
    readonly name: string;
    readonly headers: readonly string[];
    readonly rows: readonly Readonly<Record<string, Cell>>[];
  }[],
): Promise<Buffer> {
  return writer()(
    sheets.map((sheet) => ({
      sheet: sheet.name,
      data: [
        sheet.headers.map((header) => ({ value: header })),
        ...sheet.rows.map((row) => sheet.headers.map((header) => ({ value: row[header] ?? null }))),
      ],
    })),
  ).toBuffer();
}

/** Chooses a workbook built in memory in a file input, as a person would choose a file. */
export async function chooseWorkbook(input: Locator, name: string, buffer: Buffer): Promise<void> {
  await input.setInputFiles({
    name,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  });
}

/**
 * The next authenticator code, from a time window not used yet: a code works once (M11 security
 * review), and the admin used one moments ago to enrol, so this waits for the next 30 seconds.
 */
export async function nextWindowCode(page: Page, secret: string): Promise<string> {
  const window = Math.floor(Date.now() / 30_000);
  const wait = (window + 1) * 30_000 - Date.now() + 500;
  await page.waitForTimeout(wait);
  return codeFor(secret);
}

/**
 * A manager with no owner or property scope, invited by the company's admin, ready to accept.
 *
 * Founder decision D1 (M11 security review): an invite into an approver role waits for a second
 * person's approval. A new company has nobody else, so OQ-29's cooling-off applies. The API's test
 * control ends the cooling-off (`POST /api/v1/_test/approvals/{id}/end-cooling-off`, as a
 * platform admin, only with E2E_TEST_CONTROLS=on), then the admin self-confirms with a fresh code
 * from their authenticator, and the invitation is sent. The manager accepts it next
 * (`acceptInvitation`).
 */
export async function inviteManager(
  admin: { readonly page: Page; readonly secret: string },
  platform: Page,
): Promise<{ readonly email: string; readonly name: string }> {
  const tag = unique();
  const email = `m11.manager.${tag.toLowerCase()}@demo.invalid`;
  const name = `Kofi Approver ${tag} (e2e)`;
  const response = await admin.page.request.post('/api/v1/memberships', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name, email, role: 'property_manager' },
  });
  expect(response.status(), `invite a manager: ${await response.text()}`).toBe(200);
  const invited = (await response.json()) as { approvalRequestId?: string };
  expect(invited.approvalRequestId, 'the invite waits for approval (founder D1)').toBeTruthy();
  const requestId = invited.approvalRequestId!;

  const ended = await platform.request.post(`/api/v1/_test/approvals/${requestId}/end-cooling-off`);
  expect(ended.status(), `end the cooling-off: ${await ended.text()}`).toBe(200);

  const confirmed = await admin.page.request.post(`/api/v1/approvals/${requestId}/decisions`, {
    data: { decision: 'self_confirm', code: await nextWindowCode(admin.page, admin.secret) },
  });
  expect(confirmed.status(), `self-confirm the invite: ${await confirmed.text()}`).toBe(200);
  return { email, name };
}

/** Waits until a batch card's status reads one of these. */
export async function batchStatus(card: Locator, ...texts: string[]): Promise<void> {
  await expect(card.getByTestId('batch-status')).toHaveText(new RegExp(`^(${texts.join('|')})$`), {
    timeout: 120_000,
  });
}

/**
 * Someone invited by email, through the real screens: the invitation link, a new password, then
 * TOTP enrolment. The same steps as `firstAdmin` in subscription-support.ts, kept apart so the
 * M10 specs' setup stays as it was. Returns their signed-in context, page and TOTP secret.
 */
export async function acceptInvitation(
  browser: Browser,
  baseURL: string | undefined,
  email: string,
  name: string,
): Promise<{ context: BrowserContext; page: Page; secret: string }> {
  const token = await invitationToken(email);
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto(`/accept-invite?token=${encodeURIComponent(token)}`);
  await ready(page, 'Set password');
  await page.getByLabel('New password').fill(DEMO_PASSWORD);
  await page.getByLabel('Repeat the password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByText('Your password is set')).toBeVisible();

  await page.goto('/sign-in');
  await ready(page, 'Sign in');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD);
  const signedIn = await submitAuth(page, '/api/auth/sign-in/email', () =>
    page.getByRole('button', { name: 'Sign in' }).click(),
  );
  expect(signedIn.status(), 'the invited person signs in with the new password').toBe(200);
  await expect(page).toHaveURL(/\/enrol$/);
  await ready(page, 'Continue');
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  const secret = (await page.getByTestId('totp-secret').innerText()).replace(/\s+/g, '');
  await page.getByRole('button', { name: 'I have added it' }).click();
  await page.getByLabel('I have saved these backup codes').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  const confirmed = await submitAuth(page, '/api/auth/two-factor/verify-totp', async () => {
    await page.getByLabel('6-digit code').fill(await codeFor(secret));
    await page.getByRole('button', { name: 'Confirm' }).click();
  });
  expect(confirmed.status(), 'the invited person enrols TOTP').toBe(200);
  await expect(page.getByTestId('shell-person')).toHaveText(name);
  return { context, page, secret };
}
