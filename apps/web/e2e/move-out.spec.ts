import { expect, test, type Browser } from '@playwright/test';
import { money, toDecimal } from '@rent/domain/money';
import { MOVE_OUT_STATUS_LABELS } from '@rent/domain/moveout';
import { PEOPLE, ready, signIn, unique } from './helpers';
import { draftedMoveOut, keyed, type MoveOutDetailRow } from './maintenance-helpers';
import { apiGet, cedis, pesewasOf } from './tax-helpers';

/**
 * TL-11 and MI-11 on the move-out (M8 plan 6, ★): a deduction over the deposit is refused, the
 * final statement balances, and the settlement needs a second person. They use the seed's move-out
 * whose settlement is being drafted (plan 4.14). The last test sends it for approval and approves
 * it, which changes the seed: run pnpm db:seed before running this file again.
 */

const live = (d: MoveOutDetailRow) =>
  d.deductions.filter((x) => x.withdrawnAt === null).reduce((sum, x) => sum + x.amountMinor, 0);

test.describe.configure({ mode: 'serial' });

test.describe('MI-11 ★ deductions never exceed the deposit held', () => {
  test('the screen says how much is left and refuses more; the API refuses it too', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const moveOut = await draftedMoveOut(page);
    const held = moveOut.statement!.depositHeldMinor;
    const left = Math.max(held - live(moveOut), 0);

    await page.goto(`/leases/${moveOut.leaseId}/move-out`);
    const deductions = page.getByTestId('move-out-deductions');
    await expect(deductions.getByTestId('deposit-left-amount')).toHaveText(cedis(left));
    const before = await deductions.getByTestId('deduction').count();

    await ready(page, 'Add a deduction');
    await deductions.getByRole('button', { name: 'Add a deduction' }).click();
    const form = page.getByRole('form', { name: 'Add a deduction' });
    await form.getByLabel('For').selectOption({ label: 'Cleaning' });
    await form.getByLabel('Amount (GH₵)').fill(toDecimal(money(left + 100_00)));
    await form.getByLabel('Reason').fill(`A deep clean beyond the deposit ${unique()} (e2e)`);
    await form.getByRole('button', { name: 'Add the deduction' }).click();
    await expect(form).toContainText(
      left > 0
        ? `Only ${cedis(left)} of the deposit is left. Record damage beyond the deposit as a charge.`
        : 'Nothing is left of the deposit.',
    );
    await expect(deductions.getByTestId('deduction')).toHaveCount(before);

    const refused = await page.request.post(`/api/v1/move-outs/${moveOut.id}/deductions`, {
      headers: keyed(),
      data: { kind: 'cleaning', amountMinor: left + 100, reason: 'More than the deposit (e2e)' },
    });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { code?: string }).code?.toUpperCase()).toBe(
      'DEDUCTIONS_EXCEED_DEPOSIT',
    );
    const after = await apiGet<MoveOutDetailRow>(page.request, `/move-outs/${moveOut.id}`);
    expect(live(after)).toBe(live(moveOut));
  });
});

test.describe('TL-11 ★ the final statement balances', () => {
  test('deposit and credit equal what is applied, kept and refunded, and the screen shows it', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const moveOut = await draftedMoveOut(page);
    const s = moveOut.statement!;
    expect(s.depositHeldMinor + s.creditMinor).toBe(
      s.creditAppliedMinor +
        s.depositAppliedMinor +
        s.retainedMinor +
        s.creditRefundMinor +
        s.depositRefundMinor,
    );
    expect(s.arrearsMinor + s.deductionsChargedMinor).toBe(
      s.creditAppliedMinor + s.depositAppliedMinor + s.stillOwedMinor,
    );

    await page.goto(`/leases/${moveOut.leaseId}/move-out`);
    const statement = page.getByTestId('move-out-statement');
    await expect(statement.getByTestId('statement-balance')).toHaveAttribute(
      'data-balances',
      'true',
    );
    await expect(statement.getByTestId('statement-balance')).toContainText('It balances');
    await expect(statement.getByTestId('statement-deposit')).toContainText(
      cedis(s.depositHeldMinor),
    );
    const refund = await statement.getByTestId('statement-refund').locator('dd').innerText();
    expect(pesewasOf(refund)).toBe(s.refundMinor);
    const owed = await statement.getByTestId('statement-stillOwed').locator('dd').innerText();
    expect(pesewasOf(owed)).toBe(s.stillOwedMinor);
  });
});

/**
 * As a manager: the drafted settlement sent for approval, then the request as its asker sees it,
 * with no way to approve it themselves (AD-05).
 */
async function askForSettlement(
  browser: Browser,
  baseURL: string | undefined,
): Promise<{ approvalId: string; leaseId: string; moveOutId: string }> {
  const asker = await browser.newContext({ baseURL });
  try {
    const page = await asker.newPage();
    await signIn(page, PEOPLE.managerOne.email);
    const moveOut = await draftedMoveOut(page);
    const leaseId = moveOut.leaseId;
    await page.goto(`/leases/${leaseId}/move-out`);
    const submit = page.getByTestId('move-out-submit');
    await ready(page, 'Ask for approval');
    await submit.getByRole('button', { name: 'Ask for approval' }).click();
    await expect(page.getByText('Asked for the settlement.')).toBeVisible();
    await expect(page.getByTestId('move-out-status')).toHaveText('Awaiting approval');
    const sent = await apiGet<MoveOutDetailRow>(page.request, `/move-outs/${moveOut.id}`);
    expect(sent.approval, 'the settlement is an approval request').not.toBeNull();
    const approvalId = sent.approval!.id;

    // The asker sees the request, its statement, and that a second person must decide it.
    await page.goto('/approvals');
    const card = page.locator(`[data-approval-id="${approvalId}"]`);
    await expect(card).toContainText('Settle a move-out: the deposit, deductions and refund');
    await expect(card.getByTestId('move-out-approval')).toBeVisible();
    await expect(card.getByTestId('statement-balance')).toHaveAttribute('data-balances', 'true');
    await expect(card).toContainText(
      'Waiting for a second person. You asked, so you cannot approve this yourself.',
    );
    await expect(card.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    // The API refuses the asker's own approval.
    const own = await page.request.post(`/api/v1/approvals/${approvalId}/decisions`, {
      data: { decision: 'approve' },
    });
    expect(own.status()).toBeGreaterThanOrEqual(400);
    expect(own.status()).toBeLessThan(500);
    return { approvalId, leaseId, moveOutId: moveOut.id };
  } finally {
    await asker.close();
  }
}

test.describe('TL-11 ★ the settlement needs a second approver', () => {
  test('whoever asks cannot approve it; a second person approves it with the statement and photos in front of them', async ({
    browser,
    baseURL,
  }) => {
    const { approvalId, leaseId, moveOutId } = await askForSettlement(browser, baseURL);

    const approver = await browser.newContext({ baseURL });
    try {
      const page = await approver.newPage();
      await signIn(page, PEOPLE.agencyAdmin.email);
      await page.goto('/approvals');
      const card = page.locator(`[data-approval-id="${approvalId}"]`);
      await expect(card.getByTestId('move-out-approval')).toBeVisible();
      await expect(card.getByTestId('statement-balance')).toHaveAttribute('data-balances', 'true');
      // Every deduction is in front of the approver, with its photos or a note that it has none.
      const deductions = card.getByTestId('deduction');
      for (let index = 0; index < (await deductions.count()); index += 1) {
        const d = deductions.nth(index);
        await expect(
          d.getByTestId('media-view').or(d.getByTestId('deduction-no-photo')).first(),
        ).toBeVisible();
      }
      await card.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(page.getByText('It has taken effect.')).toBeVisible();

      // Approved by the second person, and done: a settlement with a refund due stays Approved
      // until the refund is recorded as paid; one with nothing to refund closes at once.
      const settled = await apiGet<MoveOutDetailRow>(page.request, `/move-outs/${moveOutId}`);
      expect(settled.approvedOn, 'the settlement is approved').toBeTruthy();
      const expected = settled.statement!.refundMinor > 0 ? 'approved' : 'closed';
      expect(settled.status).toBe(expected);
      await page.goto(`/leases/${leaseId}/move-out`);
      await expect(page.getByTestId('move-out-status')).toHaveText(
        MOVE_OUT_STATUS_LABELS[expected],
      );
    } finally {
      await approver.close();
    }
  });
});
