import { createLogger } from '@rent/server/core';
import type { JobContext, JobDefinition } from '@rent/server/jobs';
import { describe, expect, it, vi } from 'vitest';
import { ESIGN_EVENT_TYPES, esignJobs } from './esign.jobs';
import type { WorkerDeps } from './jobs';

const companyId = '019a3000-0000-7000-8000-000000000002';
const requestId = '019a3000-0000-7000-8000-00000000aaaa';
const leaseId = '019a3000-0000-7000-8000-00000000bbbb';
const documentId = '019a3000-0000-7000-8000-00000000cccc';
const renderRequestId = '019a3000-0000-7000-8000-00000000dddd';

function harness() {
  const esign = {
    onDocumentRendered: vi.fn().mockResolvedValue(true),
    finalise: vi.fn().mockResolvedValue('completed'),
    remindUnsigned: vi.fn().mockResolvedValue(0),
    expireLinksAndCodes: vi.fn().mockResolvedValue({ expired: 0, closed: 0, unlocked: 0 }),
  };
  const lifecycle = {
    onSigningCompleted: vi.fn().mockResolvedValue(undefined),
    onSigningDeclined: vi.fn().mockResolvedValue(undefined),
  };
  const render = vi.fn();
  const jobs = esignJobs({
    esign,
    lifecycle,
    render,
    clock: { now: () => new Date('2026-11-02T10:07:00Z') },
  } as unknown as Parameters<typeof esignJobs>[0] & WorkerDeps);
  const byName = new Map(jobs.map((j) => [j.name, j as JobDefinition<unknown>]));
  const ctx: JobContext = {
    jobId: 'job-1',
    logger: createLogger({ level: 'silent' }),
    companyId,
    withCompany: () => Promise.reject(new Error('not used')),
    once: () => Promise.resolve(true),
    enqueue: vi.fn().mockResolvedValue(undefined),
  };
  return { byName, esign, lifecycle, render, ctx };
}

const envelope = { companyId, eventId: '019a3000-0000-7000-8000-00000000eeee', __job: 'x' };

describe('TL-07 e-signing worker jobs (plan 4.17)', () => {
  it('consumes the rendered, finalise, completed and declined events, and schedules the rest', () => {
    const { byName } = harness();
    expect([...ESIGN_EVENT_TYPES]).toEqual([
      'documents.rendered',
      'esign.finalise',
      'signing.completed',
      'signing.declined',
    ]);
    for (const name of ESIGN_EVENT_TYPES) expect(byName.has(name), name).toBe(true);
    expect(byName.get('esign.signing-reminders')!.cron).toBe('*/15 * * * *');
    expect(byName.get('housekeeping.expire-links-and-codes')!.cron).toBe('0 * * * *');
    expect(byName.get('esign.finalise')!.retry.limit).toBe(5);
    expect(byName.has('esign.signing-reminders.company')).toBe(true);
    expect(byName.has('housekeeping.expire-links-and-codes.company')).toBe(true);
  });

  it('opens a request when its PDF is rendered, and finalises with the worker’s renderer', async () => {
    const { byName, esign, render, ctx } = harness();
    const rendered = byName.get('documents.rendered')!;
    await rendered.handle(rendered.schema.parse({ ...envelope, renderRequestId }), ctx);
    expect(esign.onDocumentRendered).toHaveBeenCalledWith(companyId, renderRequestId);
    const finalise = byName.get('esign.finalise')!;
    await finalise.handle(finalise.schema.parse({ ...envelope, signingRequestId: requestId }), ctx);
    expect(esign.finalise).toHaveBeenCalledWith(companyId, requestId, render);
  });

  it('routes completion and declines to the lease lifecycle with the request they are about', async () => {
    const { byName, lifecycle, ctx } = harness();
    const completed = byName.get('signing.completed')!;
    await completed.handle(
      completed.schema.parse({
        ...envelope,
        signingRequestId: requestId,
        leaseId,
        completedAt: '2026-11-02T10:00:00.000Z',
        finalDocumentId: documentId,
      }),
      ctx,
    );
    expect(lifecycle.onSigningCompleted).toHaveBeenCalledWith(companyId, {
      leaseId,
      signingRequestId: requestId,
      completedAt: new Date('2026-11-02T10:00:00.000Z'),
      finalDocumentId: documentId,
    });
    const declined = byName.get('signing.declined')!;
    await declined.handle(
      declined.schema.parse({ ...envelope, signingRequestId: requestId, leaseId }),
      ctx,
    );
    expect(lifecycle.onSigningDeclined).toHaveBeenCalledWith(companyId, {
      leaseId,
      signingRequestId: requestId,
    });
  });

  it('runs the reminder and housekeeping jobs per company', async () => {
    const { byName, esign, ctx } = harness();
    const reminders = byName.get('esign.signing-reminders.company')!;
    await reminders.handle(
      reminders.schema.parse({ companyId, slot: '2026-11-02T10:00:00.000Z' }),
      ctx,
    );
    expect(esign.remindUnsigned).toHaveBeenCalledWith(companyId);
    const sweep = byName.get('housekeeping.expire-links-and-codes.company')!;
    await sweep.handle(sweep.schema.parse({ companyId, slot: '2026-11-02T10:00:00.000Z' }), ctx);
    expect(esign.expireLinksAndCodes).toHaveBeenCalledWith(companyId);
  });
});
