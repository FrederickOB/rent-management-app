import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';
import { freshPhone, ghanaCardNumber, newTenant } from './tenancy-helpers';

test.describe('TL-01, TL-03 and CM-09 tenants with consent per channel', () => {
  test('a manager adds a tenant with a guarantor and the consent each gave, then records changes to it', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Abena Consent ${tag} (e2e)`;
    const guarantor = `Yaa Guarantor ${tag} (e2e)`;
    const phone = freshPhone();
    await signIn(page, PEOPLE.managerOne.email);
    await nav(page).getByRole('link', { name: 'Tenants' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tenants');
    await page.getByRole('link', { name: 'New tenant' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('New tenant');
    await ready(page, 'Add tenant');

    const form = page.getByRole('form', { name: 'New tenant' });
    await form.getByLabel('Full name').fill(name);
    // Typed the way it is written in Ghana; it is stored as +233…
    await form
      .getByLabel('Phone', { exact: true })
      .fill(`0${phone.slice(4, 6)} ${phone.slice(6, 9)} ${phone.slice(9)}`);
    await form.getByLabel('Occupation (optional)').fill('Pharmacist');
    const tenantConsent = form.getByRole('group', {
      name: 'Messages the tenant agreed to receive',
    });
    // Staff see the versioned words they are recording.
    await expect(tenantConsent).toContainText('agreed to receive messages about their tenancy');
    await expect(tenantConsent).toContainText('(messages.v1)');
    await tenantConsent.getByLabel('By SMS').check();

    await form.getByRole('button', { name: 'Add guarantor' }).click();
    await form.getByLabel('Name', { exact: true }).fill(guarantor);
    await form.getByLabel('Relationship (optional)').fill('Aunt');
    await form.getByLabel('Phone (optional)').fill(freshPhone());
    const contactConsent = form.getByRole('group', {
      name: 'Messages this contact agreed to receive',
    });
    // Consent on a channel needs somewhere to send to.
    await contactConsent.getByLabel('By email').check();
    await form.getByRole('button', { name: 'Add tenant' }).click();
    await expect(form.getByText('Add an email address, or untick email consent')).toBeVisible();
    await contactConsent.getByLabel('By email').uncheck();
    await contactConsent.getByLabel('By SMS').check();
    await form.getByRole('button', { name: 'Add tenant' }).click();

    await expect(page).toHaveURL(/\/tenants\/[0-9a-f-]{36}\?created=1$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page.getByText(`Added ${name}.`)).toBeVisible();
    const tenantId = /\/tenants\/([0-9a-f-]{36})/.exec(page.url())![1]!;
    const consent = page.getByTestId('consent');
    await expect(consent.getByTestId('consent-sms')).toContainText('Agreed');
    await expect(consent.getByTestId('consent-email')).toContainText('Not agreed');
    await expect(consent.getByTestId('consent-email')).toContainText('No email on file');
    const contact = page.getByTestId('contact-row').filter({ hasText: guarantor });
    await expect(contact).toContainText('Guarantor');
    await expect(contact).toContainText('Aunt');
    await expect(contact.getByTestId('consent-sms')).toContainText('Agreed');

    // The tenant gives an email and agrees to email too; later they withdraw SMS.
    await page.getByRole('button', { name: 'Edit details' }).click();
    const edit = page.getByRole('form', { name: 'Edit details' });
    await edit.getByLabel('Email (optional)').fill(`abena.${tag.toLowerCase()}@demo.invalid`);
    await edit.getByRole('button', { name: 'Save details' }).click();
    await expect(page.getByText(`Saved ${name}.`)).toBeVisible();
    await consent.getByRole('button', { name: 'Record Email consent for the tenant' }).click();
    const confirm = consent.getByRole('group', { name: 'Confirm Email consent' });
    await expect(confirm).toContainText('by email');
    await expect(confirm).toContainText('(messages.v1)');
    await confirm.getByRole('button', { name: 'They agreed to this' }).click();
    await expect(consent.getByTestId('consent-email')).toContainText('Agreed');
    await consent
      .getByRole('button', { name: 'Record that the tenant withdrew SMS consent' })
      .click();
    // A withdrawal is kept for good, so it is confirmed first, as a grant is.
    const withdrawal = consent.getByRole('group', { name: 'Confirm SMS withdrawal' });
    await expect(withdrawal).toContainText('kept for good');
    await withdrawal.getByRole('button', { name: 'They withdrew it' }).click();
    await expect(consent.getByTestId('consent-sms')).toContainText('Not agreed');

    // Every grant and withdrawal is its own record, on the timeline.
    const timeline = page.getByTestId('timeline');
    await expect(
      timeline.getByTestId('timeline-event').filter({ hasText: 'Email: agreed to messages' }),
    ).toHaveCount(1);
    await expect(
      timeline.getByTestId('timeline-event').filter({ hasText: 'SMS: withdrew consent' }),
    ).toHaveCount(1);
    await expect(timeline).toContainText('(Africa/Accra)');
    const stored = (await (await page.request.get(`/api/v1/tenants/${tenantId}`)).json()) as {
      phone: string;
      consent: { sms: boolean; email: boolean };
    };
    expect(stored.phone).toBe(phone);
    expect(stored.consent).toEqual({ sms: false, email: true });

    // The same phone again is flagged, with a link to the tenant who has it (plan 4.3).
    await page.goto('/tenants/new');
    await ready(page, 'Add tenant');
    const again = page.getByRole('form', { name: 'New tenant' });
    await again.getByLabel('Full name').fill(`Abena Twice ${tag} (e2e)`);
    await again.getByLabel('Phone', { exact: true }).fill(phone);
    await again.getByRole('button', { name: 'Add tenant' }).click();
    await expect(page.getByText('This may be a tenant you already have')).toBeVisible();
    await expect(page.getByRole('link', { name })).toHaveAttribute('href', `/tenants/${tenantId}`);
    await expect(page.getByText('has the same phone number')).toBeVisible();
  });
});

test.describe('TL-02 ID numbers', () => {
  test('the ID number shows masked; revealing it needs a reason and is recorded, and an accountant cannot reveal it', async ({
    page,
    browser,
    baseURL,
  }) => {
    const tag = unique();
    const name = `Kojo Identity ${tag} (e2e)`;
    const number = ghanaCardNumber();
    const masked = `GHA-*******${number.slice(11, 13)}-${number.slice(-1)}`;
    await signIn(page, PEOPLE.managerOne.email);
    const { id } = await newTenant(page, name, { idType: 'ghana_card', idNumber: number });

    await page.goto(`/tenants/${id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    const identity = page.getByTestId('identity');
    await expect(identity.getByTestId('id-masked')).toHaveText(masked);
    await expect(identity.getByTestId('id-status')).toHaveText('Not checked yet');
    await expect(page.getByText(number)).toHaveCount(0);

    await ready(page, 'Show the ID number');
    await identity.getByRole('button', { name: 'Show the ID number' }).click();
    const reveal = identity.getByRole('form', { name: 'Show the ID number' });
    await reveal.getByLabel('Reason').fill('check');
    await reveal.getByRole('button', { name: 'Show the number' }).click();
    await expect(reveal.getByText('Give a reason of at least 10 characters.')).toBeVisible();
    const reason = `Matching the ID on the paper lease ${tag}`;
    await reveal.getByLabel('Reason').fill(reason);
    await reveal.getByRole('button', { name: 'Show the number' }).click();
    await expect(identity.getByTestId('revealed-number')).toContainText(number);
    await identity.getByRole('button', { name: 'Hide the number' }).click();
    await expect(page.getByText(number)).toHaveCount(0);

    // Who saw it, when and why is kept; the number itself is not.
    await page.reload();
    const shown = page.getByTestId('timeline-event').filter({ hasText: 'ID number shown' });
    await expect(shown).toHaveCount(1);
    await expect(shown).toContainText(`Reason: ${reason}`);
    await expect(shown).toContainText(PEOPLE.managerOne.name);
    await expect(page.getByTestId('timeline')).not.toContainText(number);

    // The Ghana Card is checked biometrically through the identity provider.
    await page
      .getByTestId('identity')
      .getByRole('button', { name: 'Start a biometric check' })
      .click();
    await expect(page.getByText('Check started.')).toBeVisible();
    await expect(page.getByTestId('identity').getByTestId('id-status')).toHaveText(
      'Check in progress',
    );
    await expect(
      page.getByTestId('identity').getByRole('button', { name: 'Check again' }),
    ).toBeVisible();

    // An accountant sees the details, but the number stays masked and cannot be revealed.
    const books = await browser.newContext({ baseURL });
    try {
      const accountant = await books.newPage();
      await signIn(accountant, PEOPLE.accountant.email);
      await accountant.goto(`/tenants/${id}`);
      await expect(accountant.getByTestId('id-masked')).toHaveText(masked);
      await expect(accountant.getByRole('button', { name: 'Show the ID number' })).toHaveCount(0);
      const refused = await accountant.request.post(`/api/v1/tenants/${id}/id-number/reveal`, {
        data: { reason: 'Trying to read the number' },
      });
      expect(refused.status()).toBe(403);
      expect(await refused.text()).not.toContain(number);
    } finally {
      await books.close();
    }

    // A revealed number belongs to the number it was asked for: opening the edit form hides it,
    // and the corrected number on file stays masked.
    await identity.getByRole('button', { name: 'Show the ID number' }).click();
    const again = identity.getByRole('form', { name: 'Show the ID number' });
    await again.getByLabel('Reason').fill(`Checking the number before correcting it ${tag}`);
    await again.getByRole('button', { name: 'Show the number' }).click();
    await expect(identity.getByTestId('revealed-number')).toContainText(number);
    await page.getByRole('button', { name: 'Edit details' }).click();
    await expect(identity.getByTestId('revealed-number')).toHaveCount(0);
    await expect(page.getByText(number)).toHaveCount(0);
    const corrected = ghanaCardNumber();
    const edit = page.getByRole('form', { name: 'Edit details' });
    await edit.getByLabel(/^Ghana Card number/).fill(corrected);
    await edit.getByRole('button', { name: 'Save details' }).click();
    await expect(page.getByText(`Saved ${name}.`)).toBeVisible();
    await expect(identity.getByTestId('id-masked')).toHaveText(
      `GHA-*******${corrected.slice(11, 13)}-${corrected.slice(-1)}`,
    );
    await expect(identity.getByTestId('revealed-number')).toHaveCount(0);
    await expect(page.getByText(number)).toHaveCount(0);
    await expect(page.getByText(corrected)).toHaveCount(0);
  });
});
