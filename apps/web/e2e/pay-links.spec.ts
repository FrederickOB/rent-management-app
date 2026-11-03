import { expect, test } from '@playwright/test';
import { leaseIdByUnit } from './billing-helpers';
import { nav, PEOPLE, signIn } from './helpers';
import { smsIds, FAKE_PROVIDERS } from './register-helpers';

/**
 * BC-04 and BC-09 from staff screens (M4b plan 4.3 and 4.7). Kofi Arrears-45 (the seed) rents
 * ACC-LEG-B2-01 from Owner A, has open invoices and agreed to SMS; Owner A's rent has an account
 * to settle into. A manager sends him a pay link: it goes by SMS, and the link itself is never
 * shown on the staff screen. The company's reminder ladder reads in words on its settings.
 */
const KOFI = { unit: 'ACC-LEG-B2-01', phone: '+233200000036' };
/** Paid to the end of its two-year term through the pay page, in the seed. */
const PAID_AHEAD = 'ACC-ELG-B1-06';

async function newSms(
  request: Parameters<typeof smsIds>[0],
  phone: string,
  seen: ReadonlySet<string>,
): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await request.get(
      `${FAKE_PROVIDERS}/messages?channel=sms&to=${encodeURIComponent(phone)}`,
    );
    const fresh = ((await response.json()) as { id: string; body: string }[]).find(
      (m) => !seen.has(m.id),
    );
    if (fresh) return fresh.body;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('No SMS reached the fake provider');
}

test.describe('BC-04 staff send a pay link', () => {
  test('from the lease page, which says before anyone tries that a link can go: it goes by SMS and its link is never shown to staff', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const leaseId = await leaseIdByUnit(page, KOFI.unit);
    // The API answers for the lease first (plan 4.2): Owner A's rent has an account, Kofi agreed to SMS.
    const billing = (await (
      await page.request.get(`/api/v1/leases/${leaseId}/billing`)
    ).json()) as { payLink?: { available: boolean; invoiceId: string | null } };
    expect(billing.payLink?.available, 'a pay link can go to Kofi: run pnpm db:seed').toBe(true);
    await page.goto(`/leases/${leaseId}`);
    const section = page.getByTestId('money-pay-link');
    await expect(section).toContainText('the oldest invoice still to pay');
    await expect(section.getByTestId('pay-link-unavailable')).toHaveCount(0);
    const seen = await smsIds(page.request, KOFI.phone);

    const sent = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/v1/invoices/${billing.payLink!.invoiceId}/pay-link` &&
        r.request().method() === 'POST',
    );
    await section.getByRole('button', { name: /^Send a pay link/ }).click();
    expect((await sent).status(), 'send the pay link for the oldest invoice still to pay').toBe(
      200,
    );
    await expect(section.getByTestId('pay-link-outcome')).toHaveText(
      'Pay link sent by SMS. It works until the invoice is paid, or for 60 days.',
    );
    const body = await newSms(page.request, KOFI.phone, seen);
    expect(body).toMatch(/https?:\/\/\S+/);
    // The token belongs to the tenant: it is in the SMS, never on the staff screen.
    const link = /https?:\/\/\S+/.exec(body)![0];
    await expect(page.locator('body')).not.toContainText(link);
  });

  test('a lease with nothing to pay says so instead of offering a link', async ({ page }) => {
    await signIn(page, PEOPLE.managerOne.email);
    await page.goto(`/leases/${await leaseIdByUnit(page, PAID_AHEAD)}`);
    const section = page.getByTestId('money-pay-link');
    await expect(section.getByTestId('pay-link-unavailable')).toHaveText(
      'Nothing is left to pay on this lease now.',
    );
    await expect(section.getByRole('button', { name: /^Send a pay link/ })).toHaveCount(0);
  });

  test('from the invoice page too', async ({ page }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const leaseId = await leaseIdByUnit(page, KOFI.unit);
    const open = (await (
      await page.request.get(`/api/v1/invoices?leaseId=${leaseId}&status=issued`)
    ).json()) as { id: string; number: string }[];
    expect(open.length, 'an open invoice on ACC-LEG-B2-01: run pnpm db:seed').toBeGreaterThan(0);
    await page.goto(`/invoices/${open[0]!.id}`);
    const send = page.getByTestId('send-pay-link');
    await send.getByRole('button', { name: /^Send a pay link/ }).click();
    await expect(send.getByTestId('pay-link-outcome')).toContainText('Pay link sent by SMS.');
  });
});

test.describe('BC-09 the reminder ladder in company settings', () => {
  test('the company’s reminder days read as tenants will get them', async ({ page }) => {
    await signIn(page, PEOPLE.agencyAdmin.email);
    await nav(page).getByRole('link', { name: 'Company settings' }).click();
    const ladder = page.getByTestId('reminder-ladder');
    // The seed keeps the PRD's defaults: -7, 0, 3, 7 and 14 days.
    await expect(ladder).toContainText(
      '7 days before the due date, on the due date, and 3, 7 and 14 days after it',
    );
    await expect(ladder).toContainText('stop as soon as the invoice is paid');
    // Typing a new ladder rewords it before anything is saved.
    await page.getByLabel('Rent reminders (days from the due date)').fill('-3, 0, 5');
    await expect(ladder).toContainText(
      '3 days before the due date, on the due date, and 5 days after it',
    );
  });
});
