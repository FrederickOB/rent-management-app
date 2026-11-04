import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { format, money } from '@rent/domain/money';
import { MATCH_REASON_LABELS } from '../lib/unmatched-queue';
import { pickLease } from './billing-helpers';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';
import { fixture } from './register-helpers';

/**
 * BC-12, P23 and P31 (M4b plan 4.5): money that matched no pay link and no exact payment
 * reference waits in the unmatched queue. The API ranks the leases it may belong to; a person
 * confirms each match; money that belongs to no one is refunded to its payer once a second
 * person approves.
 *
 * The seed (plan 4.13) records provider payments through the fake, two of them with no intent
 * metadata and no reference: GH₵750.00 from an unknown phone into Owner A's account, and Kwesi's
 * month from his own phone into the agency's client account. Both have suggestions; the spec only
 * looks at them, and never matches them. The money it
 * matches or refunds is its own: transfers recorded without a lease and approved by a second
 * person, found again by their sender's reference. Matched money goes to the seed's paid-up
 * monthly payer, ACC-LEG-B1-01, where it only adds credit.
 */

const MONTHLY_PAYER = 'ACC-LEG-B1-01';
/** One month of Kwame Monthly's rent on ACC-LEG-B1-01 in the seed: GH₵800.00. */
const ONE_MONTH = { typed: '800', minor: 80_000 };
const cedis = (minor: number) => format(money(minor));

interface Unmatched {
  readonly paymentId: string;
  readonly amountMinor: number;
  readonly receivedInto: string;
  readonly payerPhoneMasked?: string | null;
}

/** The seed's paying phones (fictional): only ever shown masked. */
const SEEDED_PHONES = ['+233200000042', '+233200000099'];

interface SuggestionRow {
  readonly leaseId: string;
  readonly unitCode: string;
  readonly tenantName: string;
  readonly reasons: (keyof typeof MATCH_REASON_LABELS)[];
}

async function json<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.status(), `${path}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

/** The queue row for a payment, by its details link. */
const queueRow = (page: Page, paymentId: string): Locator =>
  page
    .getByTestId('unmatched-receipt')
    .filter({ has: page.locator(`a[href="/payments/${paymentId}"]`) });

/**
 * Records a transfer into the agency's account with no lease, as `recorder`, and has a second
 * person approve it, so it waits in the queue (P28, P23). Returns its sender's reference.
 */
async function unmatchedTransfer(
  browser: Browser,
  baseURL: string | undefined,
  recorder: Page,
  amountTyped: string,
): Promise<string> {
  const reference = `E2E-${unique()}`;
  await recorder.goto('/payments/transfer');
  await ready(recorder, 'Record the transfer');
  const form = recorder.getByRole('form', { name: 'Record a transfer' });
  await form.getByLabel('Which account it went into').selectOption({
    label: 'The agency’s account',
  });
  await form.getByLabel('Amount (GH₵)').fill(amountTyped);
  await form.getByLabel('Sender’s reference (optional)').fill(reference);
  await form.getByLabel('Proof of the transfer').setInputFiles(fixture('property-photo.jpg'));
  const recorded = recorder.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/v1/direct-receipts' && r.request().method() === 'POST',
  );
  await form.getByRole('button', { name: 'Record the transfer' }).click();
  const response = await recorded;
  expect(response.status(), 'record the transfer').toBe(200);
  const { approval } = (await response.json()) as { approval: { id: string } };

  const second = await browser.newContext({ baseURL });
  try {
    const approver = await second.newPage();
    await signIn(approver, PEOPLE.managerTwo.email);
    await approver.goto('/approvals');
    const request = approver.locator(`[data-approval-id="${approval.id}"]`);
    await expect(request).toContainText('Post a transfer received');
    await request.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(approver.getByText('It has taken effect.')).toBeVisible();
  } finally {
    await second.close();
  }
  return reference;
}

test.describe('BC-12 the unmatched queue', () => {
  test('suggestions are shown in the API’s order with their reasons, and nothing is matched until a person confirms', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const queue = await json<Unmatched[]>(page, '/api/v1/unmatched-receipts');
    let found: { row: Unmatched; suggestions: SuggestionRow[] } | null = null;
    for (const row of queue.filter((r) => r.receivedInto === 'provider')) {
      const suggestions = await json<SuggestionRow[]>(
        page,
        `/api/v1/unmatched-receipts/${row.paymentId}/suggestions`,
      );
      if (suggestions.length) {
        found = { row, suggestions };
        break;
      }
    }
    expect(found, 'a seeded provider payment with suggestions: run pnpm db:seed').not.toBeNull();
    const { row, suggestions } = found!;

    await nav(page).getByRole('link', { name: 'Unmatched receipts' }).click();
    const item = queueRow(page, row.paymentId);
    await expect(item).toContainText(cedis(row.amountMinor));
    // What came with the money, the paying phone masked (CLAUDE.md section 10).
    const facts = item.getByTestId('unmatched-provider-fact');
    await expect(facts.first()).toHaveText('Mobile money through Paystack');
    if (row.payerPhoneMasked) await expect(item).toContainText(row.payerPhoneMasked);
    for (const phone of SEEDED_PHONES) await expect(page.locator('body')).not.toContainText(phone);
    await item.getByRole('button', { name: /^Find the lease/ }).click();
    const panel = item.getByTestId('match-suggestions');
    const shown = panel.getByTestId('match-suggestion');
    await expect(shown).toHaveCount(suggestions.length);
    for (const [index, suggestion] of suggestions.entries()) {
      const entry = shown.nth(index);
      await expect(entry).toContainText(`${index + 1}. ${suggestion.unitCode}`);
      await expect(entry).toContainText(suggestion.tenantName);
      for (const reason of suggestion.reasons)
        await expect(entry).toContainText(MATCH_REASON_LABELS[reason]);
    }

    // Choosing a suggestion only asks; the person must confirm, and can say "not this one".
    const first = suggestions[0]!;
    await shown
      .first()
      .getByRole('button', { name: `Match to ${first.unitCode}` })
      .click();
    const confirm = shown.first().getByRole('group', {
      name: `Confirm the match to ${first.unitCode}`,
    });
    await expect(confirm).toContainText('oldest debt first');
    await confirm.getByRole('button', { name: 'Not this one' }).click();
    await expect(confirm).toHaveCount(0);
    const still = await json<Unmatched[]>(page, '/api/v1/unmatched-receipts');
    expect(still.map((r) => r.paymentId)).toContain(row.paymentId);
  });

  test('P23 a person confirms the match: the money leaves the queue, pays the lease and gets its receipt', async ({
    page,
    browser,
    baseURL,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const reference = await unmatchedTransfer(browser, baseURL, page, ONE_MONTH.typed);

    await page.goto('/payments/unmatched');
    const item = page.getByTestId('unmatched-receipt').filter({ hasText: reference });
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(cedis(ONE_MONTH.minor));
    const href = await item.getByRole('link', { name: 'Details' }).getAttribute('href');
    const paymentId = href!.split('/').pop()!;
    await item.getByRole('button', { name: /^Find the lease/ }).click();
    const panel = item.getByTestId('match-suggestions');
    await expect(panel.getByRole('status')).toHaveCount(0);

    // A month of its rent is a reason to suggest the monthly payer's lease. If the ranking puts
    // it among the suggestions, the person confirms it there; otherwise they choose it by hand.
    const suggested = panel.getByTestId('match-suggestion').filter({ hasText: MONTHLY_PAYER });
    const matched = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/v1/unmatched-receipts/${paymentId}/match` &&
        r.request().method() === 'POST',
    );
    if ((await suggested.count()) === 1) {
      await expect(suggested).toContainText(MATCH_REASON_LABELS.amount_is_a_month);
      await suggested.getByRole('button', { name: `Match to ${MONTHLY_PAYER}` }).click();
      await suggested.getByRole('button', { name: 'Confirm the match' }).click();
    } else {
      await panel.getByRole('button', { name: 'Choose another lease' }).click();
      const byHand = panel.getByRole('form', { name: 'Match to a lease' });
      await pickLease(byHand, MONTHLY_PAYER);
      await byHand.getByRole('button', { name: 'Match it' }).click();
    }
    const response = await matched;
    expect(response.status(), 'confirm the match').toBe(200);
    expect(response.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      page.getByText(`Matched ${cedis(ONE_MONTH.minor)} to ${MONTHLY_PAYER}.`),
    ).toBeVisible();
    await expect(page.getByTestId('unmatched-receipt').filter({ hasText: reference })).toHaveCount(
      0,
    );

    // The payment now belongs to the lease, with a numbered receipt.
    await page.goto(`/payments/${paymentId}`);
    await expect(page.getByTestId('payment-status')).toHaveText('Received');
    await expect(page.getByText(`${MONTHLY_PAYER} · Kwame Monthly (demo)`)).toBeVisible();
    await expect(page.getByTestId('receipt').first()).toContainText(/RC-\d{6}/);
  });

  test('P31 money that belongs to no one is refunded to its payer once a second person approves', async ({
    page,
    browser,
    baseURL,
  }) => {
    const pesewas = String(10 + Math.trunc(Math.random() * 89));
    const typed = `12.${pesewas}`;
    const amount = cedis(1_200 + Number(pesewas));
    await signIn(page, PEOPLE.accountant.email);
    const reference = await unmatchedTransfer(browser, baseURL, page, typed);

    await page.goto('/payments/unmatched');
    const item = page.getByTestId('unmatched-receipt').filter({ hasText: reference });
    await expect(item).toContainText(amount);
    await item.getByRole('button', { name: /^Refund to the payer/ }).click();
    const form = item.getByRole('form', { name: `Refund ${amount} to the payer` });
    // A transfer is sent back outside the provider, so its proof is asked for.
    await form.getByRole('button', { name: 'Ask for the refund' }).click();
    await expect(form.getByText('Say why, in at least 5 characters')).toBeVisible();
    await expect(form.getByText(/Attach the proof/)).toBeVisible();
    await form.getByLabel('Why it is refunded').fill(`Sent to us by mistake (${reference})`);
    await form
      .getByLabel('Proof the money was sent back')
      .setInputFiles(fixture('property-photo.jpg'));
    const asked = page.waitForResponse((r) =>
      /\/api\/v1\/unmatched-receipts\/[0-9a-f-]{36}\/refund$/.test(new URL(r.url()).pathname),
    );
    await form.getByRole('button', { name: 'Ask for the refund' }).click();
    const response = await asked;
    expect(response.status(), 'ask for the refund').toBe(200);
    expect(response.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    const { approval } = (await response.json()) as { approval: { id: string } };
    await expect(page.getByText(`Asked to refund ${amount} to the payer.`)).toBeVisible();
    // Until it is approved, the money still waits in the queue, marked, and is not matched.
    const waiting = page.getByTestId('unmatched-receipt').filter({ hasText: reference });
    await expect(waiting).toHaveCount(1);
    await expect(waiting.getByTestId('unmatched-refund')).toContainText(
      'A refund to the payer is waiting for a second person.',
    );
    await expect(waiting.getByRole('button', { name: /^Find the lease/ })).toHaveCount(0);
    await expect(waiting.getByRole('button', { name: /^Refund to the payer/ })).toHaveCount(0);

    // The accountant cannot approve her own request; the agency admin checks the proof and does.
    await nav(page).getByRole('link', { name: 'Approvals' }).click();
    const own = page.locator(`[data-approval-id="${approval.id}"]`);
    await expect(own).toContainText('Refund unmatched money to its payer');
    await expect(own.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

    const office = await browser.newContext({ baseURL });
    try {
      const admin = await office.newPage();
      await signIn(admin, PEOPLE.agencyAdmin.email);
      await admin.goto('/approvals');
      const request = admin.locator(`[data-approval-id="${approval.id}"]`);
      await expect(request).toContainText('Refund unmatched money to its payer');
      await expect(request).toContainText(amount);
      await expect(request).toContainText(`Sent to us by mistake (${reference})`);
      await expect(request.getByRole('button', { name: 'Open the transfer proof' })).toBeVisible();
      await request.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(admin.getByText('It has taken effect.')).toBeVisible();
    } finally {
      await office.close();
    }

    await page.goto('/payments/unmatched');
    await expect(page.getByTestId('unmatched-receipt').filter({ hasText: reference })).toHaveCount(
      0,
    );
  });
});
