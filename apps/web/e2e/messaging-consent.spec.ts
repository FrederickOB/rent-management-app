import { expect, test } from '@playwright/test';
import { PEOPLE, ready, signIn, unique } from './helpers';
import { freshPhone, newTenant } from './tenancy-helpers';

/**
 * M6: consent on every channel (CM-09; plan 4.8; decision 8, OQ-54), on the tenant profile.
 * Needs the stack running with the demo seed.
 */
test.describe('CM-09 and decision 8 consent on every channel', () => {
  test('staff record WhatsApp consent, and a changed phone starts with no SMS or WhatsApp consent', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Abena Channels ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const tenant = await newTenant(page, name, { consent: { sms: true } });

    await page.goto(`/tenants/${tenant.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    const consent = page.getByTestId('consent');
    for (const channel of ['push', 'whatsapp', 'sms', 'email'])
      await expect(consent.getByTestId(`consent-${channel}`)).toBeVisible();
    await expect(consent.getByTestId('consent-sms')).toContainText('Agreed');
    await expect(consent.getByTestId('consent-whatsapp')).toContainText('Not agreed');
    await expect(consent.getByTestId('consent-email')).toContainText('No email on file');

    await ready(page, 'Record WhatsApp consent for the tenant');
    await consent.getByRole('button', { name: 'Record WhatsApp consent for the tenant' }).click();
    const confirm = consent.getByRole('group', { name: 'Confirm WhatsApp consent' });
    await expect(confirm).toContainText('by WhatsApp.');
    await expect(confirm).toContainText('(messages.v1)');
    await confirm.getByRole('button', { name: 'They agreed to this' }).click();
    await expect(consent.getByTestId('consent-whatsapp')).toContainText('Agreed');
    await expect(
      consent.getByTestId('consent-whatsapp').getByTestId('consent-source'),
    ).toContainText('recorded by staff');
    await expect(
      page.getByTestId('timeline-event').filter({ hasText: 'WhatsApp: agreed to messages' }),
    ).toHaveCount(1);

    // Decision 8: the edit form says a new phone starts with no consent, and it does.
    await page.getByRole('button', { name: 'Edit details' }).click();
    const edit = page.getByRole('form', { name: 'Edit details' });
    await edit.getByLabel('Phone', { exact: true }).fill(freshPhone());
    await expect(edit).toContainText(
      'The new phone number starts with no SMS or WhatsApp consent. Once the tenant agrees to messages at it, record that below.',
    );
    await edit.getByRole('button', { name: 'Save details' }).click();
    await expect(page.getByText(`Saved ${name}.`)).toBeVisible();
    await expect(consent.getByTestId('consent-sms')).toContainText('Not agreed');
    await expect(consent.getByTestId('consent-whatsapp')).toContainText('Not agreed');
  });
});
