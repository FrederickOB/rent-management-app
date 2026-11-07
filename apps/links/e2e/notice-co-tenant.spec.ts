import { createHash } from 'node:crypto';
import { NOTICE_SIGNING_STATEMENT } from '@rent/domain/esign';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { codeTextedTo, managerApi, ok, smsTo } from './signing-support';

// A co-tenant acknowledges a notice for himself (M7 decision 7, review C3; LN-04 and data S8).
// The seed (pnpm db:seed, M7) lets ACC-LEG-B1-04 to Adjoa Joint-Tenant (demo), +233200000053, with
// her co-tenant Kwabena Joint-Tenant (demo), +233200000054, and serves them rent review N-000007:
// Adjoa has acknowledged it, Kwabena has not. A co-tenant has no tenant record of his own, so he
// acknowledges through his own link, as M3's lease co-signers sign; the tenant app does not list
// it. This spec signs Kwabena's acknowledgement, so it needs a fresh seed.
test.describe.configure({ mode: 'serial' });

const UNIT = 'ACC-LEG-B1-04';
const NUMBER = 'N-000007';
const CO_TENANT = 'Kwabena Joint-Tenant (demo)';
const CO_TENANT_PHONE = '+233200000054';
const LINK_PATH = /\/l\/[A-Za-z0-9_-]{43}/;

interface Recipient {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly signedAt: string | null;
}
interface NoticeDetail {
  readonly id: string;
  readonly number: string | null;
  readonly typeLabel: string;
  readonly unitCode: string | null;
  readonly document: { readonly sha256: string | null };
  readonly recipients: readonly Recipient[];
}

let staff: APIRequestContext;
let noticeId: string;
let before: NoticeDetail;
let kwabena: Recipient;
let path: string;
let signedAfter = 0;

const sha256 = (bytes: ArrayBuffer) =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex');

/** The PDF a links page's `/document` route hands out, and its SHA-256. */
async function downloadedSha256(request: APIRequestContext, pagePath: string): Promise<string> {
  const redirect = await request.get(`${pagePath}/document`, { maxRedirects: 0 });
  expect(redirect.status(), `${pagePath}/document redirects to the file`).toBe(303);
  const location = redirect.headers()['location'];
  expect(location, 'a storage link').toMatch(/^https?:\/\//);
  const file = await fetch(location!);
  expect(file.status, 'the storage link works').toBe(200);
  return sha256(await file.arrayBuffer());
}

const detail = async () =>
  ok<NoticeDetail>(await staff.get(`/notices/${noticeId}`), `notice ${NUMBER}`);

test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
  testInfo.setTimeout(120_000);
  staff = await managerApi();
  const rows = await ok<{ id: string; number: string | null; unitCode: string | null }[]>(
    await staff.get('/notices'),
    'the notices list',
  );
  const row = rows.find((r) => r.number === NUMBER && r.unitCode === UNIT);
  if (!row) throw new Error(`No ${NUMBER} on ${UNIT}: run pnpm db:seed (M7)`);
  noticeId = row.id;
  before = await detail();
  const found = before.recipients.find((r) => r.name === CO_TENANT);
  if (!found) throw new Error(`${CO_TENANT} is not a recipient of ${NUMBER}`);
  kwabena = found;
  expect(kwabena.kind).toBe('co_tenant');
  expect(kwabena.signedAt, `${CO_TENANT} has acknowledged already: run on a fresh seed`).toBeNull();
  // Adjoa, the tenant, acknowledged in the seed.
  expect(before.recipients.some((r) => r.name !== CO_TENANT && r.signedAt !== null)).toBe(true);

  const link = await ok<{ url: string }>(
    await staff.post(`/notices/${noticeId}/recipients/${kwabena.id}/link`, { data: {} }),
    `a hand-over link for ${CO_TENANT}`,
  );
  path = LINK_PATH.exec(link.url)?.[0] ?? '';
  expect(path, 'the link names a links page').not.toBe('');
});

test.afterAll(async () => {
  await staff?.dispose();
});

test.describe('LN-04 a co-tenant acknowledges a notice for himself (review C3)', () => {
  test('his own page opens, with the statement above the signature box', async ({ page }) => {
    await page.goto(path);
    await expect(
      page.getByRole('heading', { name: `Notice ${NUMBER}: ${before.typeLabel}`, exact: true }),
    ).toBeVisible();
    await expect(page.getByText(`has sent you, ${CO_TENANT}, this notice`)).toBeVisible();
    await expect(page.locator('section#sign').getByText(NOTICE_SIGNING_STATEMENT)).toBeVisible();
    await expect(page.getByText('I do not want to sign')).toHaveCount(0);
  });

  test('he signs with the code sent to his own phone, and only his acknowledgement is recorded', async ({
    page,
  }) => {
    await page.goto(path);
    const started = Date.now();
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await expect(page.getByText(/We sent a code by SMS to/)).toBeVisible();
    await page.getByLabel('Your 6-digit code').fill(await codeTextedTo(CO_TENANT_PHONE, started));
    await page.getByLabel('Type your full name to sign').fill('Kwabena Joint-Tenant');
    await page.getByRole('checkbox').check();
    signedAfter = Date.now();
    await page.getByRole('button', { name: 'Sign to acknowledge receipt' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Thank you: you have acknowledged receipt',
    );

    const after = await detail();
    for (const recipient of after.recipients) {
      const earlier = before.recipients.find((r) => r.id === recipient.id);
      if (recipient.id === kwabena.id) expect(recipient.signedAt, CO_TENANT).not.toBeNull();
      // Everyone else stays as they were: Adjoa's acknowledgement is her own, and his is his.
      else expect(recipient.signedAt, recipient.name).toBe(earlier?.signedAt ?? null);
    }
  });

  test('after signing, his ordinary link downloads only the frozen notice; the acknowledged copy comes through the signed-copy link (data S8)', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const frozen = (await detail()).document.sha256;
    expect(frozen, 'the frozen notice’s fingerprint').toMatch(/^[0-9a-f]{64}$/);

    // His ordinary link: the frozen notice, never the copy with the certificate.
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'You have already acknowledged receipt',
    );
    await expect(page.getByText(/acknowledgement \(PDF\)|signed acknowledgement/i)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Download the notice (PDF)' })).toBeVisible();
    expect(await downloadedSha256(request, path)).toBe(frozen);

    // The signed-copy link goes to his phone once his acknowledgement is complete.
    let copyPath = '';
    await expect
      .poll(
        async () => {
          const message = (await smsTo(CO_TENANT_PHONE)).find(
            (m) => /acknowledged copy/i.test(m.body) && Date.parse(m.at) >= signedAfter - 1_000,
          );
          copyPath = message ? (LINK_PATH.exec(message.body)?.[0] ?? '') : '';
          return copyPath;
        },
        { message: 'the signed-copy link reaches the co-tenant by SMS', timeout: 60_000 },
      )
      .not.toBe('');
    expect(copyPath).not.toBe(path);

    await page.goto(copyPath);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Your signed acknowledgement is ready',
    );
    const shown = await page
      .getByText(/^Fingerprint of the signed acknowledgement/)
      .locator('code')
      .innerText();
    expect(shown).toMatch(/^[0-9a-f]{64}$/);
    expect(shown).not.toBe(frozen);
    const copy = await downloadedSha256(request, copyPath);
    expect(copy).toBe(shown);
    expect(copy).not.toBe(frozen);
  });
});
