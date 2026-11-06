import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { fixture } from './register-helpers';

/**
 * Helpers for the M8 specs (maintenance, inspections, move-out). Records are made through the API
 * as the signed-in person, and files go straight to storage as the browser sends them.
 */

export interface JobRef {
  readonly id: string;
  readonly ticket: string;
  readonly status: string;
  readonly costMinor: number;
}

async function ok<T>(
  response: Awaited<ReturnType<APIRequestContext['get']>>,
  what: string,
): Promise<T> {
  expect(response.status(), `${what}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

export const keyed = () => ({ 'Idempotency-Key': randomUUID() });

/** A photo for a job, uploaded through `POST /maintenance-uploads`; its upload id. */
export async function uploadJobPhoto(
  page: Page,
  path = '/api/v1/maintenance-uploads',
): Promise<string> {
  const photo = readFileSync(fixture('property-photo.jpg'));
  const slot = await ok<{ uploadId: string; url: string; fields: Record<string, string> }>(
    await page.request.post(path, { data: { contentType: 'image/jpeg', sizeBytes: photo.length } }),
    'ask for an upload',
  );
  const form = new FormData();
  for (const [key, value] of Object.entries(slot.fields)) form.append(key, value);
  form.append('file', new Blob([photo], { type: 'image/jpeg' }), 'repair.jpg');
  const stored = await fetch(slot.url, { method: 'POST', body: form });
  expect(stored.ok, `upload the photo: ${stored.status}`).toBe(true);
  return slot.uploadId;
}

/** A repair logged by staff on a unit, with its photos. */
export async function newJob(
  page: Page,
  job: {
    readonly propertyId: string;
    readonly unitId: string;
    readonly description: string;
    readonly uploadIds?: readonly string[];
  },
): Promise<JobRef> {
  return ok<JobRef>(
    await page.request.post('/api/v1/maintenance-jobs', {
      headers: keyed(),
      data: {
        propertyId: job.propertyId,
        unitId: job.unitId,
        description: job.description,
        uploadIds: job.uploadIds ?? [],
      },
    }),
    'log the repair',
  );
}

/** Triaged, assigned to the signed-in person and started with a reason: In progress. */
export async function jobInProgress(page: Page, jobId: string, personId: string): Promise<void> {
  await ok(
    await page.request.post(`/api/v1/maintenance-jobs/${jobId}/triage`, {
      data: { priority: 'routine', category: 'plumbing' },
    }),
    'triage the job',
  );
  await ok(
    await page.request.post(`/api/v1/maintenance-jobs/${jobId}/assign`, {
      data: { assignee: { kind: 'staff', personId } },
    }),
    'assign the job',
  );
  const started = await ok<{ status: string }>(
    await page.request.post(`/api/v1/maintenance-jobs/${jobId}/start`, {
      data: { uploadIds: [], beforePhotoReason: 'Emergency: no time for a photo (e2e)' },
    }),
    'start the work',
  );
  expect(started.status).toBe('in_progress');
}

/** An expense on the job (P15), owed to the supplier. */
export async function newExpense(
  page: Page,
  expense: {
    readonly propertyId: string;
    readonly jobId: string;
    readonly amountMinor: number;
    readonly supplierName: string;
    readonly expenseDate: string;
  },
): Promise<void> {
  await ok(
    await page.request.post('/api/v1/expenses', {
      headers: keyed(),
      data: { ...expense, category: 'repairs', paidBy: 'unpaid' },
    }),
    'record the expense',
  );
}

export interface MoveOutRow {
  readonly id: string;
  readonly leaseId: string;
  readonly status: string;
  readonly kind: string;
}

export interface MoveOutDetailRow extends MoveOutRow {
  readonly actions: { readonly editSettlement: boolean; readonly submit: boolean };
  readonly approval: { readonly id: string } | null;
  readonly approvedOn: string | null;
  readonly deductions: readonly {
    readonly amountMinor: number;
    readonly withdrawnAt: string | null;
  }[];
  readonly statement: {
    readonly depositHeldMinor: number;
    readonly creditMinor: number;
    readonly creditAppliedMinor: number;
    readonly depositAppliedMinor: number;
    readonly retainedMinor: number;
    readonly creditRefundMinor: number;
    readonly depositRefundMinor: number;
    readonly refundMinor: number;
    readonly arrearsMinor: number;
    readonly deductionsChargedMinor: number;
    readonly stillOwedMinor: number;
  } | null;
}

/**
 * A move-out of the seed whose settlement is still being drafted, so deductions can be added and
 * it can be sent for approval (M8 plan 4.14: one move-out in progress, with deductions).
 */
export async function draftedMoveOut(page: Page): Promise<MoveOutDetailRow> {
  const rows = await ok<MoveOutRow[]>(
    await page.request.get('/api/v1/move-outs'),
    'list move-outs',
  );
  for (const row of rows.filter((r) =>
    ['planned', 'inspected', 'settlement_drafted'].includes(r.status),
  )) {
    const detail = await ok<MoveOutDetailRow>(
      await page.request.get(`/api/v1/move-outs/${row.id}`),
      'read the move-out',
    );
    if (detail.actions.editSettlement && detail.actions.submit && detail.statement) return detail;
  }
  throw new Error('No move-out with a settlement being drafted: run pnpm db:seed');
}
