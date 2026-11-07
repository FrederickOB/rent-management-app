import { expect, test, type APIRequestContext, type Browser } from '@playwright/test';
import { money, toDecimal } from '@rent/domain/money';
import { bpsText } from '../lib/reporting';
import { PEOPLE, ready, signIn, unique } from './helpers';
import { fixture, OWNER_A, OWNER_B } from './register-helpers';
import { cedis } from './tax-helpers';

/**
 * M9 review round (WEB 7): stronger checks beside `m9-reporting.spec.ts`, which stays as it
 * passed. Absence is checked only once the lists have loaded; nothing is skipped silently; the
 * dashboard is compared with the API's own figures; the remittance form starts from the
 * suggestion, and the owner's cash is read only once background postings have settled.
 */

async function ok<T>(
  response: Awaited<ReturnType<APIRequestContext['get']>>,
  what: string,
): Promise<T> {
  expect(response.status(), `${what}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

async function ownerId(request: APIRequestContext, reference: string): Promise<string> {
  const owners = await ok<{ id: string; reference: string }[]>(
    await request.get('/api/v1/owners'),
    'list owners',
  );
  const found = owners.find((o) => o.reference === reference);
  if (!found) throw new Error(`No ${reference}: run pnpm db:seed`);
  return found.id;
}

/** As a manager: one of owner B's statements and one of her money records, both required. */
async function ownerBRecords(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await signIn(page, PEOPLE.managerOne.email);
    const b = await ownerId(page.request, 'OWN-02');
    const [statement] = await ok<{ id: string }[]>(
      await page.request.get(`/api/v1/owner-statements?ownerId=${b}`),
      'list owner B’s statements',
    );
    const [moneyRow] = await ok<{ id: string; hasProof: boolean }[]>(
      await page.request.get(`/api/v1/owner-money?ownerId=${b}`),
      'list owner B’s money',
    );
    expect(statement, 'owner B has a statement: run pnpm db:seed').toBeTruthy();
    expect(moneyRow, 'owner B has a money record: run pnpm db:seed').toBeTruthy();
    return { ownerB: b, statementId: statement!.id, moneyId: moneyRow!.id };
  } finally {
    await context.close();
  }
}

test.describe('AC-04 and AC-05 ★ an owner sees only their own, checked once the lists have loaded', () => {
  test('owner A’s lists load with her own rows, none of owner B’s, and owner B’s records are refused', async ({
    browser,
    baseURL,
  }) => {
    const b = await ownerBRecords(browser, baseURL);
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      await signIn(page, OWNER_A.email);

      await page.goto('/statements');
      // Loaded: her rows are there before anything is said about owner B's.
      await expect(page.getByText('Loading the statements…')).toHaveCount(0);
      await expect(page.getByTestId('statement-row').first()).toContainText(OWNER_A.name);
      await expect(page.getByTestId('statement-row').filter({ hasText: OWNER_B.name })).toHaveCount(
        0,
      );

      await page.goto('/owner-money');
      await expect(page.getByText('Loading the records…')).toHaveCount(0);
      const rows = page.getByTestId('owner-money-row');
      await expect(rows.first().or(page.getByText('Nothing recorded yet.'))).toBeVisible();
      await expect(rows.filter({ hasText: OWNER_B.name })).toHaveCount(0);

      // Always checked, never skipped.
      expect([403, 404]).toContain(
        (await page.request.get(`/api/v1/owner-statements/${b.statementId}`)).status(),
      );
      expect([403, 404]).toContain(
        (await page.request.get(`/api/v1/owner-money/${b.moneyId}/proof`)).status(),
      );
      expect([403, 404]).toContain(
        (await page.request.get(`/api/v1/owners/${b.ownerB}/remittance-suggestion`)).status(),
      );
    } finally {
      await context.close();
    }
  });
});

interface DashboardApi {
  readonly occupancy: { readonly rate: { readonly bps: number | null } };
  readonly collectionRate: { readonly rate: { readonly bps: number | null } };
  readonly paidUntilCoverage: { readonly rate: { readonly bps: number | null } };
  readonly arrears: { readonly totalMinor: number };
  readonly rentRoll: { readonly totalMinor: number };
  readonly unearnedRentMinor: number;
  readonly depositsHeldMinor: number;
  readonly expiries: readonly { readonly withinMonths: number; readonly leases: number }[];
}

test.describe('DA-01 ★ the dashboard shows the API’s own figures', () => {
  test('each figure on the screen equals the API’s', async ({ page }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const api = await ok<DashboardApi>(
      await page.request.get('/api/v1/dashboard'),
      'read the dashboard',
    );
    await page.goto('/');
    const dashboard = page.getByTestId('dashboard');
    const value = (figure: string) =>
      dashboard.getByTestId(`figure-${figure}`).getByTestId('figure-value');
    await expect(value('occupancy')).toHaveText(bpsText(api.occupancy.rate.bps));
    await expect(value('collection')).toHaveText(bpsText(api.collectionRate.rate.bps));
    await expect(value('paid-until')).toHaveText(bpsText(api.paidUntilCoverage.rate.bps));
    await expect(value('arrears')).toHaveText(cedis(api.arrears.totalMinor));
    await expect(value('rent-roll')).toHaveText(cedis(api.rentRoll.totalMinor));
    await expect(value('unearned')).toHaveText(cedis(api.unearnedRentMinor));
    await expect(value('deposits')).toHaveText(cedis(api.depositsHeldMinor));
    for (const e of api.expiries)
      await expect(
        dashboard.getByTestId(`expiry-${e.withinMonths}`).locator('td').nth(1),
      ).toHaveText(String(e.leases));
  });
});

interface Suggestion {
  readonly agentCashMinor: number;
  readonly netMinor: number;
  readonly feesRetainedMinor: number;
}

/** The suggestion once two reads a second apart agree: background postings have settled. */
async function settledSuggestion(request: APIRequestContext, owner: string): Promise<Suggestion> {
  let last = await ok<Suggestion>(
    await request.get(`/api/v1/owners/${owner}/remittance-suggestion`),
    'read the suggestion',
  );
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const next = await ok<Suggestion>(
      await request.get(`/api/v1/owners/${owner}/remittance-suggestion`),
      'read the suggestion',
    );
    if (next.agentCashMinor === last.agentCashMinor && next.netMinor === last.netMinor) return next;
    last = next;
  }
  throw new Error('The owner’s cash kept moving: something is still posting');
}

test.describe('AC-05 ★ the remittance form starts from the suggestion', () => {
  test('the prefill is the suggestion, and the owner’s cash falls by exactly what was paid', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    // Owner B: the seed leaves money remittable for her (owner A's is held back for GRA).
    const owner = await ownerId(page.request, 'OWN-02');
    const before = await settledSuggestion(page.request, owner);
    expect(
      before.netMinor,
      'the agency holds money to pay owner B: run pnpm db:seed',
    ).toBeGreaterThan(0);

    await page.goto(`/owner-money?ownerId=${owner}`);
    await ready(page, 'Record a remittance');
    await page.getByRole('button', { name: 'Record a remittance' }).click();
    const form = page.getByRole('form', { name: 'Record a remittance' });
    // The form is filled from the suggestion, as the API worked it out.
    await expect(form.getByLabel('Paid to the owner (GH₵)')).toHaveValue(
      toDecimal(money(before.netMinor)),
    );
    await expect(form.getByLabel('Fees retained (GH₵)')).toHaveValue(
      toDecimal(money(before.feesRetainedMinor)),
    );

    const net = Math.min(before.netMinor, 10_000);
    await form.getByLabel('Paid to the owner (GH₵)').fill(toDecimal(money(net)));
    await form.getByLabel('Fees retained (GH₵)').fill('0.00');
    await form.getByLabel('How it was paid').selectOption({ label: 'Mobile money' });
    await form.getByLabel('Reference').fill(`REM-REVIEW-${unique()}`);
    await form
      .getByLabel('Proof of the transfer (required)')
      .setInputFiles(fixture('property-photo.jpg'));
    await form.getByRole('button', { name: 'Record the remittance' }).click();
    await expect(page.getByText(`Recorded ${cedis(net)} paid to`)).toBeVisible();

    const after = await settledSuggestion(page.request, owner);
    expect(after.agentCashMinor).toBe(before.agentCashMinor - net);
  });
});
