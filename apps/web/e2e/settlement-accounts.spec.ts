import { expect, test, type Page } from '@playwright/test';
import { nav, PEOPLE, ready, signIn } from './helpers';
import { OWNER_A, OWNER_B } from './register-helpers';

/**
 * ADR-008 and M4b plan 4.2: rent settles straight into the owner's or the agency's bank
 * account, never through the platform. The seed (plan 4.13) gives Owner A (OWN-01), Owner B
 * (OWN-02) and the agency an account each, already past its 24 hours; OWN-01's rent settles to
 * the owner's own account and OWN-02's to the agency's client account. A new account is a
 * request a second person approves; it takes rent 24 hours later; its number is only ever shown
 * masked, unless someone allowed reveals it with a reason. The spec withdraws its own request, so
 * the seed's accounts stay as they were.
 */

/** Owner A's seeded account: its name and its fictional number (packages/server seed). */
const OWNER_A_ACCOUNT = { name: 'Owner A (demo)', number: '0010000000101' };

/** Ten random digits after a fixed prefix, so a run's number is its own. */
const accountNumber = (): string =>
  `90${Array.from({ length: 10 }, () => Math.trunc(Math.random() * 10)).join('')}`;

async function openSettlement(page: Page) {
  await nav(page).getByRole('link', { name: 'Settlement accounts' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settlement accounts');
  await expect(page.getByTestId('settlement-account').first()).toBeVisible();
}

test.describe('ADR-008 settlement account changes', () => {
  test('an agency admin asks to add an owner’s account: masked at once, waiting for a second person, never usable at once', async ({
    page,
  }) => {
    const number = accountNumber();
    const lastFour = number.slice(-4);
    await signIn(page, PEOPLE.agencyAdmin.email);
    await openSettlement(page);

    // The seed's accounts are in use, and show only their last four digits.
    const accounts = page.getByTestId('settlement-account');
    await expect(accounts.filter({ hasText: 'In use' }).first()).toBeVisible();
    for (const masked of await page.getByTestId('settlement-number').allTextContents())
      expect(masked).toMatch(/^•••• \d{4}$/);
    // Each owner's rent has somewhere to go (decision 6), and links can be sent.
    const agreements = page.getByTestId('management-agreement');
    for (const [owner, destination] of [
      [OWNER_A.name, 'The owner’s own account'],
      [OWNER_B.name, 'The agency’s client account'],
    ] as const) {
      const row = agreements.filter({ hasText: owner });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(destination);
      await expect(row).toContainText('Can be sent');
    }

    // She asks to add a new account for Owner A.
    await page.getByRole('button', { name: 'Add a bank account' }).click();
    const form = page.getByRole('form', { name: 'Add a bank account' });
    await ready(page, 'Ask to add the account');
    await form.getByLabel('Whose account').selectOption({ label: 'An owner’s own account' });
    await form.getByLabel('The owner').selectOption({ label: OWNER_A.option });
    const bank = form.getByLabel('Bank');
    await expect(bank.locator('option').nth(1)).toBeAttached();
    await bank.selectOption({ index: 1 });
    await form.getByLabel('Account number').fill(number);
    await form.getByLabel('Name on the account').fill('Ama Owner-London');
    const asked = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/v1/settlement-accounts' &&
        r.request().method() === 'POST',
    );
    await form.getByRole('button', { name: 'Ask to add the account' }).click();
    const response = await asked;
    expect(response.status(), 'ask to add the account').toBe(200);
    // Money writes carry an Idempotency-Key (M4a plan 4.15).
    expect(response.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    const { approval } = (await response.json()) as { approval: { id: string } };

    await expect(page.getByText(`Asked to add`)).toBeVisible();
    await expect(
      page.getByText(/must approve it|Nobody else in your company can approve it/),
    ).toBeVisible();
    const added = accounts.filter({ hasText: `•••• ${lastFour}` });
    await expect(added).toHaveCount(1);
    await expect(added).toContainText('Waiting for a second person');
    await expect(added).toContainText('Nothing is paid into it until a second person approves it.');
    await expect(added.getByTestId('settlement-open-request')).toContainText(
      'Adding it is waiting for a second person.',
    );
    // No second request can be asked for while one waits.
    await expect(added.getByRole('button', { name: /^Ask to stop using it/ })).toHaveCount(0);
    // The number she typed is never shown again, anywhere on the page.
    await expect(page.locator('body')).not.toContainText(number);

    // In Approvals she sees her own request, masked, and cannot approve it herself.
    await nav(page).getByRole('link', { name: 'Approvals' }).click();
    const request = page.locator(`[data-approval-id="${approval.id}"]`);
    await expect(request).toContainText('Add a bank account rent settles into');
    await expect(request).toContainText(`•••• ${lastFour}`);
    await expect(request).toContainText(OWNER_A.name);
    await expect(request).not.toContainText(number);
    await expect(request.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await request.getByRole('button', { name: 'Withdraw the request' }).click();
    await expect(page.getByText('Withdrew the request. Nothing changed.')).toBeVisible();
  });

  test('CLAUDE.md section 10 an agency admin sees a full account number only with a reason', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.agencyAdmin.email);
    await openSettlement(page);
    const account = page
      .getByTestId('settlement-account')
      .filter({ hasText: OWNER_A_ACCOUNT.name })
      .filter({ hasText: 'In use' });
    await expect(account).toHaveCount(1);
    await expect(account.getByTestId('settlement-number')).toHaveText(
      `•••• ${OWNER_A_ACCOUNT.number.slice(-4)}`,
    );
    await expect(page.locator('body')).not.toContainText(OWNER_A_ACCOUNT.number);

    await account.getByRole('button', { name: /^Show the full number/ }).click();
    const form = account.getByRole('form', { name: /^Show the full number of / });
    await form.getByRole('button', { name: 'Show the number' }).click();
    await expect(form.getByText('Give a reason of at least 5 characters.')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(OWNER_A_ACCOUNT.number);
    await form.getByLabel('Reason').fill('Checking the owner’s statement against the bank');
    const revealed = page.waitForResponse((r) =>
      /\/api\/v1\/settlement-accounts\/[0-9a-f-]{36}\/reveal$/.test(new URL(r.url()).pathname),
    );
    await form.getByRole('button', { name: 'Show the number' }).click();
    expect((await revealed).status(), 'reveal the number').toBe(200);
    const shown = account.getByTestId('settlement-revealed');
    await expect(shown).toContainText(OWNER_A_ACCOUNT.number);
    await expect(shown).toContainText('in the audit log');
    await shown.getByRole('button', { name: 'Hide the number' }).click();
    await expect(page.locator('body')).not.toContainText(OWNER_A_ACCOUNT.number);
  });

  test('M4b review a change to where an owner’s rent goes waits for a second person; nothing changes at once', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.agencyAdmin.email);
    await openSettlement(page);
    const row = page.getByTestId('management-agreement').filter({ hasText: OWNER_B.name });
    await expect(row).toContainText('The agency’s client account');
    await row.getByRole('button', { name: /^Change/ }).click();
    const form = page.getByRole('form', { name: `Where ${OWNER_B.name}’s rent goes` });
    await expect(form).toContainText('nothing changes yet');
    await form.getByLabel('Rent goes to').selectOption({ label: 'The owner’s own account' });
    const asked = page.waitForResponse(
      (r) =>
        /\/api\/v1\/owners\/[0-9a-f-]{36}\/management-agreement$/.test(new URL(r.url()).pathname) &&
        r.request().method() === 'PUT',
    );
    await form.getByRole('button', { name: 'Ask for approval' }).click();
    expect((await asked).status(), 'ask to change where rent goes').toBe(200);
    await expect(page.getByText(`Asked for ${OWNER_B.name}’s rent to go to`)).toBeVisible();

    // Rent still goes where it did; the change waits, and no second one can be asked for.
    await expect(row.locator('td').nth(1)).toContainText('The agency’s client account');
    await expect(row.getByTestId('agreement-waiting')).toContainText(
      'Waiting for a second person: the owner’s own account from',
    );
    await expect(row.getByRole('button', { name: /^Change/ })).toHaveCount(0);

    // The request reads plainly in Approvals; she withdraws it, so the seed stays as it was.
    await nav(page).getByRole('link', { name: 'Approvals' }).click();
    const request = page
      .getByTestId('approval')
      .filter({ hasText: 'Change where an owner’s rent goes' })
      .filter({ hasText: OWNER_B.name });
    await expect(request).toHaveCount(1);
    await expect(request).toContainText('The agency’s client account');
    await expect(request).toContainText('The owner’s own account');
    await expect(request.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await request.getByRole('button', { name: 'Withdraw the request' }).click();
    await expect(page.getByText('Withdrew the request. Nothing changed.')).toBeVisible();
  });

  test('a manager sees the accounts but cannot ask to change where rent goes', async ({ page }) => {
    await signIn(page, PEOPLE.managerOne.email);
    await openSettlement(page);
    await expect(page.getByRole('button', { name: 'Add a bank account' })).toHaveCount(0);
    // Nor reveal a number: that is for owners and agency admins (settlement_account.reveal).
    await expect(page.getByRole('button', { name: /^Show the full number/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Ask to stop using it/ })).toHaveCount(0);
    await expect(
      page.getByTestId('management-agreements').getByRole('button', { name: /^(Change|Choose)/ }),
    ).toHaveCount(0);
  });
});
