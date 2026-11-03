import { createHash } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  codeEmailedTo,
  codeTextedTo,
  handoverPath,
  issuedLease,
  MANAGER,
  managerApi,
  newProperty,
  ok,
  pathOf,
  smsTo,
  waitForSms,
  type IssuedLease,
} from './signing-support';
import { headerValues, nonceOf, policyShape } from './support';

// CLAUDE.md section 9 and M3 plan 4.8: the signing page stays under 1 MB, works on a 5-inch
// screen over 3G, sets no cookie and runs under a strict, nonce-based policy.
const ONE_MB = 1_000_000;
const STRICT_POLICY = {
  'default-src': ["'none'"],
  'script-src': ["'self'", "'nonce-NONCE'", "'strict-dynamic'"],
  'style-src': ["'self'", "'nonce-NONCE'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};
/** WebPageTest's 3G profile: 1.6 Mbps down, 768 kbps up, 300 ms round trips (bytes a second). */
const THREE_G = {
  offline: false,
  latency: 300,
  downloadThroughput: 209_715,
  uploadThroughput: 98_304,
};

let api: APIRequestContext;
let units: { id: string; code: string }[];
let lease: IssuedLease;
let tenantPath: string;

/** Bytes a page and everything it loads take over the network, and the scripts it loaded. */
function meter(page: Page) {
  const transfers: Promise<number>[] = [];
  const scripts = new Set<string>();
  page.on('requestfinished', (request) => {
    if (request.resourceType() === 'script') scripts.add(new URL(request.url()).pathname);
    transfers.push(
      request.sizes().then((sizes) => sizes.responseHeadersSize + sizes.responseBodySize),
    );
  });
  return {
    scripts,
    total: async () => (await Promise.all(transfers)).reduce((sum, n) => sum + n, 0),
  };
}

async function throttle(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', THREE_G);
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function sendCode(page: Page) {
  await page
    .getByRole('button', { name: /send me a code|send a new code/i })
    .first()
    .click();
  await expect(page.getByLabel('Your 6-digit code')).toBeVisible();
}

async function signTyped(page: Page, code: string, name: string) {
  await page.getByLabel('Your 6-digit code').fill(code);
  await page.getByLabel('Type your full name to sign').fill(name);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await managerApi();
  units = await newProperty(api, 2);
  lease = await issuedLease(api, units[0]!.id, 'Ama Signer (e2e)');
  tenantPath = pathOf(await waitForSms(lease.tenantPhone, /\/l\//));
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe('TL-07 signing page', () => {
  test('transfers under 1 MB and works on a 5-inch screen over a throttled 3G connection', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    expect(page.viewportSize()).toEqual({ width: 360, height: 640 });
    await throttle(page);

    const first = meter(page);
    const started = Date.now();
    await page.goto(tenantPath, { waitUntil: 'load' });
    const loadedIn = Date.now() - started;
    await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
    await expect(page.getByRole('link', { name: 'Download the PDF' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const firstBytes = await first.total();
    expect(firstBytes).toBeLessThan(ONE_MB);
    expect(loadedIn).toBeLessThan(15_000);
    await noSidewaysScroll(page);

    // The signing step, then the drawing step: the drawing script loads only there.
    await sendCode(page);
    await page.waitForLoadState('networkidle');
    const beforeDrawing = new Set(first.scripts);
    const drawing = meter(page);
    await page.getByRole('link', { name: 'Draw your signature instead' }).click();
    await expect(page.getByText('Sign with your finger or mouse.')).toBeVisible();
    await page.waitForLoadState('networkidle');
    const drawBytes = await drawing.total();
    expect(drawBytes).toBeLessThan(ONE_MB);
    expect([...drawing.scripts].filter((s) => !beforeDrawing.has(s)).length).toBeGreaterThan(0);
    await noSidewaysScroll(page);
    testInfo.annotations.push({
      type: 'page weight',
      description: `signing page ${firstBytes} bytes in ${loadedIn} ms on 3G; drawing step ${drawBytes} bytes`,
    });
  });

  test('sets no cookie and sends a strict nonce policy, no-referrer and no-store', async ({
    page,
    request,
  }) => {
    for (const path of [tenantPath, `${tenantPath}?draw=1`]) {
      const response = await request.get(path, { headers: { cookie: 'session=elsewhere' } });
      expect(response.status(), path).toBe(200);
      const headers = response.headersArray();
      expect(headerValues(headers, 'set-cookie'), path).toEqual([]);
      const [policy = ''] = headerValues(headers, 'content-security-policy');
      expect(policyShape(policy), path).toEqual(STRICT_POLICY);
      expect(headerValues(headers, 'referrer-policy')).toEqual(['no-referrer']);
      expect(headerValues(headers, 'cache-control').join(', ')).toContain('no-store');
    }
    // A form post answers with a redirect that carries no cookie and is not stored either.
    const posted = await request.post(`${tenantPath}/code`, { maxRedirects: 0 });
    expect(posted.status()).toBe(303);
    expect(headerValues(posted.headersArray(), 'set-cookie')).toEqual([]);
    expect(posted.headers()['cache-control']).toContain('no-store');

    // In the browser: every script and style carries the nonce, and nothing breaks the policy.
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/content security policy/i.test(message.text())) violations.push(message.text());
    });
    page.on('pageerror', (error) => violations.push(error.message));
    const response = await page.goto(tenantPath);
    const nonce = nonceOf((await response!.allHeaders())['content-security-policy'] ?? '');
    for (const tag of (await response!.text()).match(/<(script|style)\b[^>]*>/g) ?? [])
      expect(tag).toContain(`nonce="${nonce}"`);
    await expect.poll(() => page.evaluate(() => 'next' in window)).toBe(true);
    // The page's own forms post to its URL, but the token is never shown.
    expect(await page.locator('body').innerText()).not.toContain(tenantPath.slice(3));
    expect(await page.title()).not.toContain(tenantPath.slice(3));
    await page.goto(`${tenantPath}?draw=1#sign`);
    await expect(page.getByText('Sign with your finger or mouse.')).toBeVisible();
    expect(violations).toEqual([]);
    expect(await page.context().cookies()).toEqual([]);
  });
});

test.describe('TL-07 lease does not activate with a missing signature', () => {
  test('the tenant signs with a code; the lease waits for the others', async ({ page }) => {
    const started = Date.now();
    await page.goto(tenantPath);
    if (await page.getByRole('button', { name: 'Send me a code' }).isVisible())
      await sendCode(page);
    else await page.getByRole('button', { name: 'Send a new code' }).click();
    const code = await codeTextedTo(lease.tenantPhone, started);
    await signTyped(page, code, 'Ama Signer');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you: you have signed');

    const view = await ok<{ status: string; signing: { signedDocument: boolean } }>(
      await api.get(`/leases/${lease.leaseId}`),
      'the lease',
    );
    expect(view.status).toBe('pending_signatures');
    expect(view.signing.signedDocument).toBe(false);
    const progress = await ok<{
      status: string;
      signedDocument: boolean;
      signers: { role: string; status: string }[];
    }>(await api.get(`/leases/${lease.leaseId}/signing`), 'progress');
    expect(progress.status).toBe('pending');
    expect(progress.signedDocument).toBe(false);
    expect(Object.fromEntries(progress.signers.map((s) => [s.role, s.status]))).toEqual({
      tenant: 'signed',
      landlord: 'pending',
      witness: 'pending',
    });
  });
});

test.describe('TL-07 expired or reused signing link is rejected', () => {
  test('a used link explains what happened and accepts no action', async ({ page, request }) => {
    await page.goto(tenantPath);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('You have already signed');
    await expect(page.locator('form')).toHaveCount(0);
    await expect(page.getByRole('button')).toHaveCount(0);
    await expect(page.getByText(`Contact`)).toBeVisible();
    // Posting a complete, valid form anyway changes nothing and sends no code.
    const before = (await smsTo(lease.tenantPhone)).length;
    for (const action of ['code', 'sign', 'decline']) {
      const response = await request.post(`${tenantPath}/${action}`, {
        form: {
          code: '123456',
          method: 'typed',
          typedName: 'Ama Signer',
          consentVersion: 'consent.v1',
          consent: 'yes',
          reason: 'Changed my mind',
        },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(303);
      expect(response.headers()['location']).toContain('error=LINK_NOT_USABLE');
    }
    expect((await smsTo(lease.tenantPhone)).length).toBe(before);
  });

  test('a replaced link explains what happened, with the landlord’s contact', async ({ page }) => {
    const replaced = await handoverPath(api, lease, 'witness');
    await handoverPath(api, lease, 'witness');
    await page.goto(replaced);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This link has been replaced');
    await expect(page.getByText(`: ${MANAGER.name}`)).toBeVisible();
    await expect(page.getByRole('link', { name: MANAGER.email })).toHaveAttribute(
      'href',
      `mailto:${MANAGER.email}`,
    );
    await expect(page.locator('form')).toHaveCount(0);
  });

  test('an unknown link is not found and says nothing about any document', async ({ page }) => {
    const response = await page.goto(`/l/${'Q'.repeat(43)}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'This link is not valid or has expired',
    );
  });
});

test.describe('TL-07 signing engine', () => {
  test('the witness draws a signature, the landlord signs, and every party gets the signed copy', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // The witness, with no consent on record, signs by drawing through a hand-over link.
    let started = Date.now();
    const witnessPath = await handoverPath(api, lease, 'witness');
    await page.goto(witnessPath);
    await sendCode(page);
    const witnessCode = await codeTextedTo(lease.witnessPhone, started);
    await page.getByRole('link', { name: 'Draw your signature instead' }).click();
    await expect(page.getByText('Sign with your finger or mouse.')).toBeVisible();
    const box = (await page.locator('canvas#pad').boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 3, box.y + 20, { steps: 8 });
    await page.mouse.move(box.x + (2 * box.width) / 3, box.y + box.height - 20, { steps: 8 });
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 3, { steps: 8 });
    await page.mouse.up();
    await page.getByLabel('Your 6-digit code').fill(witnessCode);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you: you have signed');
    expect(
      (await ok<{ status: string }>(await api.get(`/leases/${lease.leaseId}`), 'lease')).status,
    ).toBe('pending_signatures');

    // The landlord's signer gets codes by email, the only address on record for them.
    started = Date.now();
    const landlordPath = await handoverPath(api, lease, 'landlord');
    await page.goto(landlordPath);
    await sendCode(page);
    await signTyped(page, await codeEmailedTo(MANAGER.email, started), MANAGER.name);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you: you have signed');

    // The worker finalises: the lease is signed, and each party is sent their copy.
    await expect
      .poll(
        async () =>
          (await ok<{ status: string }>(await api.get(`/leases/${lease.leaseId}`), 'lease')).status,
        { message: 'the worker finalises and the lease is signed', timeout: 60_000 },
      )
      .toBe('signed');
    const copyPath = pathOf(await waitForSms(lease.tenantPhone, /signed copy at .*\/l\//));
    await page.goto(copyPath);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your signed copy is ready');
    const progress = await ok<{ finalSha256: string; documentSha256: string }>(
      await api.get(`/leases/${lease.leaseId}/signing`),
      'progress',
    );
    await expect(page.getByText(progress.finalSha256)).toBeVisible();
    const download = await page.request.get(`${copyPath}/document`);
    expect(download.status()).toBe(200);
    const bytes = await download.body();
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(progress.finalSha256);
    // The witness's copy went nowhere (no consent): staff hand it over, as with the link.
    expect((await smsTo(lease.witnessPhone)).some((m) => /signed copy/.test(m.body))).toBe(false);
  });

  test('declining returns the lease to draft', async ({ page }) => {
    const second = await issuedLease(api, units[1]!.id, 'Kojo Decliner (e2e)');
    const path = pathOf(await waitForSms(second.tenantPhone, /\/l\//));
    await page.goto(path);
    await page.getByRole('link', { name: 'I do not want to sign' }).click();
    await page.getByLabel('Why are you declining?').fill('The rent is higher than we agreed');
    await page.getByRole('button', { name: 'Decline to sign' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('You declined to sign');
    await expect
      .poll(
        async () =>
          (await ok<{ status: string }>(await api.get(`/leases/${second.leaseId}`), 'lease'))
            .status,
        { message: 'the lease goes back to draft', timeout: 30_000 },
      )
      .toBe('draft');
    const progress = await ok<{ status: string; declineReason: string }>(
      await api.get(`/leases/${second.leaseId}/signing`),
      'progress',
    );
    expect(progress).toMatchObject({
      status: 'declined',
      declineReason: 'The rent is higher than we agreed',
    });
  });
});
