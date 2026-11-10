import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectAccessible } from './a11y-support';
import { largePng, smsSince } from './job-sheet-support';
import {
  jobSheetFor,
  leaseSigningFor,
  noticeFor,
  payByMomo,
  payLink,
  unsubscribeLink,
  type PayLink,
} from './page-fixtures';
import { codeTextedTo, managerApi } from './signing-support';
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

/** The heading of the page now shown, once it has arrived. */
const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const otherCode = (code: string) => (code === '000000' ? '111111' : '000000');

test.describe('NFR-A11Y links pages, WCAG 2.2 A and AA', () => {
  test('the home page and a link that is not valid', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(heading(page)).toHaveText('This page opens from a link we sent you');
    await expectAccessible(page, testInfo, 'home');
    await page.goto(`/l/${fakeToken()}`);
    await expect(heading(page)).toHaveText('This link is not valid or has expired');
    await expectAccessible(page, testInfo, 'not found');
    await page.goto(`/p/return?reference=pi-${'0'.repeat(32)}`);
    await expect(heading(page)).toBeVisible();
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

    // Waiting for the MoMo prompt (the page checks again by itself), then paid.
    const receipt = await payByMomo(page, pay, () =>
      expectAccessible(page, testInfo, 'pay: waiting for MoMo'),
    );
    await expectAccessible(page, testInfo, 'pay: paid');

    // The receipt from the SMS: while its PDF is made, if it still is, and once it is ready.
    await page.goto(receipt);
    await expect(heading(page)).toHaveText('Your receipt');
    if (await page.getByText('The PDF is being prepared.').isVisible())
      await expectAccessible(page, testInfo, 'receipt: the PDF being prepared');
    await expect(page.getByRole('link', { name: 'Download the receipt (PDF)' })).toBeVisible({
      timeout: 60_000,
    });
    await expectAccessible(page, testInfo, 'receipt');
  });

  test('BC-04 the card return page while the payment is confirmed', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const card = await payLink(staff, 'Efua Pays-By-Card (e2e)');
    await page.goto(card.path);
    await page.getByLabel('Card', { exact: true }).check();
    await page.getByRole('button', { name: 'Pay', exact: true }).click();
    await expect(heading(page)).toHaveText('Continue to the card payment page');
    await expectAccessible(page, testInfo, 'pay: continue to the card payment page');
    await page.getByRole('link', { name: /^Continue to pay / }).click();
    // The fake provider's checkout: its reference, and no payment yet.
    await expect(page.getByRole('heading', { name: 'Fake checkout' })).toBeVisible();
    const reference = await page.locator('tr', { hasText: 'Reference' }).locator('td').innerText();
    await page.goto(`/p/return?reference=${reference}`);
    await expect(heading(page)).toHaveText('We are confirming your payment');
    await expect(page.getByText(/^This page checks again every \d+ seconds\.$/)).toBeVisible();
    await expectAccessible(page, testInfo, 'card return: confirming');
  });

  test('TL-07 the lease signing page: the code, a wrong code, drawing, declining and signed', async ({
    page,
  }, testInfo) => {
    test.setTimeout(150_000);
    const lease = await leaseSigningFor(staff);
    await page.goto(lease.path);
    await expect(heading(page)).toBeVisible();
    await expectAccessible(page, testInfo, 'lease signing');
    const asked = Date.now();
    await page
      .getByRole('button', { name: /send me a code|send a new code/i })
      .first()
      .click();
    await expect(page.getByLabel('Your 6-digit code')).toBeVisible();
    await expectAccessible(page, testInfo, 'lease signing: the code sent');
    const code = await codeTextedTo(lease.phone, asked);

    await page.getByRole('link', { name: 'Draw your signature instead' }).click();
    await expect(page.getByText('Sign with your finger or mouse.')).toBeVisible();
    await expectAccessible(page, testInfo, 'lease signing: drawing');

    await page.goto(lease.path);
    await page.getByRole('link', { name: 'I do not want to sign' }).click();
    await expect(page.getByLabel('Why are you declining?')).toBeVisible();
    await expectAccessible(page, testInfo, 'lease signing: declining');

    await page.goto(lease.path);
    await page.getByLabel('Your 6-digit code').fill(otherCode(code));
    await page.getByLabel('Type your full name to sign').fill('Ama Signs-Lease');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect(page.locator('main').getByRole('alert')).toBeVisible();
    await expectAccessible(page, testInfo, 'lease signing: a wrong code');

    await page.getByLabel('Your 6-digit code').fill(code);
    await page.getByLabel('Type your full name to sign').fill('Ama Signs-Lease');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect(heading(page)).toHaveText('Thank you: you have signed');
    await expectAccessible(page, testInfo, 'lease signing: signed');
  });

  test('LN-04 the notice page: the code sent, and acknowledged', async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    const notice = await noticeFor(staff);
    await page.goto(notice.path);
    await expect(
      page.getByRole('heading', { name: 'Acknowledge receipt', exact: true }),
    ).toBeVisible();
    await expectAccessible(page, testInfo, 'notice');
    const asked = Date.now();
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await expect(page.getByLabel('Your 6-digit code')).toBeVisible();
    await expectAccessible(page, testInfo, 'notice: the code sent');
    await page.getByLabel('Your 6-digit code').fill(await codeTextedTo(notice.phone, asked));
    await page.getByLabel('Type your full name to sign').fill('Kofi Reads-Notices');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Sign to acknowledge receipt' }).click();
    await expect(heading(page)).toHaveText('Thank you: you have acknowledged receipt');
    await expectAccessible(page, testInfo, 'notice: acknowledged');
  });

  test('MI-04 MI-06 the job sheet: answering, declining, starting, the code, a wrong code and done', async ({
    page,
  }, testInfo) => {
    test.setTimeout(150_000);
    const job = await jobSheetFor(staff);
    await page.goto(job.path);
    await expect(page.getByRole('heading', { name: 'Can you do this job?' })).toBeVisible();
    await expectAccessible(page, testInfo, 'job sheet: can you do it');
    await page.getByRole('link', { name: 'I cannot take this job' }).click();
    await expect(page.getByRole('heading', { name: 'Decline the job' })).toBeVisible();
    await expectAccessible(page, testInfo, 'job sheet: declining');
    await page.goto(job.path);
    await page.getByRole('button', { name: 'Accept the job' }).click();
    await expect(page.getByRole('heading', { name: 'Start the work' })).toBeVisible();
    await expectAccessible(page, testInfo, 'job sheet: start the work');
    await page.getByRole('button', { name: 'Start the work' }).click();
    await expect(page.locator('main').getByRole('alert')).toBeVisible();
    await expectAccessible(page, testInfo, 'job sheet: a refusal');

    await page.getByLabel('No photo? Say why').fill('The tenant had already lifted the tiles.');
    await page.getByRole('button', { name: 'Start the work' }).click();
    await expect(page.getByRole('heading', { name: 'Finish the work' })).toBeVisible();
    await expectAccessible(page, testInfo, 'job sheet: finish the work');
    const asked = Date.now();
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await expect(page.getByText(/We sent a code by SMS to/)).toBeVisible();
    await expectAccessible(page, testInfo, 'job sheet: the completion code');
    const sms = await smsSince(job.artisanPhone, /\b\d{6}\b/, asked, 'the one-time code');
    const code = /\b(\d{6})\b/.exec(sms)![1]!;

    await page
      .getByLabel('Photos of the finished work')
      .setInputFiles([{ name: 'after.png', mimeType: 'image/png', buffer: largePng(50_000) }]);
    await page.getByLabel('What did you do?').fill('Replaced the washer.');
    await page.getByLabel('Your 6-digit code').fill(otherCode(code));
    await page.getByRole('button', { name: 'Send the finished work' }).click();
    await expect(page.locator('main').getByRole('alert')).toBeVisible();
    await expectAccessible(page, testInfo, 'job sheet: a wrong code');

    await page.getByLabel('What did you do?').fill('Replaced the washer.');
    await page.getByLabel('Your 6-digit code').fill(code);
    await page.getByRole('button', { name: 'Send the finished work' }).click();
    await expect(heading(page)).toHaveText('Thank you: the work is recorded as done');
    await expectAccessible(page, testInfo, 'job sheet: done');
  });

  test('CM-09 the unsubscribe page: asking, and done', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.goto(await unsubscribeLink(staff));
    await expect(heading(page)).toHaveText(/^Stop emails from /);
    await expectAccessible(page, testInfo, 'unsubscribe');
    await page.getByRole('button', { name: 'Stop emails' }).click();
    await expect(heading(page)).toHaveText(/^You will no longer get emails from /);
    await expectAccessible(page, testInfo, 'unsubscribe: done');
  });
});
