import { expect, test, type Page } from '@playwright/test';
import { PEOPLE, signIn, unique } from './helpers';
import { fixture } from './register-helpers';
import { apiGet, cedis, fundLeaseOwner } from './tax-helpers';

/**
 * AR-04 on the lease page (M5 plan 5.4 and 5.8, decision 6). In the seed, one lease ended early by
 * a move-out, and its settlement and refund were asked for (`lease.refund`) and wait for a second
 * person. The approver checks the figures on the lease and in Approvals, approves, and the refund,
 * paid outside the platform, is recorded with its reference and proof.
 */
interface Termination {
  readonly id: string;
  readonly leaseId: string;
  readonly status: string;
  readonly approvalId: string;
  readonly refundMinor: number;
}

/** A second person who may decide the request: not the one who asked (AD-05). */
async function approverFor(page: Page, approvalId: string): Promise<boolean> {
  const approval = await apiGet<{ mayDecide?: boolean }>(page.request, `/approvals/${approvalId}`);
  return approval.mayDecide === true;
}

test.describe('AR-04 early termination', () => {
  test('the settlement is shown as asked; a second person approves it; the refund is recorded as paid with its reference and proof', async ({
    browser,
    baseURL,
  }) => {
    const reference = `TRF-E2E-${unique()}`;
    let context = await browser.newContext({ baseURL });
    try {
      let page = await context.newPage();
      await signIn(page, PEOPLE.accountant.email);
      const waiting = (await apiGet<Termination[]>(page.request, '/early-terminations')).find(
        (t) => t.status === 'awaiting_approval',
      );
      expect(waiting, 'an early termination waiting for approval: run pnpm db:seed').toBeTruthy();
      // The accountant decides it, unless she asked for it; then the agency admin does.
      if (!(await approverFor(page, waiting!.approvalId))) {
        await context.close();
        context = await browser.newContext({ baseURL });
        page = await context.newPage();
        await signIn(page, PEOPLE.agencyAdmin.email);
        expect(await approverFor(page, waiting!.approvalId)).toBe(true);
      }

      // The lease shows the request's figures, and that it waits for a second person.
      await page.goto(`/leases/${waiting!.leaseId}`);
      const card = page.getByTestId('early-termination');
      await expect(card.getByTestId('termination-status')).toHaveText(
        'Waiting for a second person to approve it',
      );
      const figures = card.getByTestId('termination-figures');
      await expect(figures).toContainText('Prepayment applied to open charges');
      await expect(
        figures.locator('div').filter({ hasText: 'Refund to the tenant' }),
      ).toContainText(cedis(waiting!.refundMinor));
      await expect(card).toContainText(
        'Rent tax already worked out on the advance is not reversed',
      );

      // In Approvals: the steps' figures in words, then the decision.
      await page.goto('/approvals');
      const request = page.locator(`[data-approval-id="${waiting!.approvalId}"]`);
      await expect(request).toContainText('Settle an early termination and refund the tenant');
      await expect(request).toContainText('Refund to the tenant');
      await expect(request).toContainText(cedis(waiting!.refundMinor));
      await request.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(page.getByText('It has taken effect.')).toBeVisible();

      await page.goto(`/leases/${waiting!.leaseId}`);
      await expect(card.getByTestId('termination-status')).toHaveText(
        'Approved: charges raised and the prepayment applied',
      );
      const settled = (
        await apiGet<Termination[]>(page.request, `/early-terminations?leaseId=${waiting!.leaseId}`)
      )[0]!;
      expect(settled.status).toBe('settled');
      if (settled.refundMinor === 0) {
        await expect(card).toContainText('Nothing is left to refund.');
        return;
      }

      // F3 setup (founder-approved, 2026-11-07): the owner's funding first, so the agency holds the
      // refund for the owner before it is paid from the agency's account.
      await fundLeaseOwner(page, waiting!.leaseId, settled.refundMinor);

      // Paid outside the platform (D1): recorded with the reference and the proof.
      const form = card.getByRole('form', { name: 'Record the refund as paid' });
      await form.getByLabel('Transfer or MoMo reference').fill(reference);
      const paidFrom = form.getByLabel('Paid from');
      if (await paidFrom.count()) await paidFrom.selectOption({ label: 'The agency’s account' });
      await form.getByLabel('Proof of the refund').setInputFiles(fixture('title-deed.pdf'));
      await form.getByRole('button', { name: 'Record the refund as paid' }).click();
      await expect(
        page.getByText(`Recorded the refund of ${cedis(settled.refundMinor)} as paid.`),
      ).toBeVisible();
      await expect(card.getByTestId('termination-status')).toHaveText('Refund paid to the tenant');
      await expect(card.getByTestId('refund-paid')).toContainText(reference);
      await expect(card.getByRole('button', { name: 'Open the proof' })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
