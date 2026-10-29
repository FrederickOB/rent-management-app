import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';
import { fixture } from './register-helpers';
import {
  dayAfter,
  daysFromToday,
  leaseById,
  monthsFromToday,
  newPropertyWithUnits,
  newTenant,
  recordPaperLease,
} from './tenancy-helpers';

test.describe('TL-06, PB-09 and decision 7 a lease signed on paper', () => {
  test('a manager records a paper lease with its scan; the unit shows occupied until the move-out', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Esi Paper ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const { units } = await newPropertyWithUnits(page, 1);
    const unit = units[0]!;
    const tenant = await newTenant(page, name);
    const start = monthsFromToday(-3);

    // From the unit: it is vacant, and a paper lease can be recorded for it.
    await page.goto(`/portfolio/units/${unit.id}`);
    await expect(page.getByTestId('unit-status')).toContainText('Vacant');
    const leases = page.getByTestId('unit-leases');
    await expect(leases).toContainText('No leases yet.');
    await leases.getByRole('link', { name: 'Record a paper lease' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record a paper lease');
    await ready(page, 'Record the lease');

    const form = page.getByRole('form', { name: 'Record a paper lease' });
    await expect(form.getByLabel('Unit for this lease')).toHaveValue(unit.id);
    await form.getByLabel('Find a tenant').fill(name);
    const choice = `${name} · ${tenant.phone}`;
    await expect(
      form.getByLabel('Tenant for this lease').locator('option', { hasText: choice }),
    ).toHaveCount(1);
    await form.getByLabel('Tenant for this lease').selectOption({ label: choice });
    await form.getByLabel('First day of the lease').fill(start);
    await form.getByRole('button', { name: '1 year' }).click();
    await form.getByLabel('Monthly rent (GH₵)').fill('650');
    await form.getByLabel('Security deposit (GH₵, optional)').fill('1,300');
    await form.getByLabel('Date the lease was signed').fill(daysFromToday(-100));
    // The first signer follows the tenant chosen.
    await expect(
      form.getByTestId('party-row').first().getByLabel('Name', { exact: true }),
    ).toHaveValue(name);
    // Nothing is sent without the signed copy.
    await form.getByRole('button', { name: 'Record the lease' }).click();
    await expect(form.getByText('Upload the signed lease.')).toBeVisible();
    await form
      .getByLabel('The signed lease (scan or photo)')
      .setInputFiles(fixture('title-deed.pdf'));
    await form.getByRole('button', { name: 'Record the lease' }).click();

    await expect(page).toHaveURL(/\/leases\/[0-9a-f-]{36}\?saved=paper$/);
    await expect(page.getByText('Recorded the lease signed on paper.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Lease for ${unit.code}`);
    await expect(page.getByTestId('lease-status').first()).toHaveText('Active');
    await expect(page.getByText('Signed on paper').first()).toBeVisible();
    const terms = page.getByTestId('lease-terms');
    await expect(terms).toContainText('GH₵650.00');
    await expect(terms).toContainText('GH₵1,300.00');
    await expect(terms).toContainText('None: signed on paper');
    // The schedule is monthly from the start, recorded when the lease was signed.
    await expect(page.getByTestId('schedule-row').first()).toContainText('GH₵650.00');
    await expect(
      page
        .getByTestId('lease-documents')
        .getByRole('button', { name: 'The signed paper lease (scan)' }),
    ).toBeVisible();
    // Trackers rest on unverified rules, and say so.
    await expect(page.getByTestId('tracker-stamping')).toContainText('not yet verified by counsel');
    await expect(page.getByTestId('tracker-rent-control')).toContainText('Deadline');
    const leaseId = /\/leases\/([0-9a-f-]{36})/.exec(page.url())![1]!;

    // Occupancy comes from the lease: the unit is occupied, and its history says why.
    await page.goto(`/portfolio/units/${unit.id}`);
    await expect(page.getByTestId('unit-status')).toContainText('Occupied');
    await expect(page.getByTestId('unit-lease')).toContainText(name);
    await expect(page.getByTestId('unit-lease')).toContainText('Active');
    await expect(
      page
        .getByTestId('history-event')
        .filter({ hasText: /→ Occupied|set to Occupied/ })
        .filter({ hasText: 'Lease' })
        .first(),
    ).toBeVisible();
    // While the lease holds the unit, it can only be marked under repair.
    await page.getByRole('button', { name: 'Change availability' }).click();
    const availability = page.getByRole('form', { name: 'Change availability' });
    await expect(availability.getByLabel('New availability').locator('option')).toHaveText([
      'Under repair',
    ]);
    await availability.getByRole('button', { name: 'Cancel' }).click();

    // The tenant moves out: the lease ends and the unit is free again (the minimal TL-11 hook).
    await page.goto(`/leases/${leaseId}`);
    await ready(page, 'Record the move-out');
    await page.getByRole('button', { name: 'Record the move-out' }).click();
    const moveOut = page.getByRole('form', { name: 'Record the move-out' });
    await moveOut.getByLabel('Moved out on').fill(daysFromToday(-1));
    await moveOut.getByRole('button', { name: 'Record the move-out' }).click();
    await expect(page.getByText('Recorded the move-out.')).toBeVisible();
    await expect(page.getByTestId('lease-status').first()).toHaveText('Ended');
    await page.goto(`/portfolio/units/${unit.id}`);
    await expect(page.getByTestId('unit-status')).toContainText('Vacant');
  });
});

test.describe('TL-05 and TL-06 the lease builder', () => {
  test('a manager drafts a lease from a unit and a tenant, adds the witness, and reads the document before it is issued', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Akos Draft ${tag} (e2e)`;
    const witness = `Ekow Witness ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const { units } = await newPropertyWithUnits(page, 1);
    const unit = units[0]!;
    const tenant = await newTenant(page, name);

    await page.goto(`/leases/new?unitId=${unit.id}&tenantId=${tenant.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('New lease');
    await ready(page, 'Save as a draft');
    const form = page.getByRole('form', { name: 'New lease' });
    await expect(form.getByLabel('Unit for this lease')).toHaveValue(unit.id);
    await expect(form.getByLabel('Tenant for this lease')).toHaveValue(tenant.id);
    // The starter has not been reviewed by a lawyer, and the builder says so before anything is saved.
    await expect(form.getByText('Not reviewed by a lawyer')).toBeVisible();
    await form.getByLabel('First day of the lease').fill(monthsFromToday(1));
    await form.getByRole('button', { name: '1 year' }).click();
    await form.getByLabel('Monthly rent (GH₵)').fill('1,200.50');
    await form.getByLabel('Billing cycle').selectOption({ label: 'Quarterly' });
    await form.getByLabel('Initial advance in months (optional)').fill('24');
    await form.getByRole('button', { name: 'Save as a draft' }).click();
    // The domain's rules answer before the API is asked: an advance cannot outrun the term.
    await expect(
      form.getByText('An initial advance covers 3 to 12 months for this lease'),
    ).toBeVisible();
    await form.getByLabel('Initial advance in months (optional)').fill('6');
    await expect(form.getByTestId('projected-schedule')).toContainText('(12 periods)');
    await form.getByRole('button', { name: 'Save as a draft' }).click();

    await expect(page).toHaveURL(/\/leases\/[0-9a-f-]{36}\?saved=draft$/);
    await expect(page.getByTestId('lease-status').first()).toHaveText('Draft');
    await expect(page.getByTestId('lease-terms')).toContainText('GH₵1,200.50');
    await expect(page.getByTestId('lease-terms')).toContainText('6 months');
    // Signers by default: the tenant, and the manager for the landlord.
    const parties = page.getByTestId('lease-parties');
    await expect(parties.getByTestId('party').filter({ hasText: name })).toContainText('Tenant');
    await expect(
      parties.getByTestId('party').filter({ hasText: PEOPLE.managerOne.name }),
    ).toContainText('For the landlord');
    // The document reads as its PDF will, filled in from the draft.
    const preview = page.frameLocator('iframe[title="Lease document preview"]');
    await expect(preview.getByText(unit.code).first()).toBeVisible();
    await expect(preview.getByText(name).first()).toBeVisible();
    await expect(page.getByTestId('lease-preview')).toContainText(
      'has not been reviewed by your lawyer',
    );

    // The witness is added in the draft editor.
    await page.getByRole('link', { name: 'Edit the draft' }).click();
    await ready(page, 'Save the draft');
    const edit = page.getByRole('form', { name: 'Edit the draft' });
    await expect(edit.getByText('Add the witness below before the lease is issued.')).toBeVisible();
    await edit.getByLabel('Add someone who signs as').selectOption({ label: 'Witness' });
    await edit.getByRole('button', { name: 'Add signer' }).click();
    const added = edit.getByTestId('party-row').last();
    await added.getByLabel('Name', { exact: true }).fill(witness);
    await added.getByLabel('Phone (optional)').fill('024 412 3456');
    await expect(edit.getByText('Add the witness below before the lease is issued.')).toHaveCount(
      0,
    );
    await edit.getByRole('button', { name: 'Save the draft' }).click();
    await expect(page.getByText('Saved the draft.')).toBeVisible();
    await expect(parties.getByTestId('party').filter({ hasText: witness })).toContainText(
      'Witness',
    );
    await expect(parties.getByTestId('party').filter({ hasText: witness })).toContainText(
      '+233244123456',
    );

    // A draft holds no unit: it stays vacant until a lease is signed.
    await page.goto(`/portfolio/units/${unit.id}`);
    await expect(page.getByTestId('unit-status')).toContainText('Vacant');
    await expect(page.getByTestId('unit-lease')).toContainText('Draft');
  });
});

test.describe('TL-09 renewals', () => {
  // The seed's lease for ACC-ELG-B1-01 (Akua Expiring) ends 60 days after the seed ran.
  const UNIT = 'ACC-ELG-B1-01';

  test('the home page and the expiring list show a lease ending soon, and a renewal draft starts from it', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const listed = (await (await page.request.get('/api/v1/leases/expiring?days=90')).json()) as {
      id: string;
      unitCode: string;
      endDate: string;
      renewal: { id: string; status: string } | null;
    }[];
    const lease = listed.find((l) => l.unitCode === UNIT);
    expect(lease, `${UNIT} ends within 90 days: run pnpm db:seed`).toBeTruthy();
    // An earlier run's renewal draft is cancelled first, so this run starts one of its own.
    if (lease!.renewal?.status === 'draft')
      expect(
        (
          await page.request.post(`/api/v1/leases/${lease!.renewal.id}/cancel`, {
            data: { reason: 'Clearing an earlier e2e run' },
          })
        ).status(),
      ).toBe(200);

    await page.goto('/');
    const home = page.getByTestId('expiring-summary');
    await expect(home).toContainText('Leases ending in the next 90 days');
    await expect(home.getByTestId('expiring-lease').filter({ hasText: UNIT })).toContainText(
      'Akua Expiring (demo)',
    );
    await home.getByRole('link', { name: 'See every lease ending soon' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Leases ending soon');
    const row = page.getByTestId('expiring-row').filter({ hasText: UNIT });
    await expect(row.getByTestId('days-left')).toHaveText(/\(in \d+ days\)/);
    await ready(page, `Offer a renewal for ${UNIT}`);
    await row.getByRole('button', { name: `Offer a renewal for ${UNIT}` }).click();

    // The renewal is a draft that starts the day after the old lease ends.
    await expect(page).toHaveURL(/\/leases\/[0-9a-f-]{36}\?saved=renewal$/);
    await expect(page.getByText('This is the renewal')).toBeVisible();
    await expect(page.getByTestId('lease-status').first()).toHaveText('Draft');
    const renewalId = /\/leases\/([0-9a-f-]{36})/.exec(page.url())![1]!;
    const renewal = await leaseById<{ terms: { startDate: string }; renewsLeaseId: string }>(
      page,
      renewalId,
    );
    expect(renewal.renewsLeaseId).toBe(lease!.id);
    expect(renewal.terms.startDate).toBe(dayAfter(lease!.endDate));
    // The starter template has not been reviewed by a lawyer, so the draft says so.
    await expect(page.getByText('Not reviewed by a lawyer').first()).toBeVisible();
    await expect(page.getByTitle('Lease document preview')).toBeVisible();

    await page.goto('/leases/expiring');
    await expect(page.getByTestId('expiring-row').filter({ hasText: UNIT })).toContainText(
      'Renewal',
    );
    await expect(page.getByTestId('expiring-row').filter({ hasText: UNIT })).toContainText('Draft');

    // A draft is cancelled with a reason; the old lease is free to renew again.
    await page.goto(`/leases/${renewalId}`);
    await ready(page, 'Cancel the draft');
    await page.getByRole('button', { name: 'Cancel the draft' }).click();
    const cancel = page.getByRole('form', { name: 'Cancel the draft' });
    await cancel.getByLabel('Reason').fill('The tenant asked for other terms');
    await cancel.getByRole('button', { name: 'Cancel the draft' }).click();
    await expect(page.getByText('Cancelled the draft.')).toBeVisible();
    await expect(page.getByTestId('lease-status').first()).toHaveText('Cancelled');
    expect((await leaseById(page, lease!.id)).renewal).toBeNull();
  });
});

test.describe('AD-05 and decision 6 cancelling a signed lease', () => {
  test('a manager asks to cancel a signed lease before it starts; only a second person can approve it', async ({
    page,
    browser,
    baseURL,
  }) => {
    const tag = unique();
    const name = `Kwesi Reserved ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const { units } = await newPropertyWithUnits(page, 1);
    const unit = units[0]!;
    const tenant = await newTenant(page, name);
    // Signed on paper last week; it starts in two months, so the unit is reserved.
    const leaseId = await recordPaperLease(page, {
      unitId: unit.id,
      tenantId: tenant.id,
      tenantName: name,
      startDate: monthsFromToday(2),
      months: 12,
      monthlyRentMinor: 90_000,
      signedOn: daysFromToday(-7),
    });

    await page.goto(`/leases/${leaseId}`);
    await expect(page.getByTestId('lease-status').first()).toHaveText('Signed');
    await ready(page, 'Cancel the signed lease');
    await page.getByRole('button', { name: 'Cancel the signed lease' }).click();
    const ask = page.getByRole('form', { name: 'Cancel the signed lease' });
    await ask.getByLabel('Reason').fill('short');
    await ask.getByRole('button', { name: 'Ask for approval' }).click();
    await expect(ask.getByText('Give a reason of at least 10 characters.')).toBeVisible();
    const reason = `The tenant took a job in Kumasi ${tag}`;
    await ask.getByLabel('Reason').fill(reason);
    await ask.getByRole('button', { name: 'Ask for approval' }).click();
    await expect(page.getByText('A second person must approve it in Approvals.')).toBeVisible();
    await expect(page.getByText('Cancellation waiting for approval')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel the signed lease' })).toHaveCount(0);

    // The initiator is never offered "Approve", and the API refuses them too.
    await nav(page).getByRole('link', { name: 'Approvals' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Approvals');
    const mine = page.getByTestId('approval').filter({ hasText: reason });
    await expect(mine).toContainText('Cancel a signed lease before it starts');
    await expect(mine).toContainText(`Lease for ${unit.code}`);
    await expect(mine).toContainText('Asked by You');
    await expect(mine).toContainText('You asked, so you cannot approve this yourself.');
    await expect(mine.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    const open = (await (await page.request.get('/api/v1/approvals?status=open')).json()) as {
      id: string;
      subjectId: string;
    }[];
    const requestId = open.find((r) => r.subjectId === leaseId)!.id;
    const refused = await page.request.post(`/api/v1/approvals/${requestId}/decisions`, {
      data: { decision: 'approve' },
    });
    expect(refused.status()).toBe(403);
    expect((await leaseById(page, leaseId)).status).toBe('signed');

    // A second manager approves; the lease is cancelled and the unit is free.
    const other = await browser.newContext({ baseURL });
    try {
      const second = await other.newPage();
      await signIn(second, PEOPLE.managerTwo.email);
      await nav(second).getByRole('link', { name: 'Approvals' }).click();
      const request = second.getByTestId('approval').filter({ hasText: reason });
      await expect(request).toContainText(`Asked by ${PEOPLE.managerOne.name}`);
      const approve = request.getByRole('button', { name: 'Approve', exact: true });
      await expect(approve).toBeEnabled();
      await request.getByLabel('Note (optional)').fill('Checked with the tenant by phone');
      await approve.click();
      await expect(second.getByText('It has taken effect.')).toBeVisible();
      await second.getByRole('tab', { name: 'Closed' }).click();
      const closed = second.getByTestId('approval').filter({ hasText: reason });
      await expect(closed).toContainText('Approved by You');
      await expect(closed).toContainText('Approved by a second person');
    } finally {
      await other.close();
    }

    await page.goto(`/leases/${leaseId}`);
    await expect(page.getByTestId('lease-status').first()).toHaveText('Cancelled');
    await expect(page.getByTestId('lease-history')).toContainText(reason);
    await page.goto(`/portfolio/units/${unit.id}`);
    await expect(page.getByTestId('unit-status')).toContainText('Vacant');
  });
});
