import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';

test.describe('TL-05 lease templates', () => {
  test('an admin starts a template from a starter, publishes a new version and records the counsel review', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Short let ${tag} (e2e)`;
    await signIn(page, PEOPLE.agencyAdmin.email);
    await nav(page).getByRole('link', { name: 'Lease templates' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lease templates');
    await ready(page, 'New template');
    await page.getByRole('button', { name: 'New template' }).click();
    const create = page.getByRole('form', { name: 'New template' });
    await create.getByLabel('Name').fill(name);
    await create.getByLabel('Kind').selectOption({ label: 'Short fixed term' });
    await create
      .getByLabel('Start from')
      .selectOption({ label: 'Residential tenancy agreement (starter) (version 1)' });
    await create.getByRole('button', { name: 'Create template' }).click();

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page.getByText('Version 1 not reviewed by counsel')).toBeVisible();
    await ready(page, 'Record the counsel review of version 1');
    await expect(page.getByRole('button', { name: 'Publish version 2' })).toBeDisabled();

    // Required clauses stay, and wording that comes from the lease's data cannot be edited here.
    const rent = page
      .getByTestId('template-clause')
      .filter({ hasText: 'Wording fixed' })
      .filter({
        has: page.getByRole('heading', { name: 'Rent', exact: true }),
      });
    await expect(rent).toContainText('Required');
    await expect(rent.getByRole('textbox')).toHaveCount(0);
    await expect(rent.getByRole('button', { name: /^Remove/ })).toHaveCount(0);

    // An editable clause: a placeholder that is not on the fixed list is refused before publishing.
    const repairs = page.getByLabel('Wording of “Repairs and maintenance”');
    await repairs.fill('Report repairs to {{caretaker.phone}} within a day.');
    await expect(page.getByText('Not known placeholders: {{caretaker.phone}}')).toBeVisible();
    await expect(page.getByText('is not a known placeholder')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish version 2' })).toBeDisabled();
    await repairs.fill(
      'The tenant reports repairs within a day. The landlord keeps {{property.name}} in good repair.',
    );
    await page.getByLabel('What changed').fill(`Repairs clause for short lets ${tag}`);
    await page.getByRole('button', { name: 'Publish version 2' }).click();
    await expect(page.getByText('Published version 2.')).toBeVisible();
    await expect(page.getByTestId('template-version')).toHaveCount(2);
    await expect(page.getByText('Version 2 not reviewed by counsel')).toBeVisible();

    // The counsel review is recorded once, for the version the lawyer read.
    await page.getByRole('button', { name: 'Record the counsel review of version 2' }).click();
    const review = page.getByRole('form', { name: 'Counsel review of version 2' });
    await review.getByLabel('Review note').fill(`Reviewed by A. Mensah, solicitor, ${tag}`);
    await review.getByRole('button', { name: 'Record the review' }).click();
    await expect(page.getByText('Recorded the counsel review of version 2.')).toBeVisible();
    await expect(page.getByText('Version 2 reviewed by counsel')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Record the counsel review of version 2' }),
    ).toHaveCount(0);
    // Version 1 was never reviewed, and still says so.
    await expect(
      page.getByTestId('template-version').filter({ hasText: 'Version 1' }),
    ).toContainText('Not reviewed');

    // The published wording is what the API holds now.
    const templates = (await (await page.request.get('/api/v1/lease-templates')).json()) as {
      name: string;
      latest: {
        version: number;
        counselReview: unknown;
        content: { sections: { clauses: { key: string; body: string }[] }[] };
      };
    }[];
    const saved = templates.find((t) => t.name === name)!;
    expect(saved.latest.version).toBe(2);
    expect(saved.latest.counselReview).not.toBeNull();
    const body = saved.latest.content.sections
      .flatMap((s) => s.clauses)
      .find((c) => c.key === 'repairs')?.body;
    expect(body).toContain('{{property.name}}');
  });
});
