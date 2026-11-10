import { expect, test } from '@playwright/test';
import { PEOPLE, ready, signIn, unique } from './helpers';
import { newTenant } from './tenancy-helpers';

/**
 * M11 plan section 6, end to end (web): a data protection request (decision 5; Act 843). The
 * seeded agency admin records an access request and an erasure request for a tenant made for the
 * run, prepares the access export, erases what retention allows, and finds both in Settings, Data
 * protection.
 *
 * What it relies on: the seeded agency admin holds `data_protection.manage` and
 * `data_protection.export` (plan 4.13); the rules row `data_protection.request_response_days` is
 * still null, so no due date is shown (OQ-65); with today's unverified retention rules, an
 * erasure stops messaging and holds the rest, listing it.
 */

test.describe.configure({ timeout: 240_000 });

test.describe('NFR-DP data protection requests are recorded, answered and listed', () => {
  test('an access request gets its export, an erasure stops messaging and lists what is held, and both are in the register', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.agencyAdmin.email);
    const name = `Adwoa Request ${unique()} (e2e)`;
    const tenant = await newTenant(page, name);

    await page.goto(`/tenants/${tenant.id}`);
    const card = page.getByTestId('data-protection-requests');
    await ready(page, 'Record a request');

    // Access: recorded, no due date while counsel has not set the response time.
    await card.getByRole('button', { name: 'Record a request' }).click();
    const form = card.getByRole('form', { name: 'Record a data protection request' });
    await form.getByLabel('What they ask').selectOption('access');
    await form.getByRole('button', { name: 'Record the request' }).click();
    await expect(card.getByText(`Recorded the request from ${name}.`)).toBeVisible();
    const access = card
      .getByTestId('data-protection-request')
      .filter({ hasText: 'See their data (access)' });
    await expect(access.getByTestId('data-protection-due')).toHaveText(
      'No due date yet: the response time is still to be set by counsel.',
    );

    // The export: prepared by a job, downloaded through a short-lived link.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 150_000 }),
      access.getByRole('button', { name: 'Prepare the export' }).click(),
    ]);
    expect(download.suggestedFilename()).not.toBe('');

    // Answered: completed with its outcome, and closed to further change.
    const status = access.getByRole('form', { name: 'Move the request on' });
    await status.getByLabel('Status').selectOption('completed');
    await status.getByLabel('Outcome').fill('Export sent to the tenant by hand.');
    await status.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByText('The request is now completed.')).toBeVisible();
    await expect(access.getByTestId('data-protection-outcome')).toHaveText(
      'Outcome: Export sent to the tenant by hand.',
    );
    await expect(access.getByRole('form', { name: 'Move the request on' })).toHaveCount(0);

    // Erasure: messaging stops at once; erasing holds what retention keeps, and says so.
    await card.getByRole('button', { name: 'Record a request' }).click();
    await form.getByLabel('What they ask').selectOption('erasure');
    await expect(form).toContainText('Recording an erasure request stops every message');
    await form.getByRole('button', { name: 'Record the request' }).click();
    await expect(
      card.getByText(`Recorded. Messages to ${name} have stopped on every channel.`),
    ).toBeVisible();
    const erasure = card
      .getByTestId('data-protection-request')
      .filter({ hasText: 'Erase their data' });
    await erasure.getByRole('button', { name: 'Erase what the law allows' }).click();
    await erasure
      .getByRole('group', { name: 'Confirm the erasure' })
      .getByRole('button', { name: 'Yes, erase' })
      .click();
    const outcome = erasure.getByTestId('erasure-outcome');
    await expect(outcome).toContainText('Messages to the tenant have stopped on every channel.');

    // Both are in the register under Settings.
    await page.goto('/settings/data-protection');
    const register = page
      .getByTestId('data-protection-request')
      .filter({ has: page.getByRole('link', { name }) });
    await expect(register).toHaveCount(2);
  });
});
