import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { leaseIdByUnit, phoneSession, type PhonePerson } from './billing-helpers';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';
import { letUnits } from './messaging-helpers';
import { propertyByCode } from './register-helpers';
import { daysFromToday } from './tenancy-helpers';

/**
 * M7: legal notices on staff screens (plan sections 4.10 and 6). Needs the stack running with
 * the demo seed (plan 4.13): the agency on Growth with an accepted OQ-16 statement, the tenant 95
 * days in arrears (Esi, ACC-LEG-B2-02) with a notice to quit at Escalated, served by posting, and
 * open caretaker tasks. Abokobi has not accepted the statement. Each other test makes its own
 * property, tenant and lease; their paper leases carry 30 days' notice and no electronic-service
 * clause, so service is physical.
 */

const KOJO: PhonePerson = {
  phone: '+233200000011',
  name: 'Kojo Caretaker (demo)',
  typed: '020 000 0011',
  label: 'kojo',
};

async function ok<T>(response: Awaited<ReturnType<Page['request']['get']>>, what: string) {
  expect(response.status(), `${what}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

interface NoticeSeen {
  id: string;
  number: string | null;
  status: string;
  outcome: string | null;
  issuedAt: string | null;
  approval: { id: string; status: string } | null;
}

/** A draft through the API, as the signed-in person. */
async function draftNotice(
  page: Page,
  body: { type: string; subtype?: string | null; leaseId: string; fields: Record<string, unknown> },
): Promise<NoticeSeen> {
  return ok<NoticeSeen>(
    await page.request.post('/api/v1/notices', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: body,
    }),
    `draft a ${body.type}`,
  );
}

const breach = (tag: string) => ({
  type: 'breach',
  subtype: 'noise',
  fields: { particulars: `Loud music after midnight ${tag}`, remedyBy: daysFromToday(14) },
});

test.describe('LN-01 the earliest lawful effective date', () => {
  test('the composer refuses a notice to quit dated before the earliest lawful date, and issue refuses it again', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Kofi Early ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name }]);

    await page.goto(`/notices/new?type=notice_to_quit&leaseId=${rented!.leaseId}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('New notice');
    const form = page.getByRole('form', { name: 'Notice' });
    await expect(form.getByLabel('Type of notice')).toHaveValue('notice_to_quit');
    await form.getByLabel('Ground').selectOption('arrears');
    await form.getByLabel(/particulars/i).fill(`Rent unpaid since September ${tag}`);
    // The lease gives 30 days' notice; five days is too soon.
    await form.getByLabel(/effective date/i).fill(daysFromToday(5));
    await expect(page.getByTestId('effective-problem')).toContainText(
      'earlier than the earliest lawful date',
    );
    await expect(page.getByTestId('earliest-date')).toContainText('30 days');
    // While counsel has not verified the statutory minimum, the composer says so, naming the rule.
    await expect(
      page.getByTestId('notice-warning').filter({ hasText: 'notice_to_quit.statutory_min_days' }),
    ).not.toHaveCount(0);

    // A date far enough out clears the problem.
    await form.getByLabel(/effective date/i).fill(daysFromToday(60));
    await expect(page.getByTestId('effective-problem')).toHaveCount(0);

    // The API refuses issuing a too-early notice, however it is reached.
    const draft = await draftNotice(page, {
      type: 'rent_review',
      leaseId: rented!.leaseId,
      fields: {
        currentRentMinor: 90_000,
        newRentMinor: 100_000,
        effectiveDate: daysFromToday(5),
        reason: `Market review ${tag}`,
      },
    });
    const refused = await page.request.post(`/api/v1/notices/${draft.id}/issue`, { data: {} });
    expect(refused.status(), 'issuing a rent review dated too soon').not.toBe(200);
    await page.goto(`/notices/${draft.id}`);
    await expect(page.getByTestId('notice-blockers')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Issue now' })).toBeDisabled();
  });
});

test.describe('LN-02 and plan 4.8 an issued notice is never edited; a correction replaces it', () => {
  test('an issued notice cannot be changed, and its correction references it and closes it as superseded', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Ama Correct ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name }]);
    const original = await draftNotice(page, { ...breach(tag), leaseId: rented!.leaseId });
    const issued = await ok<NoticeSeen>(
      await page.request.post(`/api/v1/notices/${original.id}/issue`, { data: {} }),
      'issue the breach notice',
    );
    expect(issued.number).toMatch(/^N-\d{6}$/);

    // Frozen: no edit on screen, and the API refuses a change.
    await page.goto(`/notices/${original.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(issued.number!);
    await expect(page.getByRole('link', { name: 'Edit the draft' })).toHaveCount(0);
    await expect(page.getByTestId('notice-facts')).toContainText('Frozen at issue');
    const changed = await page.request.patch(`/api/v1/notices/${original.id}`, {
      data: { fields: { ...breach(tag).fields, particulars: 'Changed afterwards' } },
    });
    expect(changed.status(), 'changing an issued notice').not.toBe(200);

    // The correction is a new draft that names the original.
    await ready(page, 'Correct with a new notice');
    await page.getByRole('button', { name: 'Correct with a new notice' }).click();
    await expect(page).toHaveURL(/\/notices\/[0-9a-f-]{36}\/edit$/);
    const correctionId = /\/notices\/([0-9a-f-]{36})\/edit/.exec(page.url())![1]!;
    expect(correctionId).not.toBe(original.id);
    await expect(page.getByText(`This draft corrects ${issued.number}`)).toBeVisible();
    const form = page.getByRole('form', { name: 'Notice' });
    await form.getByLabel(/particulars/i).fill(`Loud music after midnight, every weekend ${tag}`);
    await ready(page, 'Save the draft');
    await form.getByRole('button', { name: 'Save the draft' }).click();
    await expect(page).toHaveURL(new RegExp(`/notices/${correctionId}\\?saved=1$`));
    await expect(page.getByTestId('notice-corrects')).toContainText(issued.number!);
    await ready(page, 'Issue now');
    await page.getByRole('button', { name: 'Issue now' }).click();
    await expect(page.getByTestId('notice-status').first()).not.toHaveText('Draft');

    // The original stays as issued, closed as superseded, and names its replacement.
    const after = await ok<NoticeSeen & { correctedBy: { id: string } | null }>(
      await page.request.get(`/api/v1/notices/${original.id}`),
      'read the original',
    );
    expect(after.status).toBe('closed');
    expect(after.outcome).toBe('superseded');
    expect(after.correctedBy?.id).toBe(correctionId);
    await page.goto(`/notices/${original.id}`);
    await expect(page.getByTestId('notice-outcome').first()).toHaveText(
      'Superseded by a correction',
    );
    await expect(page.getByTestId('notice-corrected-by')).toBeVisible();
  });
});

test.describe('OQ-16 and decision 8 notices to quit need the acknowledgement and two people', () => {
  test('a company that has not accepted the OQ-16 statement cannot issue a notice to quit', async ({
    page,
  }) => {
    await signIn(page, 'abokobi.landlord@demo.invalid');
    const ack = await ok<{ enabled: boolean }>(
      await page.request.get('/api/v1/company/quit-acknowledgement'),
      'read the acknowledgement',
    );
    expect(ack.enabled, 'the seed leaves Abokobi without the OQ-16 acknowledgement').toBe(false);
    const leaseId = await leaseIdByUnit(page, 'ACC-ABK-B1-01');

    await page.goto(`/notices/new?type=notice_to_quit&leaseId=${leaseId}`);
    await expect(
      page.getByText('Notices to quit are turned off for your company').first(),
    ).toBeVisible();

    const check = await ok<{ blockers: { code: string }[] }>(
      await page.request.post('/api/v1/notices/compose', {
        data: {
          type: 'notice_to_quit',
          subtype: 'other',
          leaseId,
          fields: {
            particulars: 'A check by the end-to-end tests',
            effectiveDate: daysFromToday(120),
          },
        },
      }),
      'check a notice to quit',
    );
    expect(check.blockers.map((b) => b.code).join(' ')).toMatch(/quit_not_enabled/i);
  });

  test('the person who submits a notice to quit cannot approve it; a second person’s approval issues it', async ({
    page,
    browser,
    baseURL,
  }) => {
    const tag = unique();
    const name = `Yaw Quit ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name }]);
    const draft = await draftNotice(page, {
      type: 'notice_to_quit',
      subtype: 'arrears',
      leaseId: rented!.leaseId,
      fields: {
        particulars: `Rent unpaid for three months ${tag}`,
        effectiveDate: daysFromToday(90),
      },
    });
    const submitted = await ok<NoticeSeen>(
      await page.request.post(`/api/v1/notices/${draft.id}/submit`, { data: {} }),
      'submit the notice to quit',
    );
    expect(submitted.approval?.status).toBe('pending');
    const approvalId = submitted.approval!.id;

    // On screen: no Issue for a notice to quit, and the initiator is told someone else approves.
    await page.goto(`/notices/${draft.id}`);
    await expect(page.getByRole('button', { name: 'Issue now' })).toHaveCount(0);
    await expect(page.getByTestId('notice-approval')).toContainText('someone else must approve it');
    await nav(page).getByRole('link', { name: 'Approvals' }).click();
    const request = page.locator(`[data-approval-id="${approvalId}"]`);
    await expect(request).toContainText('Issue a notice to quit');
    await expect(request.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    const own = await page.request.post(`/api/v1/approvals/${approvalId}/decisions`, {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { decision: 'approve' },
    });
    expect(own.status(), 'the initiator approving their own notice to quit').toBe(403);

    // A second manager approves; the notice issues itself.
    const second = await browser.newContext({ baseURL });
    try {
      const approver = await second.newPage();
      await signIn(approver, PEOPLE.managerTwo.email);
      await ok(
        await approver.request.post(`/api/v1/approvals/${approvalId}/decisions`, {
          headers: { 'Idempotency-Key': randomUUID() },
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
          (await ok<NoticeSeen>(await page.request.get(`/api/v1/notices/${draft.id}`), 'read'))
            .issuedAt,
        { message: 'the approved notice to quit issued itself', timeout: 30_000 },
      )
      .not.toBeNull();
  });
});

test.describe('LN-05 an unsigned notice still reaches escalation', () => {
  test('the seed’s unsigned notice to quit has escalated, with its service pack and the posting on the premises', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const leaseId = await leaseIdByUnit(page, 'ACC-LEG-B2-02');
    const notices = await ok<{ id: string; status: string; signedRecipients: number }[]>(
      await page.request.get(`/api/v1/notices?type=notice_to_quit&leaseId=${leaseId}`),
      'list the notices to quit on ACC-LEG-B2-02',
    );
    const escalated = notices.find((n) => n.signedRecipients === 0 && n.status === 'served');
    expect(escalated, 'the seed’s notice to quit, served by posting (plan 4.13)').toBeTruthy();

    await page.goto(`/notices/${escalated!.id}`);
    await expect(page.getByTestId('notice-status').first()).toHaveText('Served');
    await expect(
      page.locator('[data-testid="notice-event"][data-kind="escalated"]'),
    ).not.toHaveCount(0);
    await expect(
      page.locator('[data-testid="notice-event"][data-kind="service_pack_ready"]'),
    ).not.toHaveCount(0);
    // Nobody signed, and the notice went on regardless.
    const detail = await ok<{ recipients: { signedAt: string | null }[] }>(
      await page.request.get(`/api/v1/notices/${escalated!.id}`),
      'read the notice',
    );
    expect(detail.recipients.every((r) => r.signedAt === null)).toBe(true);
    // The pack is there to open, and the posting on the premises is recorded.
    await expect(
      page
        .getByTestId('notice-documents')
        .getByRole('button', { name: 'Open the physical service pack' }),
    ).toBeVisible();
    const pack = await ok<{ url: string }>(
      await page.request.get(`/api/v1/notices/${escalated!.id}/files/service_pack`),
      'a link to the service pack',
    );
    expect(pack.url).toMatch(/^https?:\/\//);
    await expect(
      page.getByTestId('service-record').filter({ hasText: 'Posted on the premises' }),
    ).not.toHaveCount(0);
  });
});

test.describe('LN-03 and plan 4.8 every status change is on the tenant’s timeline', () => {
  test('issuing and closing a notice show on the tenant’s timeline with its number', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Esi Timeline ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const [rented] = await letUnits(page, [{ name }]);
    const draft = await draftNotice(page, { ...breach(tag), leaseId: rented!.leaseId });
    const issued = await ok<NoticeSeen>(
      await page.request.post(`/api/v1/notices/${draft.id}/issue`, { data: {} }),
      'issue the breach notice',
    );

    // Closing it with an outcome, on the tracker.
    await page.goto(`/notices/${draft.id}`);
    await ready(page, 'Close the notice');
    await page.getByRole('button', { name: 'Close the notice' }).click();
    const close = page.getByRole('form', { name: 'Close the notice' });
    await close.getByLabel('Outcome').selectOption('complied');
    await close.getByLabel('Note').fill(`The music stopped ${tag}`);
    await close.getByRole('button', { name: 'Close with this outcome' }).click();
    await expect(page.getByTestId('notice-closed')).toContainText('Complied');

    await page.goto(`/tenants/${rented!.tenantId}`);
    const timeline = page.getByTestId('timeline');
    const entry = (kind: string) =>
      timeline
        .locator(`[data-testid="timeline-notice"][data-kind="${kind}"]`)
        .filter({ hasText: issued.number! });
    await expect(entry('sent')).toHaveCount(1);
    await expect(entry('closed')).toContainText('Complied');
    await expect(entry('sent')).toContainText('(Africa/Accra)');
    // The profile lists the notice too.
    await expect(
      page
        .getByTestId('tenant-notices')
        .getByTestId('tenant-notice')
        .filter({ hasText: issued.number! }),
    ).toBeVisible();
  });
});

test.describe('CF-06 caretakers see their tasks', () => {
  test('Kojo sees the open tasks for the Legon compound house, and only those', async ({
    page,
    browser,
    baseURL,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const legon = await propertyByCode(page, 'ACC-LEG');
    const field = await phoneSession(browser, baseURL!, KOJO);
    try {
      const caretaker = await field.newPage();
      await caretaker.goto('/');
      await nav(caretaker).getByRole('link', { name: 'Tasks', exact: true }).click();
      await expect(caretaker.getByRole('heading', { level: 1 })).toHaveText('Tasks');
      const rows = caretaker.getByTestId('task-row');
      await expect(rows.first()).toBeVisible();
      await expect(rows.first().getByRole('button', { name: 'Mark done' })).toBeVisible();
      const all = await ok<{ property: { id: string }; mayComplete: boolean }[]>(
        await caretaker.request.get('/api/v1/tasks'),
        'Kojo’s tasks',
      );
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((t) => t.property.id === legon.id)).toBe(true);
    } finally {
      await field.close();
    }
  });
});
