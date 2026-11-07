import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { money, toDecimal } from '@rent/domain/money';
import { MOVE_OUT_STATUS_LABELS, type MoveOutStatus } from '@rent/domain/moveout';
import { PEOPLE, ready, signIn, unique } from './helpers';
import { keyed, uploadJobPhoto } from './maintenance-helpers';
import { fixture } from './register-helpers';
import { cedis, fundLeaseOwner } from './tax-helpers';
import { daysFromToday, newPropertyWithUnits, newTenant, termEnd, today } from './tenancy-helpers';

/**
 * M8 review (WEB 8): tests that make everything they need, so they never consume the seed or
 * depend on what it happened to add. A move-out from the deposit paid to the refund recorded,
 * with an inspection, a deduction backed by its photo, and the second person's approval; and an
 * inspection's note read back after it was saved, with Submit held while a chosen photo is not
 * yet added.
 */

async function ok<T>(
  response: Awaited<ReturnType<APIRequestContext['get']>>,
  what: string,
): Promise<T> {
  expect(response.status(), `${what}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

/** A file sent to storage through a presigned upload; the upload's id. */
async function upload(
  request: APIRequestContext,
  path: string,
  data: Record<string, unknown>,
  file: { readonly name: string; readonly type: string },
): Promise<string> {
  const bytes = readFileSync(fixture(file.name));
  const slot = await ok<{ uploadId: string; url: string; fields: Record<string, string> }>(
    await request.post(path, {
      data: { ...data, contentType: file.type, sizeBytes: bytes.length },
    }),
    `ask for an upload at ${path}`,
  );
  const form = new FormData();
  for (const [key, value] of Object.entries(slot.fields)) form.append(key, value);
  form.append('file', new Blob([bytes], { type: file.type }), file.name);
  const stored = await fetch(slot.url, { method: 'POST', body: form });
  expect(stored.ok, `upload ${file.name}: ${stored.status}`).toBe(true);
  return slot.uploadId;
}

interface Lease {
  readonly leaseId: string;
  readonly unitCode: string;
}

/**
 * A paper lease for Owner A's new unit, started yesterday, with a GH₵1,000 deposit. It is billed
 * from its start date: a paper lease billed from a later date gets no deposit invoice
 * (`depositDue`), and cash paid on it would only become credit.
 */
async function leaseWithDeposit(page: Page, tag: string): Promise<Lease> {
  const { units } = await newPropertyWithUnits(page, 1);
  const name = `Adjoa Move-Out ${tag} (e2e)`;
  const tenant = await newTenant(page, name);
  const scan = await upload(
    page.request,
    '/api/v1/lease-uploads',
    {},
    { name: 'title-deed.pdf', type: 'application/pdf' },
  );
  const start = daysFromToday(-1);
  const lease = await ok<{ id: string }>(
    await page.request.post('/api/v1/leases/paper', {
      data: {
        unitId: units[0]!.id,
        tenantId: tenant.id,
        startDate: start,
        endDate: termEnd(start, 12),
        monthlyRentMinor: 50_000,
        depositMinor: 100_000,
        cycle: 'monthly',
        noticeDays: 30,
        parties: [{ role: 'tenant', name, paperSignedOn: daysFromToday(-3) }],
        scanUploadId: scan,
        signedOn: daysFromToday(-3),
        billingStartDate: start,
      },
    }),
    'record the paper lease with a deposit',
  );
  return { leaseId: lease.id, unitCode: units[0]!.code };
}

/**
 * The deposit and the first month paid in cash, approved by a second person, until the ledger
 * holds the deposit. Cash pays the oldest debt first, and the deposit and the first month are both
 * due on the start date, so the cash covers both.
 */
async function payDeposit(
  browser: Browser,
  baseURL: string | undefined,
  page: Page,
  lease: Lease,
): Promise<number> {
  const photoUploadId = await upload(
    page.request,
    '/api/v1/payment-uploads',
    { purpose: 'cash_photo' },
    { name: 'property-photo.jpg', type: 'image/jpeg' },
  );
  const recorded = await ok<{ approval: { id: string } }>(
    await page.request.post('/api/v1/cash-records', {
      headers: keyed(),
      data: {
        leaseId: lease.leaseId,
        method: 'cash',
        amountMinor: 150_000,
        receivedOn: today(),
        payerName: 'Adjoa (e2e)',
        photoUploadId,
      },
    }),
    'record the deposit in cash',
  );
  const second = await browser.newContext({ baseURL });
  try {
    const approver = await second.newPage();
    await signIn(approver, PEOPLE.managerTwo.email);
    await ok(
      await approver.request.post(`/api/v1/approvals/${recorded.approval.id}/decisions`, {
        headers: keyed(),
        data: { decision: 'approve' },
      }),
      'approve the cash',
    );
  } finally {
    await second.close();
  }
  let held = 0;
  await expect
    .poll(
      async () => {
        held = (
          await ok<{ depositHeldMinor: number }>(
            await page.request.get(`/api/v1/leases/${lease.leaseId}/billing`),
            'read the lease’s money',
          )
        ).depositHeldMinor;
        return held;
      },
      { message: 'the deposit is held once the cash posts', timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  return held;
}

interface InspectionItemRow {
  readonly id: string;
  readonly roomLabel: string;
  readonly itemLabel: string;
  readonly photos: readonly { readonly id: string }[];
}

/** The move-out planned for today, inspected: one item damaged with its photo, the rest good. */
async function plannedAndInspected(
  page: Page,
  lease: Lease,
): Promise<{ moveOutId: string; damaged: InspectionItemRow }> {
  const planned = await ok<{ id: string }>(
    await page.request.post(`/api/v1/leases/${lease.leaseId}/move-outs`, {
      data: { plannedDate: today(), reason: 'tenant_notice', note: 'Moving to Kumasi (e2e)' },
    }),
    'plan the move-out',
  );
  const started = await ok<{ inspectionId: string | null }>(
    await page.request.post(`/api/v1/move-outs/${planned.id}/inspection`),
    'start the move-out inspection',
  );
  const inspectionId = started.inspectionId!;
  const detail = await ok<{ items: InspectionItemRow[] }>(
    await page.request.get(`/api/v1/inspections/${inspectionId}`),
    'read the inspection',
  );
  const [first, ...rest] = detail.items;
  await ok(
    await page.request.patch(`/api/v1/inspections/${inspectionId}/items/${first!.id}`, {
      data: { condition: 'damaged', note: 'Hole in the door (e2e)' },
    }),
    'record the damage',
  );
  const photo = await upload(
    page.request,
    '/api/v1/inspection-uploads',
    {},
    { name: 'property-photo.jpg', type: 'image/jpeg' },
  );
  const damaged = await ok<InspectionItemRow>(
    await page.request.post(`/api/v1/inspections/${inspectionId}/items/${first!.id}/photos`, {
      data: { uploadIds: [photo] },
    }),
    'add the photo of the damage',
  );
  for (const item of rest)
    await ok(
      await page.request.patch(`/api/v1/inspections/${inspectionId}/items/${item.id}`, {
        data: { condition: 'good' },
      }),
      'record an item',
    );
  await ok(
    await page.request.post(`/api/v1/inspections/${inspectionId}/submit`),
    'submit the inspection',
  );
  return { moveOutId: planned.id, damaged };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * As a manager: a lease with its deposit paid, the move-out planned and inspected, the deductions
 * tried and made on screen, and the settlement sent for approval.
 */
async function askedForSettlement(
  browser: Browser,
  baseURL: string | undefined,
  tag: string,
): Promise<{ leaseId: string; approvalId: string }> {
  const asker = await browser.newContext({ baseURL });
  try {
    const page = await asker.newPage();
    await signIn(page, PEOPLE.managerOne.email);
    const lease = await leaseWithDeposit(page, tag);
    const leaseId = lease.leaseId;
    const held = await payDeposit(browser, baseURL, page, lease);
    const { damaged } = await plannedAndInspected(page, lease);

    await page.goto(`/leases/${leaseId}/move-out`);
    const deductions = page.getByTestId('move-out-deductions');
    await expect(deductions.getByTestId('deposit-left-amount')).toHaveText(cedis(held));

    // More than the deposit is refused before it is sent.
    await ready(page, 'Add a deduction');
    await deductions.getByRole('button', { name: 'Add a deduction' }).click();
    let form = page.getByRole('form', { name: 'Add a deduction' });
    await form.getByLabel('For').selectOption({ label: 'Cleaning' });
    await form.getByLabel('Amount (GH₵)').fill(toDecimal(money(held + 100)));
    await form.getByLabel('Reason').fill(`More than the deposit ${tag} (e2e)`);
    await form.getByRole('button', { name: 'Add the deduction' }).click();
    await expect(form).toContainText(`Only ${cedis(held)} of the deposit is left.`);
    await form.getByRole('button', { name: 'Cancel' }).click();

    // Damage, backed by the inspection item and its photo.
    const amount = Math.min(30_000, held);
    await deductions.getByRole('button', { name: 'Add a deduction' }).click();
    form = page.getByRole('form', { name: 'Add a deduction' });
    await form.getByLabel('For').selectOption({ label: 'Damage' });
    await form.getByLabel('Amount (GH₵)').fill(toDecimal(money(amount)));
    await form.getByLabel('Reason').fill(`Replace the damaged door ${tag} (e2e)`);
    await form
      .getByLabel(new RegExp(`^${escape(damaged.roomLabel)}, ${escape(damaged.itemLabel)}:`))
      .check();
    await form.getByLabel(`${damaged.itemLabel}, photo 1`).check();
    await form.getByRole('button', { name: 'Add the deduction' }).click();
    await expect(page.getByText(`Added the deduction of ${cedis(amount)}.`)).toBeVisible();
    const deduction = deductions.getByTestId('deduction').first();
    await expect(deduction.getByTestId('media-view')).toHaveCount(1);
    await expect(deduction.getByTestId('media-when')).toContainText('taken');

    // The statement balances, as the domain checks it.
    const statement = page.getByTestId('move-out-statement');
    await expect(statement.getByTestId('statement-balance')).toHaveAttribute(
      'data-balances',
      'true',
    );
    await expect(statement.getByTestId('statement-deposit')).toContainText(cedis(held));

    await page
      .getByTestId('move-out-submit')
      .getByRole('button', { name: 'Ask for approval' })
      .click();
    await expect(page.getByText('Asked for the settlement.')).toBeVisible();
    const sent = await ok<{ approval: { id: string } | null }>(
      await page.request.get(`/api/v1/move-outs?leaseId=${leaseId}`).then(async (r) => {
        const [row] = (await r.json()) as { id: string }[];
        return page.request.get(`/api/v1/move-outs/${row!.id}`);
      }),
      'read the move-out',
    );
    const approvalId = sent.approval!.id;
    await page.goto('/approvals');
    const card = page.locator(`[data-approval-id="${approvalId}"]`);
    await expect(card).toContainText(
      'Waiting for a second person. You asked, so you cannot approve this yourself.',
    );
    await expect(card.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    return { leaseId, approvalId };
  } finally {
    await asker.close();
  }
}

test.describe('TL-11 and MI-11 a move-out made for the test, from the deposit to the refund', () => {
  test('a deduction backed by its photo, a refusal over the deposit, a balanced statement, a second approver and the refund recorded', async ({
    browser,
    baseURL,
  }) => {
    const tag = unique();
    const { leaseId, approvalId } = await askedForSettlement(browser, baseURL, tag);

    const approver = await browser.newContext({ baseURL });
    try {
      const page = await approver.newPage();
      await signIn(page, PEOPLE.agencyAdmin.email);
      await page.goto('/approvals');
      const card = page.locator(`[data-approval-id="${approvalId}"]`);
      await expect(card.getByTestId('statement-balance')).toHaveAttribute('data-balances', 'true');
      await expect(card.getByTestId('deduction').first().getByTestId('media-view')).toHaveCount(1);
      await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
      await card.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(page.getByText('It has taken effect.')).toBeVisible();
    } finally {
      await approver.close();
    }

    // The refund, paid outside the platform, is recorded with its reference and proof.
    const back = await browser.newContext({ baseURL });
    try {
      const page = await back.newPage();
      await signIn(page, PEOPLE.managerOne.email);
      const [row] = await ok<{ id: string }[]>(
        await page.request.get(`/api/v1/move-outs?leaseId=${leaseId}`),
        'list the move-outs',
      );
      const settled = await ok<{
        status: MoveOutStatus;
        statement: { refundMinor: number } | null;
      }>(await page.request.get(`/api/v1/move-outs/${row!.id}`), 'read the settled move-out');
      await page.goto(`/leases/${leaseId}/move-out`);
      await expect(page.getByTestId('move-out-status')).toHaveText(
        MOVE_OUT_STATUS_LABELS[settled.status],
      );
      if ((settled.statement?.refundMinor ?? 0) === 0) return;
      expect(settled.status).toBe('approved');
      // F3 setup (founder-approved, 2026-11-07): the owner's funding first, so the agency holds the
      // refund for the owner before it is paid from the agency's account.
      await fundLeaseOwner(page, leaseId, settled.statement!.refundMinor);
      const refund = page.getByRole('form', { name: 'Record the refund as paid' });
      await refund.getByLabel('Transfer or MoMo reference').fill(`TRF-${tag}`);
      const paidFrom = refund.getByLabel('Paid from');
      if (await paidFrom.count()) await paidFrom.selectOption({ label: 'The agency’s account' });
      await refund.getByLabel('Proof of the refund').setInputFiles(fixture('title-deed.pdf'));
      await refund.getByRole('button', { name: 'Record the refund as paid' }).click();
      await expect(
        page.getByText(`Recorded the refund of ${cedis(settled.statement!.refundMinor)} as paid.`),
      ).toBeVisible();
      await expect(page.getByTestId('refund-paid')).toContainText(`TRF-${tag}`);
    } finally {
      await back.close();
    }
  });
});

test.describe('MI-10 an inspection keeps what was entered on the phone', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('a note is read back after saving, and Submit waits for a chosen photo to be added', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const { units } = await newPropertyWithUnits(page, 1);
    const inspection = await ok<{ id: string; items: { id: string }[] }>(
      await page.request.post('/api/v1/inspections', {
        data: { unitId: units[0]!.id, kind: 'routine' },
      }),
      'start the inspection',
    );

    await page.goto(`/inspections/${inspection.id}`);
    const first = page.getByTestId('inspection-item').first();
    const note = first.getByRole('textbox');
    const text = `Small crack above the window ${unique()} (e2e)`;
    await note.fill(text);
    await note.blur();
    // A tap straight after the blur still counts: the condition is not held by the note's save.
    await first.getByText('Fair', { exact: true }).click();
    await expect(first.getByRole('radio', { name: 'Fair' })).toBeChecked();
    await expect(first.getByRole('status')).toHaveCount(0);
    const saved = await ok<{
      items: { id: string; note: string | null; condition: string | null }[];
    }>(await page.request.get(`/api/v1/inspections/${inspection.id}`), 'read the inspection back');
    expect(saved.items.find((i) => i.id === inspection.items[0]!.id)).toMatchObject({
      note: text,
      condition: 'fair',
    });
    await page.reload();
    await expect(page.getByTestId('inspection-item').first().getByRole('textbox')).toHaveValue(
      text,
    );

    // Every item has a condition, but a chosen photo not yet added holds the submission.
    const items = page.getByTestId('inspection-item');
    const count = await items.count();
    for (let index = 1; index < count; index += 1) {
      await items.nth(index).getByText('Good', { exact: true }).click();
      await expect(items.nth(index).getByRole('radio', { name: 'Good' })).toBeChecked();
    }
    const again = page.getByTestId('inspection-item').first();
    await again.locator('input[type="file"]').setInputFiles(fixture('property-photo.jpg'));
    await expect(again.getByTestId('photos-unsent')).toBeVisible();
    await expect(page.getByTestId('inspection-submit')).toContainText(
      '1 chosen photo has not been added yet',
    );
    await expect(page.getByRole('button', { name: 'Submit the inspection' })).toBeDisabled();
    await again.getByRole('button', { name: 'Add the photo' }).click();
    await expect(again.getByTestId('media-view')).toHaveCount(1);
    await expect(again.getByTestId('media-when')).toContainText('taken');
    await expect(page.getByRole('button', { name: 'Submit the inspection' })).toBeEnabled();
  });
});

test.describe('F3 an expense without a receipt is flagged', () => {
  test('the expense list and the job show “No receipt”', async ({ page }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const { propertyId, units } = await newPropertyWithUnits(page, 1);
    const job = await ok<{ id: string }>(
      await page.request.post('/api/v1/maintenance-jobs', {
        headers: keyed(),
        data: {
          propertyId,
          unitId: units[0]!.id,
          description: `A loose socket ${unique()} (e2e)`,
          uploadIds: [await uploadJobPhoto(page)],
        },
      }),
      'log the repair',
    );
    const supplier = `Ama Electrical ${unique()} (e2e)`;
    await ok(
      await page.request.post('/api/v1/expenses', {
        headers: keyed(),
        data: {
          propertyId,
          jobId: job.id,
          category: 'repairs',
          supplierName: supplier,
          amountMinor: 12_000,
          expenseDate: today(),
          paidBy: 'unpaid',
        },
      }),
      'record the expense without a receipt',
    );
    await page.goto(`/expenses?jobId=${job.id}`);
    const row = page.getByTestId('expense-row').filter({ hasText: supplier });
    await expect(row.getByTestId('no-receipt')).toHaveText('No receipt');
    await page.goto(`/repairs/${job.id}`);
    await expect(
      page.getByTestId('job-expense').filter({ hasText: supplier }).getByTestId('no-receipt'),
    ).toHaveText('No receipt');
  });
});
