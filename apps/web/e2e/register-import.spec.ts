import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { nav, PEOPLE, ready, signIn } from './helpers';
import { fixture } from './register-helpers';

/**
 * Fixtures (apps/web/e2e/fixtures), written with write-excel-file to the template's columns:
 * - register-import-good.xlsx: IMP-E2E, a compound house for OWN-02 with units B1-01 to B1-03
 *   and one prepaid meter. Importing it again changes nothing, so every run can import it.
 * - register-import-malformed.xlsx: an unknown property type, an unknown owner, a bad GhanaPost
 *   code and a latitude out of range (row 2); a duplicate code with no name (row 3); a code
 *   that breaks the format and an unknown region (row 4); on the Units sheet an apartment
 *   without bedrooms, a duplicate unit and a property that does not exist.
 */
async function checkFile(page: Page, name: string) {
  await page.getByLabel('Filled-in template').setInputFiles(fixture(name));
  await page.getByRole('button', { name: 'Check the file' }).click();
  await expect(page.getByTestId('import-report')).toContainText(`File: ${name}`);
  await expect(page.getByTestId('import-status')).not.toHaveText(/Checking|Uploaded/, {
    timeout: 30_000,
  });
}

async function counts(page: Page, record: 'properties' | 'units') {
  const cells = page.getByTestId(`counts-${record}`).getByRole('cell');
  const read = async (i: number) => Number(await cells.nth(i).textContent());
  return { create: await read(0), update: await read(1), unchanged: await read(2) };
}

test.describe('PR-08 import', () => {
  test('the template downloads; a malformed sheet is refused row by row and writes nothing; a good sheet imports once', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    await nav(page).getByRole('link', { name: 'Import' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Import from a spreadsheet');
    await ready(page, 'Download the template');

    // The template is a real workbook.
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download the template' }).click();
    const template = await downloading;
    expect(template.suggestedFilename()).toBe('register-import-template.xlsx');
    const bytes = await readFile(await template.path());
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    // A malformed sheet: every problem by sheet, row and column, and no way to import it.
    await checkFile(page, 'register-import-malformed.xlsx');
    await expect(page.getByTestId('import-status')).toHaveText('Problems found');
    await expect(page.getByText('Nothing has been imported')).toBeVisible();
    const issues = page.getByTestId('import-issue');
    const expected: [string, string, string, RegExp][] = [
      ['Properties', '2', 'Property type', /Lists sheet/],
      ['Properties', '2', 'Owner reference', /No owner has the reference OWN-99/],
      ['Properties', '2', 'GhanaPost GPS', /GhanaPost GPS address/],
      ['Properties', '2', 'Latitude', /latitude/],
      ['Properties', '3', 'Property code', /IMP-BAD is already on row 2/],
      ['Properties', '3', 'Name', /Required/],
      ['Properties', '4', 'Region', /region/],
      ['Units', '2', 'Bedrooms', /Enter the bedrooms/],
      ['Units', '3', 'Unit', /IMP-BAD-B1-01 is already on row 2/],
      ['Units', '4', 'Property code', /NOPE-XX is not on the Properties sheet/],
    ];
    for (const [sheet, row, column, message] of expected) {
      const match = issues
        .filter({ has: page.getByRole('cell', { name: sheet, exact: true }) })
        .filter({ has: page.getByRole('cell', { name: row, exact: true }) })
        .filter({ has: page.getByRole('cell', { name: column, exact: true }) })
        .filter({ hasText: message });
      await expect(match, `${sheet} row ${row}, ${column}`).toHaveCount(1);
    }
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
    const none = await page.request.get('/api/v1/properties?search=IMP-BAD&includeArchived=true');
    expect(((await none.json()) as { rows: unknown[] }).rows).toHaveLength(0);

    // A good sheet passes the dry run, then imports.
    await checkFile(page, 'register-import-good.xlsx');
    await expect(page.getByTestId('import-status')).toHaveText('Checked: ready to import');
    await expect(page.getByText('No problems found.')).toBeVisible();
    const firstProperties = await counts(page, 'properties');
    const firstUnits = await counts(page, 'units');
    // A first run creates them; later runs find them unchanged (the database persists).
    expect(firstProperties.create + firstProperties.unchanged).toBe(1);
    expect(firstUnits.create + firstUnits.unchanged).toBe(3);
    expect(firstProperties.update + firstUnits.update).toBe(0);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByTestId('import-status')).toHaveText('Imported', { timeout: 30_000 });

    // The same file again changes nothing.
    await checkFile(page, 'register-import-good.xlsx');
    await expect(page.getByTestId('import-status')).toHaveText('Checked: ready to import');
    expect(await counts(page, 'properties')).toEqual({ create: 0, update: 0, unchanged: 1 });
    expect(await counts(page, 'units')).toEqual({ create: 0, update: 0, unchanged: 3 });

    // And the imported units are in the portfolio.
    await page.goto('/portfolio?q=IMP-E2E');
    const rows = page.getByTestId('unit-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('IMP-E2E-B1-01');
    await expect(rows.nth(0)).toContainText('Single room');
    await expect(rows.nth(2)).toContainText('IMP-E2E-B1-03');
    await expect(rows.nth(2)).toContainText('Nana Owner-Accra (demo)');
  });
});
