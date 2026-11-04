import { expect, test } from '@playwright/test';
import { EXCEPTION_WORDS, type ExceptionKind } from '../lib/reconciliation';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';

/**
 * Plan 4.8 and CLAUDE.md section 8: what the nightly reconciliation cannot explain waits for a
 * person. The seed (plan 4.13) leaves one reconciliation exception: a payment the provider
 * verified for a different amount than was asked (`verified_amount_differs`). A manager reads it in plain
 * words and resolves it with a note; resolving changes no money. A retried run, finding it
 * already resolved, checks the resolved list instead.
 */
/** The seed's read-only adviser, scoped to Owner A (CLAUDE.md section 14). */
const ADVISER = 'adviser@demo.invalid';

interface ExceptionRow {
  readonly id: string;
  readonly kind: ExceptionKind;
  readonly resolvedAt: string | null;
}

test.describe('BC-02 and plan 4.8 reconciliation exceptions', () => {
  test('a manager reads an exception in plain words and resolves it with a note', async ({
    page,
  }) => {
    const note = `Checked with the provider’s dashboard (e2e ${unique()})`;
    await signIn(page, PEOPLE.managerOne.email);
    const all = (await (
      await page.request.get('/api/v1/reconciliation/exceptions')
    ).json()) as ExceptionRow[];
    expect(
      all.map((r) => r.kind),
      'the seeded reconciliation exception: run pnpm db:seed',
    ).toContain('verified_amount_differs');
    const open = all.filter((r) => r.resolvedAt === null);

    await nav(page).getByRole('link', { name: 'Reconciliation' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Reconciliation');
    const rows = page.getByTestId('reconciliation-exception');

    if (open.length) {
      const target = open[0]!;
      const words = EXCEPTION_WORDS[target.kind];
      await expect(rows).toHaveCount(open.length);
      const row = rows.filter({ hasText: words.title }).first();
      await expect(row).toContainText(words.check);
      await expect(row).toContainText('To look into');
      // The detail is for a manager: never a phone number or an account number.
      await expect(row).not.toContainText(/\+233\d{9}/);

      await row.getByRole('button', { name: /^Resolve/ }).click();
      const form = row.getByRole('form', { name: `Resolve: ${words.title}` });
      await ready(page, 'Mark it resolved');
      await form.getByRole('button', { name: 'Mark it resolved' }).click();
      await expect(form.getByText(/Give a reason of at least 5 characters/)).toBeVisible();
      await form.getByLabel('What you found').fill(note);
      await form.getByRole('button', { name: 'Mark it resolved' }).click();
      await expect(page.getByText(`Resolved: ${words.title.toLowerCase()}.`)).toBeVisible();
      await expect(rows).toHaveCount(open.length - 1);
    }

    // Resolved ones stay on record, with who-found-what in the note.
    await page.getByLabel('Show resolved ones too').check();
    await expect(page.getByTestId('exception-resolution').first()).toBeVisible();
    if (open.length)
      await expect(page.getByTestId('exception-resolution').filter({ hasText: note })).toHaveCount(
        1,
      );
  });

  test('an adviser reads billing but never reconciliation', async ({ page }) => {
    // An adviser may read invoices and arrears, not provider payments (plan 4.11).
    await signIn(page, ADVISER);
    await expect(nav(page).getByRole('link', { name: 'Arrears' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Reconciliation' })).toHaveCount(0);
    expect((await page.request.get('/api/v1/reconciliation/exceptions')).status()).toBe(403);
  });
});
