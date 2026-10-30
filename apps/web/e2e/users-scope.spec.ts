import { expect, test, type Page } from '@playwright/test';
import { nav, PEOPLE, ready, signIn } from './helpers';
import { OWNER_A } from './register-helpers';

const ABENA = 'Abena Caretaker (demo)'; // caretaker for ACC-OSU in the seed
const ADJOA = 'Adjoa Adviser (demo)'; // adviser for Owner A in the seed
const NOT_HERE = '019a3000-0000-7000-8000-00000000dead'; // no such property in this company

/** Changes the next scope the form saves, as an out-of-date screen might send it. */
function nextSaveSends(page: Page, body: object) {
  return page.route(
    '**/api/v1/memberships/*',
    (route) => route.continue({ postData: JSON.stringify(body) }),
    { times: 1 },
  );
}

async function openChange(page: Page, person: string) {
  await page.getByRole('button', { name: `Change ${person}` }).click();
  return page.getByRole('form', { name: `Change ${person}` });
}

test.describe('AD-02 access pickers', () => {
  test('the agency admin sets who sees what with owner and property pickers, not raw ids', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.agencyAdmin.email);
    await nav(page).getByRole('link', { name: 'Users and roles' }).click();
    await ready(page, 'Invite someone');
    const abena = page.getByTestId('membership-row').filter({ hasText: ABENA });
    await expect(abena).toContainText('Only ACC-OSU');

    // A caretaker is limited to properties: there is no owner list, and one property is needed.
    let form = await openChange(page, ABENA);
    await expect(form.getByRole('group', { name: 'Properties', exact: true })).toBeVisible();
    await expect(form.getByRole('group', { name: /^Owners/ })).toHaveCount(0);
    await expect(form.getByRole('textbox')).toHaveCount(0);
    await expect(form.getByLabel('ACC-OSU')).toBeChecked();
    await form.getByLabel('ACC-OSU').uncheck();
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form.getByText('Choose at least one property.')).toBeVisible();

    // A second property, then back to the seed's one.
    await form.getByLabel('ACC-OSU').check();
    await form.getByLabel('ACC-ELG').check();
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(`Saved the changes for ${ABENA}.`)).toBeVisible();
    await expect(abena).toContainText(/Only (ACC-ELG, ACC-OSU|ACC-OSU, ACC-ELG)/);
    form = await openChange(page, ABENA);
    await form.getByLabel('ACC-ELG').uncheck();
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(`Saved the changes for ${ABENA}.`)).toBeVisible();
    await expect(abena).toContainText('Only ACC-OSU');

    // An adviser in an agency is limited by owner first; properties can be added on top.
    form = await openChange(page, ADJOA);
    await expect(form.getByRole('group', { name: 'Owners', exact: true })).toBeVisible();
    await expect(form.getByLabel(OWNER_A.name)).toBeChecked();
    await expect(form.getByRole('group', { name: 'Properties (optional)' })).toBeVisible();
    await form.getByLabel(OWNER_A.name).uncheck();
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form.getByText('Choose at least one owner.')).toBeVisible();
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('membership-row').filter({ hasText: ADJOA })).toContainText(
      `Only ${OWNER_A.name}`,
    );

    // A manager may be limited either way, or see the whole company.
    form = await openChange(page, PEOPLE.managerTwo.name);
    await expect(form.getByRole('group', { name: 'Owners (optional)' })).toBeVisible();
    await expect(form.getByRole('group', { name: 'Properties (optional)' })).toBeVisible();
    await expect(form.getByText('Leave both lists empty')).toBeVisible();
    await form.getByRole('button', { name: 'Cancel' }).click();

    // The API applies the same rule to whatever it is sent, checking the role the person has.
    const people = (await (await page.request.get('/api/v1/memberships')).json()) as {
      membershipId: string;
      name: string;
    }[];
    const abenaId = people.find((p) => p.name === ABENA)?.membershipId;
    expect(abenaId, `${ABENA} is in the seed`).toBeTruthy();
    const saveScope = async (scope: object) => {
      const response = await page.request.patch(`/api/v1/memberships/${abenaId}`, {
        data: { scope },
      });
      return {
        status: response.status(),
        code: ((await response.json()) as { code?: string }).code,
      };
    };
    expect(await saveScope({})).toEqual({ status: 422, code: 'SCOPE.PROPERTIES_REQUIRED' });
    expect(await saveScope({ properties: [NOT_HERE] })).toEqual({
      status: 400,
      code: 'SCOPE_UNKNOWN',
    });

    // And the form puts the API's answer where it can be acted on.
    form = await openChange(page, ABENA);
    await form.getByLabel('ACC-ELG').check();
    await nextSaveSends(page, { scope: {} });
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form.getByRole('group', { name: 'Properties', exact: true })).toContainText(
      'Choose at least one property for this caretaker',
    );
    await nextSaveSends(page, { scope: { properties: [NOT_HERE] } });
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      form.getByRole('alert').filter({ hasText: 'Choose owners and properties from this company' }),
    ).toContainText('Not in the list');
    await form.getByRole('button', { name: 'Cancel' }).click();
    await page.unrouteAll();
    // Nothing was saved.
    await page.reload();
    await expect(abena).toContainText('Only ACC-OSU');
  });
});
