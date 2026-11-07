import { expect, test, type APIRequestContext, type Browser } from '@playwright/test';
import { money, toDecimal } from '@rent/domain/money';
import { PEOPLE, ready, signIn, unique } from './helpers';
import { fixture, OWNER_A, OWNER_B } from './register-helpers';
import { cedis } from './tax-helpers';
import { today } from './tenancy-helpers';

/**
 * M9 (plan 6, ★ that the web can prove): a statement issued and worked out again gives the issued
 * figures; an owner's user sees only their own statements and remittances; a remittance with
 * proof reduces the suggestion (owner B, OWN-02, whom the seed leaves money to be paid); the
 * dashboard shows its figures and its Excel export downloads.
 * They use the seed's agency (OWN-01 and OWN-02) and its last month's statements (plan 4.10).
 */

async function ok<T>(
  response: Awaited<ReturnType<APIRequestContext['get']>>,
  what: string,
): Promise<T> {
  expect(response.status(), `${what}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

interface Owner {
  readonly id: string;
  readonly reference: string;
}
interface Statement {
  readonly id: string;
  readonly owner: { readonly id: string };
  readonly month: string;
  readonly status: 'draft' | 'issued';
}

async function ownerByReference(request: APIRequestContext, reference: string): Promise<Owner> {
  const owners = await ok<Owner[]>(await request.get('/api/v1/owners'), 'list owners');
  const found = owners.find((o) => o.reference === reference);
  if (!found) throw new Error(`No ${reference}: run pnpm db:seed`);
  return found;
}

/** The last twelve months before this one, newest first. */
function pastMonths(): string[] {
  const [y, m] = today().slice(0, 7).split('-').map(Number) as [number, number];
  const months: string[] = [];
  for (let i = 1; i <= 12; i += 1) {
    const index = y * 12 + (m - 1) - i;
    months.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`);
  }
  return months;
}

test.describe('AC-04 ★ a statement worked out again gives the issued figures', () => {
  test('a manager drafts a past month, issues it behind the confirmation, and the issued statement still matches', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const owner = await ownerByReference(page.request, 'OWN-01');
    const issued = new Set(
      (
        await ok<Statement[]>(
          await page.request.get(`/api/v1/owner-statements?ownerId=${owner.id}&status=issued`),
          'list issued statements',
        )
      ).map((s) => s.month),
    );
    const month = pastMonths().find((m) => !issued.has(m));
    if (!month)
      throw new Error('Every month of the last year is issued for OWN-01: run pnpm db:seed');

    const drafted = await ok<{ id: string }>(
      await page.request.post('/api/v1/owner-statements', { data: { ownerId: owner.id, month } }),
      'draft the statement',
    );
    await page.goto(`/statements/${drafted.id}`);
    await expect(page.getByTestId('statement-status')).toHaveText('Draft');
    await expect(page.getByTestId('statement-summary')).toBeVisible();
    await expect(page.getByTestId('failing-checks')).toHaveCount(0);

    await ready(page, 'Issue the statement');
    await page.getByRole('button', { name: 'Issue the statement' }).click();
    await expect(page.getByTestId('issue-confirm')).toContainText('Issuing locks');
    await page.getByRole('button', { name: 'Issue and lock the month' }).click();
    await expect(page.getByTestId('statement-status')).toHaveText('Issued');

    // Opened again, the month is worked out afresh from the ledger and compared with the issue.
    await page.reload();
    await expect(page.getByTestId('matches-issued')).toHaveAttribute('data-matches', 'true');
    const again = await ok<{
      matchesIssued: boolean | null;
      actions: { issue: boolean; regenerate: boolean };
    }>(
      await page.request.get(`/api/v1/owner-statements/${drafted.id}`),
      'read the issued statement',
    );
    expect(again.matchesIssued).toBe(true);
    expect(again.actions).toEqual({ issue: false, regenerate: false });
    // It cannot be drafted again.
    const refused = await page.request.post('/api/v1/owner-statements', {
      data: { ownerId: owner.id, month },
    });
    expect(refused.status()).toBe(409);
  });
});

/** As a manager: owner B's statements and money, to try reading as owner A. */
async function ownerBRecords(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await signIn(page, PEOPLE.managerOne.email);
    const b = await ownerByReference(page.request, 'OWN-02');
    const statements = await ok<Statement[]>(
      await page.request.get(`/api/v1/owner-statements?ownerId=${b.id}`),
      'list owner B’s statements',
    );
    const moneyRows = await ok<{ id: string }[]>(
      await page.request.get(`/api/v1/owner-money?ownerId=${b.id}`),
      'list owner B’s money',
    );
    return {
      ownerB: b.id,
      statementId: statements[0]?.id ?? null,
      moneyId: moneyRows[0]?.id ?? null,
    };
  } finally {
    await context.close();
  }
}

test.describe('AC-04 and AC-05 ★ an owner sees only their own statements and remittances', () => {
  test('owner A’s user lists only their own, and owner B’s are refused', async ({
    browser,
    baseURL,
  }) => {
    const b = await ownerBRecords(browser, baseURL);
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      await signIn(page, OWNER_A.email);
      const statements = await ok<Statement[]>(
        await page.request.get('/api/v1/owner-statements'),
        'list statements',
      );
      expect(statements.length, 'owner A has statements: run pnpm db:seed').toBeGreaterThan(0);
      const mine = new Set(statements.map((s) => s.owner.id));
      expect(mine.size).toBe(1);
      expect(mine.has(b.ownerB)).toBe(false);
      const moneyRows = await ok<{ owner: { id: string } }[]>(
        await page.request.get('/api/v1/owner-money'),
        'list money',
      );
      expect(moneyRows.every((r) => mine.has(r.owner.id))).toBe(true);

      await page.goto('/statements');
      await expect(page.getByTestId('statement-row').first()).toBeVisible();
      await expect(page.getByTestId('statement-row').filter({ hasText: OWNER_B.name })).toHaveCount(
        0,
      );
      // Read-only: no drafting, and no recording money.
      await expect(page.getByRole('form', { name: 'Draft a statement' })).toHaveCount(0);
      await page.goto('/owner-money');
      await expect(page.getByRole('button', { name: 'Record a remittance' })).toHaveCount(0);
      await expect(
        page.getByTestId('owner-money-row').filter({ hasText: OWNER_B.name }),
      ).toHaveCount(0);

      if (b.statementId) {
        const other = await page.request.get(`/api/v1/owner-statements/${b.statementId}`);
        expect([403, 404]).toContain(other.status());
      }
      if (b.moneyId) {
        const proof = await page.request.get(`/api/v1/owner-money/${b.moneyId}/proof`);
        expect([403, 404]).toContain(proof.status());
      }
      const suggestion = await page.request.get(`/api/v1/owners/${b.ownerB}/remittance-suggestion`);
      expect([403, 404]).toContain(suggestion.status());
    } finally {
      await context.close();
    }
  });
});

interface Suggestion {
  readonly agentCashMinor: number;
  readonly netMinor: number;
  readonly feesRetainedMinor: number;
}

test.describe('AC-05 ★ a remittance with proof reduces the suggestion', () => {
  test('a manager records a remittance from the suggested figures with its proof, and the next suggestion is lower', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    // Owner B (OWN-02): the seed leaves money remittable for her, and the run's receipts only add
    // to it. Owner A's agent cash is all held back for the rent tax the agency pays for her.
    const owner = await ownerByReference(page.request, 'OWN-02');
    const before = await ok<Suggestion>(
      await page.request.get(`/api/v1/owners/${owner.id}/remittance-suggestion`),
      'read the suggestion',
    );
    expect(
      before.netMinor,
      'the agency holds money to pay owner B: run pnpm db:seed',
    ).toBeGreaterThan(0);
    const net = Math.min(before.netMinor, 10_000);

    await page.goto(`/owner-money?ownerId=${owner.id}`);
    await ready(page, 'Record a remittance');
    await page.getByRole('button', { name: 'Record a remittance' }).click();
    const form = page.getByRole('form', { name: 'Record a remittance' });
    await expect(form.getByTestId('suggestion-net')).toHaveText(cedis(before.netMinor));
    await form.getByLabel('Paid to the owner (GH₵)').fill(toDecimal(money(net)));
    await form.getByLabel('Fees retained (GH₵)').fill('0');
    await form.getByLabel('How it was paid').selectOption({ label: 'Bank transfer' });
    const reference = `REM-${unique()}`;
    await form.getByLabel('Reference').fill(reference);
    // Without the proof, nothing is sent.
    await form.getByRole('button', { name: 'Record the remittance' }).click();
    await expect(form).toContainText('Attach the proof of the transfer.');
    await form
      .getByLabel('Proof of the transfer (required)')
      .setInputFiles(fixture('title-deed.pdf'));
    await form.getByRole('button', { name: 'Record the remittance' }).click();
    await expect(page.getByText(`Recorded ${cedis(net)} paid to`)).toBeVisible();
    const row = page.getByTestId('owner-money-row').filter({ hasText: reference });
    await expect(row.getByTestId('owner-money-amount')).toHaveText(cedis(net));
    await expect(row.getByRole('button', { name: 'Open the proof' })).toBeVisible();

    const after = await ok<Suggestion>(
      await page.request.get(`/api/v1/owners/${owner.id}/remittance-suggestion`),
      'read the suggestion again',
    );
    expect(after.agentCashMinor).toBe(before.agentCashMinor - net);
    expect(after.netMinor).toBeLessThan(before.netMinor);
  });
});

test.describe('DA-01 and DA-06 ★ the dashboard shows its figures and exports to Excel', () => {
  test('a manager sees the figures with their date and time, and the Excel export downloads', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    await page.goto('/');
    const dashboard = page.getByTestId('dashboard');
    await expect(dashboard).toBeVisible();
    await expect(dashboard.getByTestId('dashboard-as-of')).toContainText('Figures as of');
    for (const figure of [
      'occupancy',
      'collection',
      'arrears',
      'rent-roll',
      'unearned',
      'deposits',
      'paid-until',
    ])
      await expect(
        dashboard.getByTestId(`figure-${figure}`).getByTestId('figure-value'),
      ).not.toHaveText('');
    await expect(dashboard.getByTestId('figure-occupancy').getByTestId('figure-value')).toHaveText(
      /%$|^—$/,
    );
    await expect(dashboard.getByTestId('expiry-3')).toBeVisible();

    // The figures reconcile with the API's, as shown.
    const api = await ok<{ arrears: { totalMinor: number }; depositsHeldMinor: number }>(
      await page.request.get('/api/v1/dashboard'),
      'read the dashboard',
    );
    await expect(dashboard.getByTestId('figure-arrears').getByTestId('figure-value')).toHaveText(
      cedis(api.arrears.totalMinor),
    );
    await expect(dashboard.getByTestId('figure-deposits').getByTestId('figure-value')).toHaveText(
      cedis(api.depositsHeldMinor),
    );

    // Excel: the export downloads its file, and the dashboard stays.
    await ready(page, 'Export to Excel');
    const download = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Export to Excel' }).click();
    expect((await download).suggestedFilename()).toBe('dashboard.xlsx');
    await expect(page.getByTestId('dashboard')).toBeVisible();

    // And the file itself is an Excel workbook (a zip, so it starts with PK).
    const exported = await ok<{ status: string; url: string | null }>(
      await page.request.post('/api/v1/dashboard/exports', { data: { format: 'xlsx' } }),
      'export to Excel',
    );
    expect(exported.status).toBe('ready');
    const file = await fetch(exported.url!);
    expect(file.ok).toBe(true);
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('PK');
  });
});
