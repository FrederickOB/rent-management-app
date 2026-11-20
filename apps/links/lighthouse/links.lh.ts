import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  jobSheetLink,
  leaseSigningLink,
  noticeLink,
  payByMomo,
  payLink,
  unsubscribeLink,
} from '../e2e/page-fixtures';
import { managerApi } from '../e2e/signing-support';
import {
  LINKS_URL,
  measure,
  openBrowser,
  record,
  type Expected,
  type Measured,
  type MeasuringBrowser,
} from './collect';

// NFR-PERF (M11 decision 8): every links page, on a first visit over 3G with a slow CPU, under
// 1 MB, with its largest paint under 3 s and its layout settled (shift under 0.1). Most tenants
// land on these pages from WhatsApp or SMS, so the first visit is the one that counts. The
// budgets are asserted by `lhci assert` (run.mjs, links.lighthouserc.json).
test.describe.configure({ mode: 'serial' });

let staff: APIRequestContext;
let browser: MeasuringBrowser;

test.beforeAll(async () => {
  staff = await managerApi();
  browser = await openBrowser(LINKS_URL);
});

test.afterAll(async () => {
  await browser?.close();
  await staff?.dispose();
});

/** A page whose main heading says `text`. */
const headed =
  (text: string | RegExp): Expected['marker'] =>
  async (page: Page) => {
    // The page's own heading comes first (a notice's document has one of its own).
    await expect(page.getByRole('heading', { level: 1 }).first()).toHaveText(text);
  };

/** A link page that offers its action: still open, neither used nor replaced. */
const offering =
  (heading: string | RegExp, action: RegExp): Expected['marker'] =>
  async (page: Page) => {
    await headed(heading)(page);
    await expect(page.getByRole('button', { name: action }).first()).toBeVisible();
  };

test('NFR-PERF BC-04 BC-06 TL-07 LN-04 MI-04 CM-09 every links page on a first visit over 3G', async () => {
  const pay = await payLink(staff, 'Akua Measures-Links (e2e)');
  const pages: [name: string, path: string, expected: Expected][] = [
    ['home', '/', { marker: headed('This page opens from a link we sent you') }],
    ['pay', pay.path, { marker: offering(/^Pay rent to /, /^Pay$/) }],
    [
      'lease signing',
      await leaseSigningLink(staff),
      { marker: offering(/./, /send me a code|send a new code/i) },
    ],
    [
      'notice',
      await noticeLink(staff),
      { marker: offering(/./, /send me a code|send a new code/i) },
    ],
    ['job sheet', await jobSheetLink(staff), { marker: offering(/./, /^Accept the job$/) }],
    [
      'unsubscribe',
      await unsubscribeLink(staff),
      { marker: offering(/^Stop emails from /, /stop emails/i) },
    ],
    [
      'not found',
      `/l/${'x'.repeat(43)}`,
      { marker: headed('This link is not valid or has expired'), status: 404 },
    ],
  ];
  const measured: Measured[] = [];
  for (const [name, path, expected] of pages)
    measured.push(
      await measure(browser, {
        group: 'links',
        name,
        url: `${LINKS_URL}${path}`,
        firstVisit: true,
        keepStorage: false,
        expect: expected,
      }),
    );

  // The receipt page, from the receipt SMS once the tenant has paid.
  const receipt = await payByMomo(await browser.page(), pay);
  measured.push(
    await measure(browser, {
      group: 'links',
      name: 'receipt',
      url: `${LINKS_URL}${receipt}`,
      firstVisit: true,
      keepStorage: false,
      expect: { marker: headed('Your receipt') },
    }),
  );
  record(measured);
});
