import { expect, test } from '@playwright/test';
import { money, toDecimal } from '@rent/domain/money';
import { formatBusinessDate } from '../lib/business-dates';
import { READ_ONLY_TEXT } from '../lib/errors';
import { firstOfNextMonth, SUBSCRIPTION_MESSAGES } from '../lib/subscription';
import { nav, ready, unique } from './helpers';
import {
  firstAdmin,
  forceInvoice,
  invitationToken,
  ok,
  onboard,
  payByCard,
  PLATFORM_ADMIN,
  platformAdmin,
  recordCash,
  tenancyIn,
} from './subscription-support';
import { cedis } from './tax-helpers';
import { today } from './tenancy-helpers';

/**
 * M10 plan section 6, end to end (web): subscription billing and the platform admin console.
 * Every test onboards its own company, so none depends on the seed's subscriptions or on an
 * earlier run. What they rely on (the API's invoice test control, platform charges on the fake
 * provider, the invitation email, the platform admin's account) is listed at the top of
 * `subscription-support.ts`. More of section 6 is in `m10-subscription-more.spec.ts`.
 */

test.describe.configure({ timeout: 300_000 });

test.describe('PB-07 a subscriber pays by card and gets the receipt', () => {
  test('an open invoice is paid by card on the fake provider; the invoice shows paid and the receipt lists it, with its PDF', async ({
    browser,
    baseURL,
  }) => {
    const platform = await platformAdmin(browser, baseURL);
    const company = await onboard(platform.page, { kind: 'agency', tier: 'growth', trialDays: 0 });
    const admin = await firstAdmin(browser, baseURL, company);
    try {
      const invoice = await forceInvoice(platform.page, company.companyId, 0);
      const page = admin.page;
      await page.goto('/settings/subscription');
      const row = page.getByTestId('subscription-invoice-row').filter({ hasText: invoice.number });
      await expect(row.getByTestId('subscription-invoice-state')).toHaveText(
        `${cedis(invoice.totalMinor)} to pay`,
      );

      await payByCard(page);

      await expect(row.getByTestId('subscription-invoice-state')).toHaveText('Paid');
      const receipt = page
        .getByTestId('subscription-receipt-row')
        .filter({ hasText: invoice.number });
      await expect(receipt).toHaveCount(1);
      await expect(receipt).toContainText(/SUBR-\d{4}-\d{6}/);
      await expect(receipt).toContainText(cedis(invoice.totalMinor));
      await expect(receipt).toContainText('Card');
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        receipt.getByRole('button', { name: 'Download' }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/\.pdf$/i);

      // The API agrees: the receipt covers the invoice, and nothing is left open.
      const receipts = await ok<{ invoiceNumbers: string[]; amountMinor: number }[]>(
        await page.request.get('/api/v1/subscription/receipts'),
        'list the receipts',
      );
      expect(receipts.find((r) => r.invoiceNumbers.includes(invoice.number))?.amountMinor).toBe(
        invoice.totalMinor,
      );
      const subscription = await ok<{ arrears: unknown; actions: { pay: boolean } }>(
        await page.request.get('/api/v1/subscription'),
        'read the subscription',
      );
      expect(subscription.arrears).toBeNull();
    } finally {
      await admin.context.close();
      await platform.context.close();
    }
  });
});

test.describe('PB-05 changing tier', () => {
  test('an upgrade takes effect at once, says this month’s invoice charges each plan for its days, and unlocks Growth’s features', async ({
    browser,
    baseURL,
  }) => {
    const platform = await platformAdmin(browser, baseURL);
    const company = await onboard(platform.page, { kind: 'landlord', tier: 'starter' });
    await platform.context.close();
    const admin = await firstAdmin(browser, baseURL, company);
    try {
      const page = admin.page;
      await page.goto('/settings/subscription');
      await expect(page.getByTestId('subscription-tier')).toHaveText('Starter');
      const inbox = page.getByTestId('plan-feature').filter({ hasText: 'The inbox' });
      await expect(inbox).toContainText('Growth includes it');
      await expect(nav(page).getByRole('link', { name: 'Inbox' })).toHaveCount(0);

      const growth = page.getByTestId('tier-option').filter({ hasText: 'Growth' });
      await growth.getByRole('button', { name: 'Move to Growth' }).click();
      const confirm = page.getByRole('group', { name: 'Confirm the move to Growth' });
      const proration = 'Growth starts now. This month’s invoice charges each tier for its days.';
      await expect(confirm).toContainText(proration);
      await confirm.getByRole('button', { name: 'Move to Growth' }).click();

      await expect(page.getByText(proration).first()).toBeVisible();
      await expect(page.getByTestId('subscription-tier')).toHaveText('Growth');
      await expect(inbox).toContainText('Included');
      // The company's features follow the plan at once: the inbox is in the menu, without a
      // reload (review WEB-2).
      await expect(nav(page).getByRole('link', { name: 'Inbox' })).toBeVisible();
      const subscription = await ok<{ tier: string; pendingTier: unknown }>(
        await page.request.get('/api/v1/subscription'),
        'read the subscription',
      );
      expect(subscription).toMatchObject({ tier: 'growth', pendingTier: null });
    } finally {
      await admin.context.close();
    }
  });
});

test.describe('PB-11 an unpaid subscription goes read-only for staff, never for tenants', () => {
  test('the banner shows, a staff change is refused in plain words, cash is still recorded, and paying lifts it at once', async ({
    browser,
    baseURL,
  }) => {
    const platform = await platformAdmin(browser, baseURL);
    const company = await onboard(platform.page, { kind: 'agency', tier: 'growth', trialDays: 0 });
    const admin = await firstAdmin(browser, baseURL, company);
    try {
      const page = admin.page;
      // A tenancy made while the company still has full access.
      const { leaseId, tenantName } = await tenancyIn(page);
      // An invoice due 15 days ago: past the 14 days' grace, so the company is read-only (A1).
      await forceInvoice(platform.page, company.companyId, 15);

      await page.goto('/');
      const banner = page.getByTestId('subscription-banner');
      await expect(banner).toHaveAttribute('data-tone', 'error');
      await expect(banner).toContainText('Your company is read-only for staff.');
      await expect(banner).toContainText('Tenants are not affected');
      await expect(banner.getByTestId('subscription-banner-action')).toHaveText('Pay now');

      // A staff change is refused, in words.
      await page.goto('/owners');
      await page.getByRole('button', { name: 'Add an owner' }).click();
      const add = page.getByRole('form', { name: 'Add owner' });
      await add.getByLabel('Name', { exact: true }).fill(`Refused Owner ${unique()} (e2e)`);
      await add.getByRole('button', { name: 'Add owner' }).click();
      await expect(add.getByRole('alert')).toHaveText(READ_ONLY_TEXT);
      const refused = await page.request.post('/api/v1/owners', {
        data: { kind: 'individual', displayName: `Refused Owner ${unique()} (e2e)` },
      });
      expect(refused.status()).toBe(403);
      expect(((await refused.json()) as { code?: string }).code?.toUpperCase()).toBe(
        'SUBSCRIPTION_READ_ONLY',
      );

      // Money from tenants is still recorded: cash on the lease waits for a second person.
      const cash = await recordCash(page, leaseId, tenantName);
      expect(cash.status(), `record cash while read-only: ${await cash.text()}`).toBe(200);

      // Paying restores full access at once: the banner lifts on the same page (review WEB-2).
      await page.goto('/settings/subscription');
      await expect(page.getByTestId('subscription-banner')).toHaveCount(1);
      await payByCard(page);
      await expect(page.getByTestId('subscription-banner')).toHaveCount(0);
      const profile = await ok<{ subscription: { access: string } | null }>(
        await page.request.get('/api/v1/company'),
        'read the company',
      );
      expect(profile.subscription?.access).toBe('full');
      await page.goto('/owners');
      const name = `Allowed Owner ${unique()} (e2e)`;
      await page.getByRole('button', { name: 'Add an owner' }).click();
      const again = page.getByRole('form', { name: 'Add owner' });
      await again.getByLabel('Name', { exact: true }).fill(name);
      await again.getByRole('button', { name: 'Add owner' }).click();
      await expect(page.getByText(`Added ${name} as OWN-`)).toBeVisible();
    } finally {
      await admin.context.close();
      await platform.context.close();
    }
  });
});

test.describe('AD-10 support access needs the customer’s consent', () => {
  test('refused without a grant, granted by the company’s admin, used read-only by the platform admin, each request listed, and ended', async ({
    browser,
    baseURL,
  }) => {
    const platform = await platformAdmin(browser, baseURL);
    const company = await onboard(platform.page, { kind: 'agency', tier: 'starter' });
    const admin = await firstAdmin(browser, baseURL, company);
    try {
      const support = platform.page;
      // No grant: no view, by the API and on the screen.
      expect(
        (await support.request.get(`/api/v1/platform/support/${company.companyId}`)).status(),
      ).toBe(403);
      await support.goto(`/platform/support/${company.companyId}`);
      // The app's alert, not Next's route announcer (review WEB-3).
      await expect(support.locator('main').getByRole('alert')).toContainText(
        SUBSCRIPTION_MESSAGES.SUPPORT_NO_GRANT!,
      );

      // The company's admin grants two hours, for a reason.
      const page = admin.page;
      await page.goto('/settings/subscription');
      const card = page.getByTestId('support-access');
      const grant = card.getByRole('form', { name: 'Grant support access' });
      await ready(page, 'Grant read-only access');
      const reason = `Check the November invoices ${unique()}`;
      await grant.getByLabel('Why support needs access').fill(reason);
      await grant.getByLabel('For how many hours').fill('2');
      await grant.getByRole('button', { name: 'Grant read-only access' }).click();
      await expect(card.getByText(/^Support can read the company until /)).toBeVisible();

      // The platform admin opens the company read-only, under the grant.
      await support.goto('/platform/support');
      const listed = support.getByTestId('support-company').filter({ hasText: company.name });
      await expect(listed).toContainText(reason);
      await listed.getByRole('link', { name: 'Open read-only' }).click();
      await expect(
        support.getByRole('heading', { name: `${company.name}, read-only` }),
      ).toBeVisible();
      await expect(support.getByTestId('support-overview')).toBeVisible();
      await expect(support.getByText('You can read, not change')).toBeVisible();

      // The company sees the request, with who made it.
      await page.reload();
      const item = page.getByTestId('support-grant').filter({ hasText: reason });
      await expect(item).toContainText('Active');
      await expect(item.getByRole('table')).toContainText(PLATFORM_ADMIN.name);

      // Ended early: support is refused again at once.
      await item.getByRole('button', { name: 'End this access now' }).click();
      await expect(card.getByText('Support access ended.')).toBeVisible();
      await expect(item).toContainText('Ended');
      expect(
        (await support.request.get(`/api/v1/platform/support/${company.companyId}`)).status(),
      ).toBe(403);
    } finally {
      await admin.context.close();
      await platform.context.close();
    }
  });
});

test.describe('AD-10 the platform admin onboards a company and sets next month’s prices', () => {
  test('a company is created on a trial with its admin invited, and a price list is added from the 1st of next month', async ({
    browser,
    baseURL,
  }) => {
    const platform = await platformAdmin(browser, baseURL);
    try {
      const page = platform.page;
      const tag = unique();
      const name = `M10 Onboarded ${tag} (e2e)`;
      const email = `m10.onboarded.${tag.toLowerCase()}@demo.invalid`;

      await page.goto('/platform/companies');
      await page.getByRole('button', { name: 'Onboard a company' }).click();
      const form = page.getByRole('form', { name: 'Onboard a company' });
      await form.getByLabel('Kind').selectOption('agency');
      await form.getByLabel('Name', { exact: true }).fill(name);
      await form.getByLabel('Plan').selectOption('growth');
      await form.getByLabel('Free trial in days (optional)').fill('30');
      await form.getByLabel('First admin’s name').fill(`Kweku Admin ${tag} (e2e)`);
      await form.getByLabel('First admin’s email').fill(email);
      await form.getByRole('button', { name: 'Create the company' }).click();

      await expect(page).toHaveURL(/\/platform\/companies\/[0-9a-f-]{36}\?created=1$/);
      await expect(
        page.getByText('Created. Its first admin has been invited by email.'),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name })).toBeVisible();
      await expect(page.getByTestId('platform-company-tier')).toHaveText('Growth');
      await expect(page.getByText('Free trial', { exact: true })).toBeVisible();
      expect(await invitationToken(email)).not.toBe('');
      await page.goto('/platform/companies');
      await expect(page.getByTestId('platform-company-row').filter({ hasText: name })).toHaveCount(
        1,
      );

      // New Portfolio prices from the 1st of next month. This adds a global price list row, which
      // stays (rows are never edited); a single-room rate unique to the run, from the clock,
      // finds this run's row among the earlier runs' (review WEB-13).
      const from = firstOfNextMonth(today());
      const rateMinor = 1_000_000 + (Date.now() % 9_000_000);
      const typed = toDecimal(money(rateMinor));
      await page.goto('/platform/billing');
      await page.getByRole('button', { name: 'Add new prices' }).click();
      const prices = page.getByRole('form', { name: 'New prices for a plan' });
      await prices.getByLabel('Plan').selectOption('portfolio');
      // Review WEB-9: the form offers the 1st of a month only.
      await prices.getByLabel('From', { exact: true }).selectOption(from);
      await prices.getByLabel('Single room: GH₵ a unit a month').fill(typed);
      await prices.getByLabel('Self-contained flat or house: GH₵ a unit a month').fill('23');
      await prices.getByLabel('Commercial: GH₵ a unit a month').fill('46');
      await prices.getByLabel('Monthly minimum (GH₵)').fill('410');
      await prices.getByLabel('Discount for paying a year ahead (%)').fill('10');
      await prices.getByRole('button', { name: 'Add the prices' }).click();
      await expect(
        page.getByText(`Portfolio’s new prices start on ${formatBusinessDate(from)}.`),
      ).toBeVisible();
      const added = page
        .getByTestId('price-list-tier')
        .filter({ hasText: 'Portfolio' })
        .getByTestId('price-list')
        .filter({ hasText: `Single room: ${cedis(rateMinor)} a unit a month` });
      await expect(added).toHaveCount(1);
      await expect(added).toContainText(`From ${formatBusinessDate(from)}`);
      await expect(added).toContainText('From a future date');
      await expect(added).toContainText('At least GH₵410.00 a month');
    } finally {
      await platform.context.close();
    }
  });
});
