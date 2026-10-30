import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';
import {
  fetchPdf,
  heldFor,
  phoneSignIn,
  pickLease,
  runAmount,
  type PhonePerson,
} from './billing-helpers';
import { fixture, OWNER_A } from './register-helpers';

/** Kojo looks after the Legon compound house (ACC-LEG), which belongs to Owner A (the seed). */
const KOJO: PhonePerson = {
  phone: '+233200000011',
  name: 'Kojo Caretaker (demo)',
  typed: '020 000 0011',
};
/** The seed's monthly payer, paid up, so a run's cash only adds credit to the lease. */
const UNIT = 'ACC-LEG-B1-01';

test.describe('BC-05 and P07 cash on hand', () => {
  test('a caretaker records cash with a photo; a manager approves; the receipt PDF exists; the cash is banked and leaves the caretaker’s balance', async ({
    browser,
    baseURL,
  }) => {
    const tag = unique();
    const payer = `Kwame Monthly ${tag} (e2e)`;
    const amount = runAmount();
    const field = await browser.newContext({ baseURL });
    const office = await browser.newContext({ baseURL });
    try {
      // Kojo signs in with a code sent to his phone. Of billing he sees only his cash on hand.
      const caretaker = await field.newPage();
      await phoneSignIn(caretaker, KOJO);
      await expect(nav(caretaker).getByRole('link', { name: 'Cash on hand' })).toBeVisible();
      for (const section of ['Invoices', 'Payments', 'Unmatched receipts', 'Arrears', 'Receipts'])
        await expect(nav(caretaker).getByRole('link', { name: section })).toHaveCount(0);
      expect((await caretaker.request.get('/api/v1/invoices')).status()).toBe(403);
      const before = await heldFor(caretaker, KOJO.name, OWNER_A.name);

      // He records the cash he was handed at the gate, with a photo of the receipt-book page.
      await nav(caretaker).getByRole('link', { name: 'Cash on hand' }).click();
      await caretaker.getByRole('link', { name: 'Record cash or cheque' }).click();
      await ready(caretaker, 'Record the cash');
      const form = caretaker.getByRole('form', { name: 'Record cash or cheque' });
      await pickLease(form, UNIT);
      await form.getByLabel('Amount (GH₵)').fill(amount.typed);
      await form.getByLabel('Paid by').fill(payer);
      // Nothing is sent without the photo.
      await form.getByRole('button', { name: 'Record the cash' }).click();
      await expect(form.getByText('Take a photo of the receipt-book page.')).toBeVisible();
      const photo = form.getByLabel('Photo of the receipt-book page');
      await expect(photo).toHaveAttribute('capture', 'environment');
      await photo.setInputFiles(fixture('property-photo.jpg'));
      await form.getByRole('button', { name: 'Record the cash' }).click();
      const recorded = caretaker.getByTestId('cash-recorded');
      await expect(recorded).toContainText('Recorded, waiting for confirmation');
      await expect(recorded).toContainText(`${amount.shown} in cash for ${UNIT}`);
      await expect(recorded).toContainText('A second person must approve it');

      // Until a second person approves it, it is only recorded: his cash on hand is unchanged.
      await recorded.getByRole('link', { name: 'Cash on hand' }).click();
      const record = caretaker.getByTestId('cash-record').filter({ hasText: payer });
      await expect(record).toContainText('Recorded, waiting for confirmation');
      expect(await heldFor(caretaker, KOJO.name, OWNER_A.name)).toBe(before);

      // A manager approves it on the approvals screen.
      const manager = await office.newPage();
      await signIn(manager, PEOPLE.managerOne.email);
      await nav(manager).getByRole('link', { name: 'Approvals' }).click();
      const cash = manager
        .getByTestId('approval')
        .filter({ hasText: 'Post cash or a cheque received' })
        .filter({ hasText: amount.shown });
      await expect(cash).toHaveCount(1);
      await expect(cash).toContainText(`Asked by ${KOJO.name}`);
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
      const payment = (await (
        await manager.request.get(`/api/v1/payments/${paymentId}`)
      ).json()) as {
        receipts: { id: string }[];
      };
      const pdf = await fetchPdf(manager, `/api/v1/receipts/${payment.receipts[0]!.id}/document`);
      expect(pdf.head).toBe('%PDF-');

      // Now Kojo holds it, until he banks it.
      await caretaker.reload();
      await expect(caretaker.getByTestId('cash-record').filter({ hasText: payer })).toContainText(
        'Confirmed and posted',
      );
      expect(await heldFor(caretaker, KOJO.name, OWNER_A.name)).toBe(before + amount.minor);

      // He banks it into the owner's account, with a photo of the slip.
      await caretaker.getByRole('link', { name: 'Record banking' }).first().click();
      await ready(caretaker, 'Record the banking');
      const banking = caretaker.getByRole('form', { name: 'Record banking' });
      const whose = banking.getByLabel('Whose cash');
      const mine = whose.locator('option', { hasText: `${KOJO.name}, for ${OWNER_A.name}` });
      await whose.selectOption((await mine.getAttribute('value'))!);
      await banking.getByLabel('Amount (GH₵)').fill(amount.typed);
      await banking.getByLabel('Where it went').selectOption({
        label: 'Banked into the owner’s own account',
      });
      await banking
        .getByLabel('Photo of the banking slip')
        .setInputFiles(fixture('property-photo.jpg'));
      await banking.getByRole('button', { name: 'Record the banking' }).click();
      await expect(caretaker.getByTestId('banking-recorded')).toContainText(
        'Banking recorded, waiting for confirmation',
      );
      // Banking counts once it is approved: until then the cash is still his.
      expect(await heldFor(caretaker, KOJO.name, OWNER_A.name)).toBe(before + amount.minor);

      // The manager approves the banking, and the cash leaves Kojo's balance.
      await manager.goto('/approvals');
      const banked = manager
        .getByTestId('approval')
        .filter({ hasText: 'Record cash as banked' })
        .filter({ hasText: amount.shown });
      await expect(banked).toHaveCount(1);
      await banked.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(manager.getByText('It has taken effect.')).toBeVisible();
      expect(await heldFor(caretaker, KOJO.name, OWNER_A.name)).toBe(before);
      await caretaker.goto('/cash');
      await expect(caretaker.getByRole('heading', { level: 1 })).toHaveText('Cash on hand');
    } finally {
      await field.close();
      await office.close();
    }
  });
});
