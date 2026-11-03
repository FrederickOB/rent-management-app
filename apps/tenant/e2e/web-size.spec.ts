import { expect, test } from '@playwright/test';

// The size budget (M4b plan 4.13 and step 10; CLAUDE.md section 9): the Expo web build's first
// load stays under 1 MB. A production host sends it compressed, which the test server CI uses
// (scripts/serve-spa.mjs) does not, so each response is gzipped here, as a host would send it, and
// the bytes counted with their headers. The raw size is reported beside it.
const ONE_MB = 1_000_000;

async function gzipped(body: Uint8Array<ArrayBuffer>): Promise<number> {
  const stream = new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

test.describe('NFR-PERF size budgets: the Expo web first load', () => {
  test('the first screen loads under 1 MB, compressed as a host sends it', async ({
    page,
  }, testInfo) => {
    const sizes: Promise<{ raw: number; sent: number; headers: number }>[] = [];
    page.on('requestfinished', (request) => {
      sizes.push(
        (async () => {
          const response = await request.response();
          const body = new Uint8Array(response ? await response.body() : new ArrayBuffer(0));
          const { responseHeadersSize } = await request.sizes();
          return { raw: body.byteLength, sent: await gzipped(body), headers: responseHeadersSize };
        })(),
      );
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('phone-input')).toBeVisible();
    await page.waitForLoadState('networkidle');

    const all = await Promise.all(sizes);
    const raw = all.reduce((total, s) => total + s.raw, 0);
    const sent = all.reduce((total, s) => total + s.sent + s.headers, 0);
    testInfo.annotations.push({
      type: 'page weight',
      description: `Expo web first load: ${all.length} requests, ${sent} bytes compressed with headers, ${raw} bytes uncompressed`,
    });
    expect(all.length).toBeGreaterThan(1);
    expect(sent).toBeLessThan(ONE_MB);
  });
});
