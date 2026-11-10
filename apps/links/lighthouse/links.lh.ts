import { test, type APIRequestContext } from '@playwright/test';
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

test('NFR-PERF BC-04 BC-06 TL-07 LN-04 MI-04 CM-09 every links page on a first visit over 3G', async () => {
  const pay = await payLink(staff, 'Akua Measures-Links (e2e)');
  const pages: [name: string, path: string][] = [
    ['home', '/'],
    ['pay', pay.path],
    ['lease signing', await leaseSigningLink(staff)],
    ['notice', await noticeLink(staff)],
    ['job sheet', await jobSheetLink(staff)],
    ['unsubscribe', await unsubscribeLink(staff)],
    ['not found', `/l/${'x'.repeat(43)}`],
  ];
  const measured: Measured[] = [];
  for (const [name, path] of pages)
    measured.push(
      await measure(browser, {
        group: 'links',
        name,
        url: `${LINKS_URL}${path}`,
        firstVisit: true,
        keepStorage: false,
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
    }),
  );
  record(measured);
});
