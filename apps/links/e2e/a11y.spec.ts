import { expect, test, type APIRequestContext } from '@playwright/test';
import { expectAccessible } from './a11y-support';
import {
  jobSheetLink,
  leaseSigningLink,
  noticeLink,
  payByMomo,
  payLink,
  unsubscribeLink,
  type PayLink,
} from './page-fixtures';
import { managerApi } from './signing-support';
import { fakeToken } from './support';

// NFR-A11Y (M11 plan 4.9): axe's WCAG 2.2 A and AA rules on every links page, in its main states,
// on a 5-inch screen. A serious or critical violation fails. Each page is made through the API
// as staff make it (page-fixtures.ts). Needs pnpm db:seed and the running stack.
test.describe.configure({ mode: 'serial' });

let staff: APIRequestContext;
let pay: PayLink;

test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
  testInfo.setTimeout(120_000);
  staff = await managerApi();
  pay = await payLink(staff, 'Abla Checks-Pages (e2e)');
});

test.afterAll(async () => {
  await staff?.dispose();
});

test.describe('NFR-A11Y links pages, WCAG 2.2 A and AA', () => {
  test('the home page and a link that is not valid', async ({ page }, testInfo) => {
    await page.goto('/');
    await expectAccessible(page, testInfo, 'home');
    await page.goto(`/l/${fakeToken()}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page, testInfo, 'not found');
    await page.goto(`/p/return?reference=pi-${'0'.repeat(32)}`);
    await expectAccessible(page, testInfo, 'card return, unknown reference');
  });

  test('BC-04 BC-06 the pay page: the form, a refused amount, waiting for MoMo, paid, and the receipt', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await page.goto(pay.path);
    await expect(page.getByLabel('Amount to pay (GH₵)')).toBeVisible();
    await expectAccessible(page, testInfo, 'pay: the form');

    await page.getByLabel('Amount to pay (GH₵)').fill('nonsense');
    await page.getByLabel('MTN MoMo', { exact: true }).check();
    await page.getByLabel('MoMo number to charge').fill(`0${pay.lease.tenantPhone.slice(4)}`);
    await page.getByRole('button', { name: 'Pay', exact: true }).click();
    await expect(page.locator('main').getByRole('alert')).toBeVisible();
    await expectAccessible(page, testInfo, 'pay: a refused amount');

    // Waiting for the MoMo prompt, then paid, then the receipt from the SMS.
    const receipt = await payByMomo(page, pay);
    await expectAccessible(page, testInfo, 'pay: paid');
    await page.goto(receipt);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your receipt');
    await expectAccessible(page, testInfo, 'receipt');
  });

  test('TL-07 the lease signing page: before and after the code is sent, and declining', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const path = await leaseSigningLink(staff);
    await page.goto(path);
    await expectAccessible(page, testInfo, 'lease signing');
    await page
      .getByRole('button', { name: /send me a code|send a new code/i })
      .first()
      .click();
    await expect(page.getByLabel('Your 6-digit code')).toBeVisible();
    await expectAccessible(page, testInfo, 'lease signing: the code sent');
    await page.getByRole('link', { name: 'Draw your signature instead' }).click();
    await expectAccessible(page, testInfo, 'lease signing: drawing');
    await page.goto(path);
    await page.getByRole('link', { name: 'I do not want to sign' }).click();
    await expect(page.getByLabel('Why are you declining?')).toBeVisible();
    await expectAccessible(page, testInfo, 'lease signing: declining');
  });

  test('LN-04 the notice page: before and after the code is sent', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.goto(await noticeLink(staff));
    await expectAccessible(page, testInfo, 'notice');
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await expect(page.getByLabel('Your 6-digit code')).toBeVisible();
    await expectAccessible(page, testInfo, 'notice: the code sent');
  });

  test('MI-04 the job sheet: answering, declining, starting, and a refusal', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const path = await jobSheetLink(staff);
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Can you do this job?' })).toBeVisible();
    await expectAccessible(page, testInfo, 'job sheet: can you do it');
    await page.getByRole('link', { name: 'I cannot take this job' }).click();
    await expectAccessible(page, testInfo, 'job sheet: declining');
    await page.goto(path);
    await page.getByRole('button', { name: 'Accept the job' }).click();
    await expect(page.getByRole('heading', { name: 'Start the work' })).toBeVisible();
    await expectAccessible(page, testInfo, 'job sheet: start the work');
    await page.getByRole('button', { name: 'Start the work' }).click();
    await expect(page.locator('main').getByRole('alert')).toBeVisible();
    await expectAccessible(page, testInfo, 'job sheet: a refusal');
  });

  test('CM-09 the unsubscribe page: asking, and done', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.goto(await unsubscribeLink(staff));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Stop emails from /);
    await expectAccessible(page, testInfo, 'unsubscribe');
    await page.getByRole('button').first().click();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/^Stop emails from /);
    await expectAccessible(page, testInfo, 'unsubscribe: done');
  });
});
