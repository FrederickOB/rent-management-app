import { expect, test, type Page } from '@playwright/test';
import { format, money } from '@rent/domain/money';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';
import {
  cashFor,
  fetchPdf,
  phoneSession,
  pickLease,
  type CollectorCashRow,
  type PhonePerson,
} from './billing-helpers';
import { fixture, OWNER_A } from './register-helpers';

/** Kojo looks after the Legon compound house (ACC-LEG), which belongs to Owner A (the seed). */
const KOJO: PhonePerson = {
  phone: '+233200000011',
  name: 'Kojo Caretaker (demo)',
  typed: '020 000 0011',
  label: 'kojo',
};
/** The seed's monthly payer, paid up, so a run's cash only adds credit to the lease. */
const UNIT = 'ACC-LEG-B1-01';
/** Each run records and banks GH₵50.00; its requests are found by the run's own payer. */
const AMOUNT = { typed: '50', minor: 5_000 };
/** Other collectors' cash in the seed (plan section 5), which Kojo must never see. */
const MANAGERS_CASH = [
  'Kofi Manager (demo)',
  'Akosua Manager (demo)',
  'GH₵14,600.00',
  'GH₵3,350.00',
];

const cedis = (minor: number) => format(money(minor));

/** Kojo's row for Owner A on his Cash on hand screen shows these balances. */
async function expectOnScreen(page: Page, cash: Omit<CollectorCashRow, 'collectorPersonId'>) {
  const row = page.getByTestId('cash-holding').filter({ hasText: cash.ownerName });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('cash-held')).toHaveText(cedis(cash.heldMinor));
  await expect(row.getByTestId('cash-pending')).toHaveText(cedis(cash.bankingPendingMinor));
  await expect(row.getByTestId('cash-bankable')).toHaveText(cedis(cash.bankableMinor));
}

test.describe('BC-05 and P07 cash on hand', () => {
  test('a caretaker records cash with a photo; a manager approves; the receipt PDF exists; the cash is banked and leaves the caretaker’s balance', async ({
    browser,
    baseURL,
  }) => {
    const tag = unique();
    const payer = `Kwame Monthly ${tag} (e2e)`;
    // One phone sign-in for Kojo per run, kept for a CI retry.
    const field = await phoneSession(browser, baseURL, KOJO);
    const office = await browser.newContext({ baseURL });
    try {
      // Of billing, Kojo sees only his cash on hand.
      const caretaker = await field.newPage();
      await caretaker.goto('/');
      await expect(nav(caretaker).getByRole('link', { name: 'Cash on hand' })).toBeVisible();
      for (const section of ['Invoices', 'Payments', 'Unmatched receipts', 'Arrears', 'Receipts'])
        await expect(nav(caretaker).getByRole('link', { name: section })).toHaveCount(0);
      expect((await caretaker.request.get('/api/v1/invoices')).status()).toBe(403);

      // His own cash only, never the managers'. A retried run starts from where the last left it.
      await nav(caretaker).getByRole('link', { name: 'Cash on hand' }).click();
      const holdings = caretaker.getByTestId('cash-holding');
      await expect(holdings.first()).toBeVisible();
      await expect(holdings.filter({ hasText: `${KOJO.name} (you)` })).toHaveCount(
        await holdings.count(),
      );
      for (const theirs of MANAGERS_CASH)
        await expect(caretaker.getByTestId('cash-on-hand')).not.toContainText(theirs);
      const start = await cashFor(caretaker, KOJO.name, OWNER_A.name);
      await expectOnScreen(caretaker, start);

      // He records the cash he was handed at the gate, with a photo of the receipt-book page.
      await caretaker.getByRole('link', { name: 'Record cash or cheque' }).click();
      await ready(caretaker, 'Record the cash');
      const form = caretaker.getByRole('form', { name: 'Record cash or cheque' });
      await pickLease(form, UNIT);
      await form.getByLabel('Amount (GH₵)').fill(AMOUNT.typed);
      await form.getByLabel('Paid by').fill(payer);
      // Nothing is sent without the photo, which may come from the camera or the gallery.
      await form.getByRole('button', { name: 'Record the cash' }).click();
      await expect(form.getByText('Take a photo of the receipt-book page.')).toBeVisible();
      const photo = form.getByLabel('Photo of the receipt-book page');
      await expect(photo).not.toHaveAttribute('capture');
      await expect(photo).toHaveAttribute('accept', 'image/jpeg,image/png');
      await photo.setInputFiles(fixture('property-photo.jpg'));
      await form.getByRole('button', { name: 'Record the cash' }).click();
      const recorded = caretaker.getByTestId('cash-recorded');
      await expect(recorded).toContainText('Recorded, waiting for confirmation');
      await expect(recorded).toContainText(`${cedis(AMOUNT.minor)} in cash for ${UNIT}`);
      await expect(recorded).toContainText('A second person must approve it');

      // Until a second person approves it, it is only recorded: his balances are unchanged.
      await recorded.getByRole('link', { name: 'Cash on hand' }).click();
      const record = caretaker.getByTestId('cash-record').filter({ hasText: payer });
      await expect(record).toContainText('Recorded, waiting for confirmation');
      await expect(
        record.getByRole('button', { name: 'Open the receipt-book photo' }),
      ).toBeVisible();
      await expectOnScreen(caretaker, start);

      // A manager finds the request by its payer, checks the photo, then approves it.
      const manager = await office.newPage();
      await signIn(manager, PEOPLE.managerOne.email);
      await nav(manager).getByRole('link', { name: 'Approvals' }).click();
      const cash = manager
        .getByTestId('approval')
        .filter({ hasText: 'Post cash or a cheque received' })
        .filter({ hasText: payer });
      await expect(cash).toHaveCount(1);
      await expect(cash).toContainText(`Asked by ${KOJO.name}`);
      await expect(cash).toContainText(`Lease for ${UNIT}`);
      await expect(cash).toContainText(cedis(AMOUNT.minor));
      const download = manager.waitForResponse(
        (r) =>
          /\/api\/v1\/payment-files\/[0-9a-f-]{36}\/download$/.test(new URL(r.url()).pathname) &&
          r.request().method() === 'GET',
      );
      const tab = office.waitForEvent('page');
      await cash.getByRole('button', { name: 'Open the receipt-book photo' }).click();
      const answered = await download;
      expect(answered.status(), 'the photo’s download link').toBe(200);
      const file = await manager.request.get(((await answered.json()) as { url: string }).url);
      expect(file.status(), 'the photo itself').toBe(200);
      expect(file.headers()['content-type']).toMatch(/^image\//);
      await (await tab).close();
      await cash.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(manager.getByText('It has taken effect.')).toBeVisible();

      // The cash became a payment with a numbered receipt, and its PDF exists.
      const records = (await (
        await manager.request.get('/api/v1/cash-records?status=approved')
      ).json()) as { payerName: string; paymentId: string | null }[];
      const paymentId = records.find((r) => r.payerName === payer)?.paymentId;
      expect(paymentId, 'the approved cash record has its payment').toBeTruthy();
      await manager.goto(`/payments/${paymentId}`);
      const receipt = manager.getByTestId('receipt').first();
      await expect(receipt).toContainText(/RC-\d{6}/);
      await expect(manager.getByTestId('payment-summary')).toContainText(KOJO.name);
      await expect(
        manager.getByTestId('payment-summary').getByRole('button', {
          name: 'Open the receipt-book photo',
        }),
      ).toBeVisible();
      const payment = (await (
        await manager.request.get(`/api/v1/payments/${paymentId}`)
      ).json()) as { receipts: { id: string }[] };
      const pdf = await fetchPdf(manager, `/api/v1/receipts/${payment.receipts[0]!.id}/document`);
      expect(pdf.head).toBe('%PDF-');

      // Now Kojo holds it, until he banks it.
      const held = {
        ...start,
        heldMinor: start.heldMinor + AMOUNT.minor,
        bankableMinor: start.bankableMinor + AMOUNT.minor,
      };
      await caretaker.reload();
      await expect(caretaker.getByTestId('cash-record').filter({ hasText: payer })).toContainText(
        'Confirmed and posted',
      );
      await expectOnScreen(caretaker, held);

      // He banks it into the owner's account, with a photo of the slip.
      await caretaker.getByRole('link', { name: 'Record banking' }).first().click();
      await ready(caretaker, 'Record the banking');
      const banking = caretaker.getByRole('form', { name: 'Record banking' });
      const whose = banking.getByLabel('Whose cash');
      const mine = whose.locator('option', { hasText: `${KOJO.name}, for ${OWNER_A.name}` });
      await whose.selectOption((await mine.getAttribute('value'))!);
      await banking.getByLabel('Amount (GH₵)').fill(AMOUNT.typed);
      await banking.getByLabel('Where it went').selectOption({
        label: 'Banked into the owner’s own account',
      });
      await banking
        .getByLabel('Photo of the banking slip')
        .setInputFiles(fixture('property-photo.jpg'));
      const asked = caretaker.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/v1/cash-bankings' && r.request().method() === 'POST',
      );
      await banking.getByRole('button', { name: 'Record the banking' }).click();
      const bankingRequest = await asked;
      expect(bankingRequest.status(), 'record the banking').toBe(200);
      const approvalId = ((await bankingRequest.json()) as { approval: { id: string } }).approval
        .id;
      await expect(caretaker.getByTestId('banking-recorded')).toContainText(
        'Banking recorded, waiting for confirmation',
      );
      // Banking counts once it is approved: until then the cash is still his, and waiting.
      await caretaker.getByRole('link', { name: 'Back to cash on hand' }).click();
      await expectOnScreen(caretaker, {
        ...held,
        bankingPendingMinor: start.bankingPendingMinor + AMOUNT.minor,
        bankableMinor: start.bankableMinor,
      });

      // The manager approves this banking, with its slip to hand, and it leaves Kojo's balance.
      await manager.goto('/approvals');
      const banked = manager.locator(`[data-approval-id="${approvalId}"]`);
      await expect(banked).toContainText('Record cash as banked');
      await expect(banked.getByRole('button', { name: 'Open the banking slip' })).toBeVisible();
      await banked.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(manager.getByText('It has taken effect.')).toBeVisible();
      await caretaker.reload();
      await expectOnScreen(caretaker, start);
      expect(await cashFor(caretaker, KOJO.name, OWNER_A.name)).toMatchObject({
        heldMinor: start.heldMinor,
        bankingPendingMinor: start.bankingPendingMinor,
        bankableMinor: start.bankableMinor,
      });
    } finally {
      await field.close();
      await office.close();
    }
  });
});
