import { createLogger } from '@rent/server/core';
import type { JobContext, JobDefinition } from '@rent/server/jobs';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerDeps } from './jobs';
import { LEASE_TRANSITIONS_JOB, TENANCY_EVENT_TYPES, tenancyJobs } from './tenancy.jobs';

const companyId = '019a3000-0000-7000-8000-000000000002';
const messageId = '019a3000-0000-7000-8000-00000000aaaa';
const checkId = '019a3000-0000-7000-8000-00000000bbbb';

function harness() {
  const deliver = vi.fn().mockResolvedValue('sent');
  const run = vi
    .fn()
    .mockImplementation(async (_c, _k, _a, schedule: (n: number, at: Date) => Promise<void>) =>
      schedule(2, new Date('2026-11-02T10:00:00Z')),
    );
  const runTransitions = vi.fn().mockResolvedValue(0);
  const jobs = tenancyJobs({
    messaging: { deliver },
    idChecks: { run },
    lifecycle: { runTransitions },
    reminders: {
      renewals: vi.fn().mockResolvedValue(0),
      rentControl: vi.fn().mockResolvedValue(0),
      stamping: vi.fn().mockResolvedValue(0),
      formalLeases: vi.fn().mockResolvedValue(0),
    },
  } as unknown as Parameters<typeof tenancyJobs>[0] & WorkerDeps);
  const byName = new Map(jobs.map((j) => [j.name, j as JobDefinition<unknown>]));
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const ctx: JobContext = {
    jobId: 'job-1',
    logger: createLogger({ level: 'silent' }),
    companyId,
    withCompany: () => Promise.reject(new Error('not used')),
    once: () => Promise.resolve(true),
    enqueue,
  };
  return { byName, deliver, run, runTransitions, enqueue, ctx };
}

describe('PLATFORM M3 worker jobs (plan 4.17)', () => {
  it('consumes the messaging and identity events, and schedules the daily lease jobs', () => {
    const { byName } = harness();
    expect([...TENANCY_EVENT_TYPES]).toEqual(['messaging.send', 'identity.verify-id']);
    for (const name of [
      'messaging.send',
      'identity.verify-id',
      `${LEASE_TRANSITIONS_JOB}`,
      `${LEASE_TRANSITIONS_JOB}.company`,
      'tenancy.renewal-reminders',
      'tenancy.rent-control-reminders',
      'tenancy.stamping-reminders',
      'tenancy.formal-lease-reminders',
    ])
      expect(byName.has(name), name).toBe(true);
    expect(byName.get(LEASE_TRANSITIONS_JOB)!.cron).toBe('5 0 * * *');
    expect(byName.get('tenancy.formal-lease-reminders')!.cron).toBe('0 8 * * 1');
  });

  it('strips the outbox envelope before checking a message request', async () => {
    const { byName, deliver, ctx } = harness();
    const job = byName.get('messaging.send')!;
    const payload = job.schema.parse({
      companyId,
      eventId: '019a3000-0000-7000-8000-00000000cccc',
      __job: 'messaging.send',
      messageId,
      recipient: { type: 'staff', personId: '019a3000-0000-7000-8000-00000000dddd' },
      purpose: 'staff_notice',
      subject: 'A reminder',
      body: 'A lease needs attention.',
      link: null,
      channels: ['email'],
      propertyId: null,
      related: null,
      requestedBy: null,
    });
    await job.handle(payload, ctx);
    expect(deliver).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ messageId, purpose: 'staff_notice' }),
    );
    expect(deliver.mock.calls[0]![1]).not.toHaveProperty('eventId');
  });

  it('schedules the next identity poll as a delayed, single job', async () => {
    const { byName, run, enqueue, ctx } = harness();
    const job = byName.get('identity.verify-id')!;
    await job.handle(job.schema.parse({ companyId, checkId, attempt: 1 }), ctx);
    expect(run).toHaveBeenCalledWith(companyId, checkId, 1, expect.any(Function));
    expect(enqueue).toHaveBeenCalledWith(
      'identity.verify-id',
      { companyId, checkId, attempt: 2 },
      {
        singletonKey: `identity.verify-id:${checkId}:2`,
        startAfter: new Date('2026-11-02T10:00:00Z'),
      },
    );
  });
});

describe('PLATFORM and CM-08 the send queue drains its backlog (M8)', () => {
  it('drains messaging.send without the polling pause after each job, and no other M3 queue', () => {
    const { byName } = harness();
    expect(byName.get('messaging.send')!.drain).toBe(true);
    expect([...byName.values()].filter((j) => j.drain).map((j) => j.name)).toEqual([
      'messaging.send',
    ]);
  });
});
