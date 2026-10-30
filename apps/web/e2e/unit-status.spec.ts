import { expect, test, type Page } from '@playwright/test';
import { PEOPLE, ready, signIn, unique } from './helpers';
import { unitByCode } from './register-helpers';

// A seeded flat in East Legon (Owner A). The test leaves it available, as the seed has it.
const UNIT = 'ACC-ELG-B1-08';

async function changeAvailability(page: Page, to: string, reason: string) {
  await ready(page, 'Change availability');
  await page.getByRole('button', { name: 'Change availability' }).click();
  const form = page.getByRole('form', { name: 'Change availability' });
  await form.getByLabel('New availability').selectOption({ label: to });
  await form.getByLabel('Reason').fill(reason);
  await form.getByRole('button', { name: 'Save availability' }).click();
}

test.describe('PR-06 unit status', () => {
  test('changing a unit’s availability needs a reason, and the change shows in its history', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const unit = await unitByCode(page, UNIT);
    await page.goto(`/portfolio/units/${unit.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(UNIT);

    // A run that stopped half-way may have left it reserved: put it back first.
    if ((await page.getByTestId('availability').textContent()) !== 'Available') {
      await changeAvailability(page, 'Available', 'Reset by the e2e test');
      await expect(page.getByTestId('availability')).toHaveText('Available');
    }

    // Without a reason the change is refused on the spot.
    await ready(page, 'Change availability');
    await page.getByRole('button', { name: 'Change availability' }).click();
    const form = page.getByRole('form', { name: 'Change availability' });
    // From available, every manual state is offered; the occupancy states never are.
    await expect(form.getByLabel('New availability').getByRole('option')).toHaveText([
      'Reserved',
      'Under repair',
      'Not lettable',
    ]);
    await form.getByLabel('New availability').selectOption({ label: 'Reserved' });
    await form.getByRole('button', { name: 'Save availability' }).click();
    await expect(form.getByText('Give a reason for the change')).toBeVisible();

    const reason = `Held for a viewing ${unique()}`;
    await form.getByLabel('Reason').fill(reason);
    await form.getByRole('button', { name: 'Save availability' }).click();
    await expect(page.getByText(`${UNIT} is now reserved.`)).toBeVisible();
    await expect(page.getByTestId('availability')).toHaveText('Reserved');
    await expect(page.getByTestId('unit-status').first()).toHaveText('Reserved');

    // The history names who, when (with the time zone), from and to, and why.
    const latest = page.getByTestId('history-event').first();
    await expect(latest).toContainText('Available → Reserved');
    await expect(latest).toContainText(reason);
    await expect(latest).toContainText(PEOPLE.managerOne.name);
    await expect(latest).toContainText(/\(Africa\/Accra\)/);
    await expect(latest).toContainText('Changed by hand');

    // A reserved unit can only be made available again; that change is recorded too.
    await ready(page, 'Change availability');
    await page.getByRole('button', { name: 'Change availability' }).click();
    await expect(
      page
        .getByRole('form', { name: 'Change availability' })
        .getByLabel('New availability')
        .getByRole('option'),
    ).toHaveText(['Available']);
    await page.getByRole('button', { name: 'Cancel' }).click();
    const back = `Viewing over ${unique()}`;
    await changeAvailability(page, 'Available', back);
    await expect(page.getByTestId('availability')).toHaveText('Available');

    // The history is stored, not just shown: it is there after a reload, newest first.
    await page.reload();
    const events = page.getByTestId('history-event');
    await expect(events.nth(0)).toContainText('Reserved → Available');
    await expect(events.nth(0)).toContainText(back);
    await expect(events.nth(1)).toContainText('Available → Reserved');
    await expect(events.nth(1)).toContainText(reason);
  });
});
