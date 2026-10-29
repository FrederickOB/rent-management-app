import { expect, test } from '@playwright/test';
import { fakeToken } from './support';

// CLAUDE.md section 9: secure pages stay under 1 MB and work on 3G and a 5-inch screen.
const ONE_MB = 1_000_000;
const PAGES: [name: string, path: string][] = [
  ['the home page', '/'],
  ['a link page', `/l/${fakeToken()}`],
];

test.describe('NFR-PERF links page weight', () => {
  for (const [name, path] of PAGES) {
    test(`${name} transfers under 1 MB`, async ({ page }, testInfo) => {
      const transfers: Promise<{ transferred: number; decoded: number }>[] = [];
      page.on('requestfinished', (request) => {
        transfers.push(
          (async () => {
            const sizes = await request.sizes();
            const body = await (await request.response())?.body();
            return {
              transferred: sizes.responseHeadersSize + sizes.responseBodySize,
              decoded: body?.length ?? 0,
            };
          })(),
        );
      });
      await page.goto(path, { waitUntil: 'networkidle' });

      const all = await Promise.all(transfers);
      const transferred = all.reduce((total, t) => total + t.transferred, 0);
      const decoded = all.reduce((total, t) => total + t.decoded, 0);
      testInfo.annotations.push({
        type: 'page weight',
        description: `${path}: ${all.length} requests, ${transferred} bytes transferred, ${decoded} bytes decoded`,
      });
      expect(all.length).toBeGreaterThan(1);
      expect(transferred).toBeLessThan(ONE_MB);
    });
  }

  test('pages fit a 5-inch screen without sideways scrolling', async ({ page }) => {
    expect(page.viewportSize()).toEqual({ width: 360, height: 640 });
    for (const [, path] of PAGES) {
      await page.goto(path);
      const heading = page.getByRole('heading', { level: 1 });
      await expect(heading).toBeVisible();
      await expect(heading).toBeInViewport();
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        fontSize: getComputedStyle(document.body).fontSize,
      }));
      expect(layout.overflow, path).toBeLessThanOrEqual(0);
      expect(layout.fontSize, path).toBe('17px');
    }
  });
});
