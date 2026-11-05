import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { leaseIdByUnit } from './billing-helpers';
import { PEOPLE, ready, signIn, unique } from './helpers';
import { letUnits } from './messaging-helpers';
import { fixture } from './register-helpers';
import { daysFromToday } from './tenancy-helpers';

/**
 * M7 review round (2026-11-04): new tests beside notices.spec.ts, which stays as it was. They need
 * the stack running with the demo seed (plan 4.13): the agency on Growth with an accepted OQ-16
 * statement, Abokobi on Growth without one, the individual landlord on Starter, and Yaw No-Clause
 * (ACC-LEG-B2-04), whose lease has no electronic-service clause. Each test that changes something
 * makes its own property, tenant and paper lease (30 days' notice; the paper lease's clause names
 * the tenant's phone, so WhatsApp and SMS serve), and Abokobi's acknowledgement is left off again.
 */

async function ok<T>(response: Awaited<ReturnType<Page['request']['get']>>, what: string) {
  expect(response.status(), `${what}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

interface Seen {
  id: string;
  number: string | null;
  status: string;
  issuedAt: string | null;
  approval: { id: string; status: string } | null;
  ladder: { paused: boolean; cancelled: boolean };
}

const keyed = () => ({ 'Idempotency-Key': randomUUID() });

async function draft(
  page: Page,
  body: { type: string; subtype?: string; leaseId: string; fields: Record<string, unknown> },
): Promise<Seen> {
  return ok<Seen>(
    await page.request.post('/api/v1/notices', { headers: keyed(), data: body }),
    `draft a ${body.type}`,
  );
}

/** A breach notice issued at once to a new tenant, for the tracker's controls. */
async function issuedBreach(page: Page, tag: string) {
  const [rented] = await letUnits(page, [{ name: `Kwesi Tracker ${tag} (e2e)` }]);
  const made = await draft(page, {
    type: 'breach',
    subtype: 'noise',
    leaseId: rented!.leaseId,
    fields: { particulars: `Loud generator at night ${tag}`, remedyBy: daysFromToday(14) },
  });
  const issued = await ok<Seen>(
    await page.request.post(`/api/v1/notices/${made.id}/issue`, { data: {} }),
    'issue the breach notice',
  );
  return { rented: rented!, notice: issued };
}

const quitFields = (tag: string) => ({
  particulars: `Rent unpaid for three months ${tag}`,
  effectiveDate: daysFromToday(90),
});

test.describe('LN-09 the notices dashboard', () => {
  test('the dashboard counts open notices and filters by type, status and served too late', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    await page.goto('/notices');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Notices');
    await expect(page.getByTestId('notices-summary')).toContainText('Open, by status');
    await expect(page.getByTestId('notices-summary')).toContainText('0 to 7 days');

    await page.getByLabel('Type').selectOption('notice_to_quit');
    const rows = page.getByTestId('notice-row');
    await expect(rows.first()).toBeVisible();
    for (const text of await rows.allTextContents()) expect(text).toContain('Notice to quit');
    const open = await ok<unknown[]>(
      await page.request.get('/api/v1/notices?type=notice_to_quit&open=true'),
      'open notices to quit',
    );
    await expect(rows).toHaveCount(open.length);

    await page.getByLabel('Status').selectOption('all');
    await page.getByLabel('Served too late for their date').check();
    const late = await ok<unknown[]>(
      await page.request.get('/api/v1/notices?type=notice_to_quit&servedTooLate=true'),
      'notices to quit served too late',
    );
    if (late.length === 0) await expect(page.getByText('No notice matches.')).toBeVisible();
    else await expect(rows.first()).toContainText('Served too late');
  });
});

test.describe('OQ-16 the acknowledgement turns notices to quit on and off', () => {
  test('a landlord accepts the statement by typing their name, then withdraws it', async ({
    page,
  }) => {
    await signIn(page, 'abokobi.landlord@demo.invalid');
    try {
      await page.goto('/settings/notices');
      const card = page.getByTestId('quit-acknowledgement');
      await expect(card.getByTestId('quit-enabled')).toHaveText('Off');
      await expect(card.getByTestId('quit-statement')).not.toBeEmpty();
      await expect(card).toContainText('SHA-256');
      await card
        .getByLabel('Type your full name to accept the statement')
        .fill('Akua Abokobi-Landlord');
      await card.getByRole('button', { name: 'Accept and turn notices to quit on' }).click();
      await expect(card.getByTestId('quit-enabled')).toHaveText('On');
      await expect(card).toContainText('who typed “Akua Abokobi-Landlord”');

      await card.getByRole('button', { name: 'Withdraw the acceptance' }).click();
      const withdraw = card.getByRole('form', { name: 'Withdraw the acceptance' });
      await withdraw.getByLabel('Reason').fill('Waiting for counsel’s advice');
      await withdraw.getByRole('button', { name: 'Turn notices to quit off' }).click();
      await expect(card.getByTestId('quit-enabled')).toHaveText('Off');
      await expect(card).toContainText('Withdrawn by');
    } finally {
      // Leave Abokobi as the seed has it: notices to quit off.
      const now = (await (
        await page.request.get('/api/v1/company/quit-acknowledgement')
      ).json()) as { enabled?: boolean };
      if (now.enabled)
        await page.request.post('/api/v1/company/quit-acknowledgement/withdraw', {
          data: { reason: 'End-to-end test clean-up' },
        });
    }
  });
});

test.describe('LN-05 pausing, resuming and cancelling the ladder', () => {
  test('a manager pauses the reminders, resumes them and cancels them, each with a reason', async ({
    page,
  }) => {
    const tag = unique();
    await signIn(page, PEOPLE.managerOne.email);
    const { notice } = await issuedBreach(page, tag);
    await page.goto(`/notices/${notice.id}`);
    const ladder = page.getByTestId('notice-ladder');
    await expect(ladder.getByTestId('ladder-step').first()).toBeVisible();

    const control = async (button: string, reason: string) => {
      await ladder.getByRole('button', { name: button }).click();
      const form = ladder.getByRole('form', { name: button });
      await form.getByLabel('Reason').fill(reason);
      await form.getByRole('button', { name: button }).click();
    };
    await control('Pause the reminders', `Tenant is in hospital ${tag}`);
    await expect(page.getByText('Reminders paused').first()).toBeVisible();
    expect(
      (await ok<Seen>(await page.request.get(`/api/v1/notices/${notice.id}`), 'read')).ladder,
    ).toMatchObject({ paused: true, cancelled: false });

    await control('Resume the reminders', `Tenant is home ${tag}`);
    await expect(ladder.getByRole('button', { name: 'Pause the reminders' })).toBeVisible();

    await control('Cancel the reminders', `Settled in person ${tag}`);
    await expect(page.getByText('Reminders cancelled').first()).toBeVisible();
    await expect(ladder.getByRole('button', { name: /reminders$/ })).toHaveCount(0);
    expect(
      (await ok<Seen>(await page.request.get(`/api/v1/notices/${notice.id}`), 'read')).ladder,
    ).toMatchObject({ cancelled: true });
  });
});

test.describe('LN-05 recording physical service', () => {
  test('service is recorded with who served it, a witness and a photo, and shows on the notice', async ({
    page,
  }) => {
    const tag = unique();
    await signIn(page, PEOPLE.managerOne.email);
    const { notice } = await issuedBreach(page, tag);
    await page.goto(`/notices/${notice.id}`);
    const service = page.getByTestId('notice-service');
    await ready(page, 'Record service');
    await service.getByRole('button', { name: 'Record service' }).click();
    const form = service.getByRole('form', { name: 'Record service' });
    await form.getByLabel('How it was served').selectOption('handed_to_tenant');
    await form.getByLabel('I served it myself').uncheck();
    await form.getByLabel('Who served it').fill(`Yaw Messenger ${tag}`);
    await form.getByLabel('Witness (optional)').fill(`Abena Witness ${tag}`);
    await form
      .getByLabel('Photo of the posted notice (optional)')
      .setInputFiles(fixture('property-photo.jpg'));
    await form.getByRole('button', { name: 'Record the service' }).click();

    const record = service
      .getByTestId('service-record')
      .filter({ hasText: `Yaw Messenger ${tag}` });
    await expect(record).toContainText('Handed to the tenant');
    await expect(record).toContainText(`witnessed by Abena Witness ${tag}`);
    await expect(record).toContainText('(Africa/Accra)');
    await expect(record.getByRole('button', { name: 'Open the photo' })).toBeVisible();
  });
});

test.describe('decision 13 a notice from the tenant', () => {
  test('staff record a tenant’s intention to vacate with its document, and it is listed as received', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Adwoa Leaving ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name }]);
    await page.goto(`/tenants/${rented!.tenantId}`);
    const card = page.getByTestId('tenant-notices');
    await ready(page, 'Record a notice from the tenant');
    await card.getByRole('button', { name: 'Record a notice from the tenant' }).click();
    const form = card.getByRole('form', { name: 'Record a notice from the tenant' });
    await form.getByLabel('What it is').selectOption('intention_to_vacate');
    await form.getByLabel('How it arrived').selectOption('post');
    await form.getByLabel('The document').setInputFiles(fixture('title-deed.pdf'));
    await form.getByLabel('Details (optional)').fill(`Moving to Kumasi ${tag}`);
    await form.getByRole('button', { name: 'Record it' }).click();
    await expect(card.getByText('Recorded the tenant’s intention to vacate.')).toBeVisible();
    await expect(card.getByTestId('tenant-notice').first()).toContainText('Received');
  });
});

test.describe('decision 3 Rent Officer assessments and the s.23 bar', () => {
  test('an assessment recorded on the unit bars a notice to quit', async ({ page }) => {
    const tag = unique();
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name: `Kojo Assessed ${tag} (e2e)` }]);
    await page.goto(`/portfolio/units/${rented!.unitId}`);
    const card = page.getByTestId('rent-assessments');
    await ready(page, 'Record an assessment');
    await card.getByRole('button', { name: 'Record an assessment' }).click();
    const form = card.getByRole('form', { name: 'Record an assessment' });
    await form.getByLabel('Date of the assessment').fill(daysFromToday(-30));
    await form.getByLabel('Rent Officer’s reference').fill(`RO/ACC/${tag}`);
    await form.getByRole('button', { name: 'Record the assessment' }).click();
    await expect(
      card.getByTestId('rent-assessment').filter({ hasText: `RO/ACC/${tag}` }),
    ).toBeVisible();
    await expect(card.getByTestId('assessment-bar')).toContainText(
      'notice_to_quit.assessment_bar_months',
    );

    const check = await ok<{ blockers: { code: string }[] }>(
      await page.request.post('/api/v1/notices/compose', {
        data: {
          type: 'notice_to_quit',
          subtype: 'arrears',
          leaseId: rented!.leaseId,
          fields: quitFields(tag),
        },
      }),
      'check a notice to quit',
    );
    expect(check.blockers.map((b) => b.code).join(' ')).toMatch(/quit_barred/i);
  });
});

test.describe('review item 1 the Approvals card for a notice to quit', () => {
  test('the approver sees the notice’s dates and warnings, and approves only after a confirmation that names it', async ({
    page,
    browser,
    baseURL,
  }) => {
    const tag = unique();
    const name = `Esi Approve ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name }]);
    const made = await draft(page, {
      type: 'notice_to_quit',
      subtype: 'arrears',
      leaseId: rented!.leaseId,
      fields: quitFields(tag),
    });
    const submitted = await ok<Seen>(
      await page.request.post(`/api/v1/notices/${made.id}/submit`, { data: {} }),
      'submit the notice to quit',
    );

    const second = await browser.newContext({ baseURL });
    try {
      const approver = await second.newPage();
      await signIn(approver, PEOPLE.managerTwo.email);
      await approver.goto('/approvals');
      const request = approver.locator(`[data-approval-id="${submitted.approval!.id}"]`);
      const summary = request.getByTestId('approval-notice');
      await expect(summary).toContainText(name);
      await expect(summary.getByTestId('approval-effective-date')).not.toHaveText('None');
      await expect(summary.getByTestId('approval-earliest-date')).toContainText('days');
      // The unverified statutory notice period is in front of the approver, naming its rule.
      await expect(summary.getByTestId('notice-warning').first()).toBeVisible();
      await expect(
        summary
          .getByTestId('notice-warning')
          .filter({ hasText: 'notice_to_quit.statutory_min_days' }),
      ).not.toHaveCount(0);
      await expect(
        summary.getByRole('link', { name: 'Open the notice and its preview' }),
      ).toHaveAttribute('href', `/notices/${made.id}`);

      // Other requests may be waiting too: this request's own Approve, once the notice has loaded.
      const approve = request.getByRole('button', { name: 'Approve', exact: true });
      await expect(approve).toBeEnabled();
      await approve.click();
      await expect(request.getByTestId('approve-confirm')).toContainText(name);
      await expect(request.getByTestId('approve-confirm')).toContainText('never ends the tenancy');
      await request.getByRole('button', { name: 'Yes, approve it' }).click();
      await expect(
        approver.getByText(/^Approved\. The notice (was issued|is being issued)/),
      ).toBeVisible();
    } finally {
      await second.close();
    }
  });
});

test.describe('LN-01 and decision 8 a notice to quit refused at issue after its approval', () => {
  test('when an assessment bars it before the second approval, it returns to draft and the tracker says why', async ({
    page,
    browser,
    baseURL,
  }) => {
    const tag = unique();
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name: `Kweku Barred ${tag} (e2e)` }]);
    const made = await draft(page, {
      type: 'notice_to_quit',
      subtype: 'arrears',
      leaseId: rented!.leaseId,
      fields: quitFields(tag),
    });
    const submitted = await ok<Seen>(
      await page.request.post(`/api/v1/notices/${made.id}/submit`, { data: {} }),
      'submit the notice to quit',
    );
    // A Rent Officer assessment arrives while the notice waits for approval.
    await ok(
      await page.request.post(`/api/v1/units/${rented!.unitId}/rent-assessments`, {
        headers: keyed(),
        data: { assessedOn: daysFromToday(-10), reference: `RO/LATE/${tag}` },
      }),
      'record an assessment',
    );
    const second = await browser.newContext({ baseURL });
    try {
      const approver = await second.newPage();
      await signIn(approver, PEOPLE.managerTwo.email);
      await ok(
        await approver.request.post(`/api/v1/approvals/${submitted.approval!.id}/decisions`, {
          headers: keyed(),
          data: { decision: 'approve' },
        }),
        'the second person approves',
      );
    } finally {
      await second.close();
    }
    await expect
      .poll(
        async () =>
          (await ok<Seen>(await page.request.get(`/api/v1/notices/${made.id}`), 'read')).status,
        { message: 'the barred notice to quit went back to draft', timeout: 30_000 },
      )
      .toBe('draft');
    const after = await ok<Seen>(await page.request.get(`/api/v1/notices/${made.id}`), 'read');
    expect(after.issuedAt).toBeNull();
    await page.goto(`/notices/${made.id}`);
    await expect(page.getByTestId('approved-not-issued')).toBeVisible();
    await expect(page.getByText(/s\.23|assessment/i).first()).toBeVisible();
  });
});

test.describe('decision 14 Starter has no notices', () => {
  test('a Starter landlord opening the composer is told notices are not on the plan', async ({
    page,
  }) => {
    await signIn(page, 'landlord@demo.invalid');
    await page.goto('/notices/new');
    await expect(page.getByTestId('not-on-plan')).toContainText(
      'Legal notices are not on the Starter plan.',
    );
    await expect(page.getByRole('form', { name: 'Notice' })).toHaveCount(0);
    const refused = await page.request.get('/api/v1/notices');
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { code?: string }).code?.toUpperCase()).toBe('NOT_ON_PLAN');
  });
});

test.describe('LN-01 the composer’s warnings', () => {
  test('without a clause or consent, the composer warns of physical service, withheld channels and counsel’s wording', async ({
    page,
  }) => {
    const tag = unique();
    await signIn(page, PEOPLE.managerOne.email);
    // The composer saves nothing, so the seed's lease without the clause is checked, not changed.
    const leaseId = await leaseIdByUnit(page, 'ACC-LEG-B2-04');
    await page.goto(`/notices/new?type=breach&leaseId=${leaseId}`);
    const form = page.getByRole('form', { name: 'Notice' });
    await form.getByLabel('Kind of breach').selectOption('damage');
    // The API's warnings come once the fields are complete.
    await form.getByLabel(/particulars/i).fill(`Broken window in the hall ${tag}`);
    await form.getByLabel(/remedy-by date/i).fill(daysFromToday(14));
    const warning = (code: string) =>
      page.locator(`[data-testid="notice-warning"][data-code="${code}"]`);
    await expect(warning('no_electronic_service_clause')).toBeVisible();
    await expect(warning('counsel_wording_outstanding')).toBeVisible();
    await expect(warning('no_period_enforced')).toBeVisible();
    const plan = page.getByTestId('compose-recipients');
    await expect(
      plan.locator('[data-testid="planned-channel"][data-mode="withheld"]'),
    ).not.toHaveCount(0);
    await expect(plan.getByTestId('physical-service-planned')).toBeVisible();
  });
});

test.describe('LN-01, LN-02 and OQ-16 exact refusals', () => {
  test('the API refuses with named 409s: a too-early date, a change after issue, and a notice to quit before OQ-16', async ({
    page,
    browser,
    baseURL,
  }) => {
    const tag = unique();
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name: `Yaa Exact ${tag} (e2e)` }]);
    const early = await draft(page, {
      type: 'rent_review',
      leaseId: rented!.leaseId,
      fields: {
        currentRentMinor: 90_000,
        newRentMinor: 100_000,
        effectiveDate: daysFromToday(5),
        reason: `Market review ${tag}`,
      },
    });
    const refused = await page.request.post(`/api/v1/notices/${early.id}/issue`, { data: {} });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { code?: string }).code).toMatch(/EFFECTIVE_DATE_TOO_EARLY/i);

    const { notice } = await issuedBreach(page, tag);
    const changed = await page.request.patch(`/api/v1/notices/${notice.id}`, {
      data: { fields: { particulars: 'Changed afterwards', remedyBy: daysFromToday(14) } },
    });
    expect(changed.status()).toBe(409);
    expect(((await changed.json()) as { code?: string }).code).toMatch(/FROZEN/i);

    // Abokobi signs in in a browser of its own: this page is still signed in as Kofi.
    const other = await browser.newContext({ baseURL });
    try {
      const landlord = await other.newPage();
      await signIn(landlord, 'abokobi.landlord@demo.invalid');
      const leases = await ok<{ id: string; unit: { code: string }; status: string }[]>(
        await landlord.request.get('/api/v1/leases?search=ACC-ABK-B1-01'),
        'find the Abokobi lease',
      );
      const lease = leases.find((l) => l.unit.code === 'ACC-ABK-B1-01' && l.status !== 'cancelled');
      const quit = await landlord.request.post('/api/v1/notices', {
        headers: keyed(),
        data: {
          type: 'notice_to_quit',
          subtype: 'arrears',
          leaseId: lease!.id,
          fields: quitFields(tag),
        },
      });
      expect(quit.status()).toBe(409);
      expect(((await quit.json()) as { code?: string }).code).toMatch(/QUIT_NOT_ENABLED/i);
    } finally {
      await other.close();
    }
  });
});
