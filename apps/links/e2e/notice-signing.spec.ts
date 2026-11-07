import { NOTICE_SIGNING_STATEMENT } from '@rent/domain/esign';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { leaseDueToday, type PayLease } from './pay-support';
import { DEV_LINKS_API_KEY, LINKS_API_KEY_HEADER } from '@rent/contracts';
import { API, codeTextedTo, managerApi, ok } from './signing-support';
import { headerValues } from './support';

// A notice's signing page (M7 plan 4.5 and 4.8; LN-02, LN-04; CLAUDE.md section 9). The demo
// manager issues a notice of entry on a new paper lease (pnpm db:seed; the agency is on Growth),
// and the tenant opens it from a hand-over link: the statement above the signature box, no
// decline, signing with a one-time code by SMS, the page's weight; and a corrected notice's link,
// read-only, with a banner naming the new notice. Needs the running stack and the worker, which
// freezes each notice's PDF before its links open.
test.describe.configure({ mode: 'serial' });

const ONE_MB = 1_000_000;

interface NoticeDetail {
  readonly id: string;
  readonly number: string | null;
  readonly recipients: readonly { readonly id: string; readonly signedAt: string | null }[];
}

let staff: APIRequestContext;
let lease: PayLease;
/** The notice the tenant signs, and its page. */
let signed: NoticeDetail;
let signedPath: string;

const inDays = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** A notice of entry for the lease, issued by the manager. */
async function issueEntryNotice(api: APIRequestContext, leaseId: string): Promise<NoticeDetail> {
  const draft = await ok<NoticeDetail>(
    await api.post('/notices', {
      data: {
        type: 'entry',
        subtype: 'inspection',
        leaseId,
        fields: { entryDate: inDays(10), windowFrom: '10:00', windowTo: '12:00' },
      },
    }),
    'draft a notice of entry',
  );
  return ok<NoticeDetail>(await api.post(`/notices/${draft.id}/issue`, { data: {} }), 'issue it');
}

/** The page path of a recipient's link, once the worker has frozen the PDF and opened signing. */
async function noticeLinkPath(api: APIRequestContext, notice: NoticeDetail): Promise<string> {
  let path = '';
  await expect
    .poll(
      async () => {
        const response = await api.post(
          `/notices/${notice.id}/recipients/${notice.recipients[0]!.id}/link`,
          { data: {} },
        );
        if (response.status() !== 200) return false;
        const { url } = (await response.json()) as { url: string };
        path = /\/l\/[A-Za-z0-9_-]{43}/.exec(url)?.[0] ?? '';
        return path !== '';
      },
      { message: 'the notice’s PDF is frozen and its link opens', timeout: 60_000 },
    )
    .toBe(true);
  return path;
}

test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
  testInfo.setTimeout(180_000);
  staff = await managerApi();
  lease = await leaseDueToday(staff, 'Kojo Notice-Reader (e2e)', 120_000);
  signed = await issueEntryNotice(staff, lease.leaseId);
  expect(signed.number).toMatch(/^N-\d{6}$/);
  signedPath = await noticeLinkPath(staff, signed);
});

test.afterAll(async () => {
  await staff?.dispose();
});

test.describe('LN-04 a notice’s signing page', () => {
  test('NFR-PERF the notice page transfers under 1 MB and fits a 5-inch screen', async ({
    page,
  }, testInfo) => {
    const transfers: Promise<number>[] = [];
    page.on('requestfinished', (request) => {
      transfers.push(
        request.sizes().then((sizes) => sizes.responseHeadersSize + sizes.responseBodySize),
      );
    });
    const response = await page.goto(signedPath, { waitUntil: 'networkidle' });
    expect(response?.headers()['cache-control']).toBe('no-store');
    const headers = response ? await response.headersArray() : [];
    expect(headerValues(headers, 'set-cookie')).toEqual([]);
    const all = await Promise.all(transfers);
    const transferred = all.reduce((total, bytes) => total + bytes, 0);
    testInfo.annotations.push({
      type: 'page weight',
      description: `notice page: ${all.length} requests, ${transferred} bytes transferred`,
    });
    expect(transferred).toBeLessThan(ONE_MB);
    expect(page.viewportSize()).toEqual({ width: 360, height: 640 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('shows the statement above the signature box, offers no decline, and signs with a one-time code', async ({
    page,
    request,
  }) => {
    await page.goto(signedPath);
    await expect(
      page.getByRole('heading', {
        name: `Notice ${signed.number}: Notice of entry`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Acknowledge receipt', exact: true }),
    ).toBeVisible();
    // The frozen notice itself also carries the statement; this is the page's own, in the
    // signature box, above the code and the signature.
    const signatureBox = page.locator('section#sign');
    await expect(signatureBox.getByText(NOTICE_SIGNING_STATEMENT)).toBeVisible();
    await expect(page.getByText('I do not want to sign')).toHaveCount(0);
    expect(await page.content()).not.toContain('/decline');

    // Not even when the address asks for the decline step, or a form is posted to it.
    await page.goto(`${signedPath}?step=decline#sign`);
    await expect(page.locator('textarea[name="reason"]')).toHaveCount(0);
    const posted = await request.post(`${signedPath}/decline`, {
      form: { reason: 'I do not agree' },
      maxRedirects: 0,
    });
    expect(posted.status()).toBe(303);
    await page.goto(signedPath);
    await expect(
      page.getByRole('heading', { name: 'Acknowledge receipt', exact: true }),
    ).toBeVisible();

    // The one-time code goes to the phone on record (CLAUDE.md section 9).
    const started = Date.now();
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await page.getByLabel('Your 6-digit code').fill(await codeTextedTo(lease.tenantPhone, started));
    await page.getByLabel('Type your full name to sign').fill('Kojo Notice-Reader');
    await page.getByRole('checkbox').check();
    await expect(page.getByRole('checkbox')).toBeChecked();
    await page.getByRole('button', { name: 'Sign to acknowledge receipt' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Thank you: you have acknowledged receipt',
    );
    await expect(
      page.getByText('This confirms that you received it, not that you agree with it.'),
    ).toBeVisible();

    await expect
      .poll(
        async () =>
          (await ok<NoticeDetail>(await staff.get(`/notices/${signed.id}`), 'the notice'))
            .recipients[0]!.signedAt,
      )
      .not.toBeNull();
  });
});

test.describe('LN-02 a notice cannot be declined (M7 review, LT 5)', () => {
  test('the links API itself refuses a decline with 409, and the notice stays out for acknowledgement', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const notice = await issueEntryNotice(staff, lease.leaseId);
    const path = await noticeLinkPath(staff, notice);
    const token = path.slice('/l/'.length);
    const answer = await fetch(`${API}/links/decline`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [LINKS_API_KEY_HEADER]: process.env.LINKS_API_KEY ?? DEV_LINKS_API_KEY,
      },
      body: JSON.stringify({
        token,
        client: { ip: '203.0.113.7', userAgent: 'notice-signing e2e' },
        reason: 'I do not agree with this notice',
      }),
    });
    expect(answer.status).toBe(409);

    const after = await ok<NoticeDetail>(await staff.get(`/notices/${notice.id}`), 'the notice');
    expect(after.recipients[0]!.signedAt).toBeNull();
    await page.goto(path);
    await expect(
      page.getByRole('heading', { name: 'Acknowledge receipt', exact: true }),
    ).toBeVisible();
  });
});

test.describe('LN-02 a corrected notice’s link (plan 4.8)', () => {
  test('opens read-only, with a banner naming the new notice, and its PDF still downloads', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const original = await issueEntryNotice(staff, lease.leaseId);
    const originalPath = await noticeLinkPath(staff, original);
    const correction = await ok<NoticeDetail>(
      await staff.post(`/notices/${original.id}/correct`, { data: {} }),
      'start the correction',
    );
    const replacement = await ok<NoticeDetail>(
      await staff.post(`/notices/${correction.id}/issue`, { data: {} }),
      'issue the correction',
    );
    expect(replacement.number).toMatch(/^N-\d{6}$/);

    await page.goto(originalPath);
    await expect(
      page.getByRole('heading', {
        name: `Notice ${original.number}: Notice of entry`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: 'This notice has been replaced' }),
    ).toHaveText(new RegExp(`This notice has been replaced by notice ${replacement.number}\\.`));
    await expect(page.locator('form')).toHaveCount(0);
    await expect(page.getByText('I do not want to sign')).toHaveCount(0);
    const download = page.getByRole('link', { name: 'Download the notice (PDF)' });
    await expect(download).toBeVisible();
    const pdf = await page.request.get(`${originalPath}/document`, { maxRedirects: 0 });
    expect(pdf.status()).toBe(303);
  });
});
