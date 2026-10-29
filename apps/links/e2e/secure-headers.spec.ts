import { expect, test } from '@playwright/test';
import { fakeToken, headerValues, nonceOf, policyShape } from './support';

const token = fakeToken();
const PAGES = ['/', `/l/${token}`];
const ROUTES = [...PAGES, '/health', '/no-such-page'];

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

test.describe('NFR-SEC secure headers: links', () => {
  test('every response carries the strict policy with a nonce of its own', async ({ request }) => {
    const nonces: string[] = [];
    for (const path of [...ROUTES, ...ROUTES]) {
      const response = await request.get(path);
      const policies = headerValues(response.headersArray(), 'content-security-policy');
      expect(policies, path).toHaveLength(1);
      const [policy = ''] = policies;
      expect(policyShape(policy), path).toEqual(STRICT_POLICY);
      nonces.push(nonceOf(policy));
    }
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  test("the page's scripts and styles carry its nonce and run under the policy", async ({
    page,
  }) => {
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/content security policy/i.test(message.text())) violations.push(message.text());
    });
    page.on('pageerror', (error) => violations.push(error.message));

    for (const path of PAGES) {
      const response = await page.goto(path);
      if (!response) throw new Error(`no response for ${path}`);
      const nonce = nonceOf((await response.allHeaders())['content-security-policy'] ?? '');
      const tags = (await response.text()).match(/<(script|style)\b[^>]*>/g) ?? [];
      expect(tags.length, path).toBeGreaterThan(1);
      for (const tag of tags) expect(tag, path).toContain(`nonce="${nonce}"`);

      // The App Router runtime sets window.next once its scripts have run, and the inline
      // stylesheet sets the column width: both prove the policy let them through.
      await expect.poll(() => page.evaluate(() => 'next' in window)).toBe(true);
      expect(await page.locator('main').evaluate((main) => getComputedStyle(main).maxWidth)).toBe(
        '576px',
      );
    }
    expect(violations).toEqual([]);
  });

  test('never sets a cookie, even when the request sends some', async ({
    page,
    request,
    baseURL,
  }) => {
    for (const path of ROUTES) {
      const response = await request.get(path, {
        headers: { cookie: 'session=from-another-site; __Host-staff=1' },
      });
      expect(headerValues(response.headersArray(), 'set-cookie'), path).toEqual([]);
    }

    // In the browser too, for the page and everything it loads.
    await page
      .context()
      .addCookies([{ name: 'session', value: 'from-elsewhere', url: baseURL ?? '' }]);
    const pending: Promise<string[]>[] = [];
    page.on('response', (response) => {
      pending.push(response.headersArray().then((headers) => headerValues(headers, 'set-cookie')));
    });
    for (const path of PAGES) await page.goto(path, { waitUntil: 'networkidle' });
    expect(pending.length).toBeGreaterThan(PAGES.length);
    expect((await Promise.all(pending)).flat()).toEqual([]);
    expect((await page.context().cookies()).map((cookie) => cookie.name)).toEqual(['session']);
  });

  test('pages, routes and static files send the other security headers', async ({ request }) => {
    const home = await request.get('/');
    const asset = /<script[^>]+src="(\/_next\/static\/[^"]+)"/.exec(await home.text())?.[1];
    expect(asset).toBeDefined();

    for (const path of [...ROUTES, asset ?? '']) {
      const headers = (await request.get(path)).headersArray();
      const value = (name: string) => headerValues(headers, name).join(', ');
      expect(value('content-security-policy'), path).toContain("default-src 'none'");
      expect(value('referrer-policy'), path).toBe('no-referrer');
      expect(value('x-content-type-options'), path).toBe('nosniff');
      expect(value('permissions-policy'), path).toBe('camera=(), microphone=(), geolocation=()');
      expect(value('x-frame-options'), path).toBe('DENY');
      expect(value('x-robots-tag'), path).toBe('noindex, nofollow');
      expect(value('x-powered-by'), path).toBe('');
    }
  });

  test('a link page never shows its token', async ({ page }) => {
    const response = await page.goto(`/l/${token}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'This link is not valid or has expired',
    );
    await expect(page.getByText(/contact your landlord/i)).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain(token);
    expect(await page.title()).not.toContain(token);
  });
});

test.describe('PLATFORM links health', () => {
  test('the health route answers without caching', async ({ request }) => {
    const response = await request.get('/health');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers()['cache-control']).toBe('no-store');
  });
});
