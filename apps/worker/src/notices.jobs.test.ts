import { createLogger } from '@rent/server/core';
import type { JobContext, JobDefinition } from '@rent/server/jobs';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerDeps } from './jobs';
import { NOTICES_EVENT_TYPES, noticesJobs } from './notices.jobs';

const companyId = '019a3000-0000-7000-8000-000000000002';
const noticeId = '019a3000-0000-7000-8000-00000000aaaa';
const requestId = '019a3000-0000-7000-8000-00000000bbbb';
const recipientId = '019a3000-0000-7000-8000-00000000cccc';
const messageId = '019a3000-0000-7000-8000-00000000dddd';
const eventId = '019a3000-0000-7000-8000-00000000eeee';

function harness() {
  const tracking = {
    onSigningEvent: vi.fn().mockResolvedValue(undefined),
    onDeliveryStatus: vi.fn().mockResolvedValue(undefined),
    onMessageNotSent: vi.fn().mockResolvedValue(undefined),
    escalate: vi.fn().mockResolvedValue(undefined),
    runLadder: vi.fn().mockResolvedValue({ fired: 0, skipped: 0 }),
  };
  const jobs = noticesJobs({
    tracking,
    clock: { now: () => new Date('2026-11-09T10:07:00Z') },
  } as unknown as Parameters<typeof noticesJobs>[0] & WorkerDeps);
  const byName = new Map(jobs.map((j) => [j.name, j as JobDefinition<unknown>]));
  const ctx: JobContext = {
    jobId: 'job-1',
    logger: createLogger({ level: 'silent' }),
    companyId,
    withCompany: () => Promise.reject(new Error('not used')),
    once: () => Promise.resolve(true),
    enqueue: vi.fn().mockResolvedValue(undefined),
  };
  return { byName, tracking, ctx };
}

describe('LN-03 and LN-05 notice worker jobs (plan 4.12)', () => {
  it('consumes the engine, delivery, escalation and not-sent events, and runs the ladder every 15 minutes', () => {
    const { byName } = harness();
    expect([...NOTICES_EVENT_TYPES]).toEqual([
      'esign.notice-event',
      'notices.delivery-status',
      'notices.escalate',
      'messaging.not_sent',
    ]);
    for (const name of NOTICES_EVENT_TYPES) expect(byName.has(name), name).toBe(true);
    expect(byName.get('notices.ladder')!.cron).toBe('*/15 * * * *');
    // The plan's retries: escalation and delivery reports 5, the ladder 3.
    expect(byName.get('notices.escalate')!.retry.limit).toBe(5);
    expect(byName.get('notices.delivery-status')!.retry.limit).toBe(5);
    expect(byName.get('notices.ladder.company')!.retry.limit).toBe(3);
    for (const job of byName.values())
      if (job.name !== 'notices.ladder') expect(job.scope, job.name).toBe('company');
  });

  it('hands each event to the tracker with the company it belongs to', async () => {
    const { byName, tracking, ctx } = harness();
    const signing = byName.get('esign.notice-event')!;
    await signing.handle(
      signing.schema.parse({
        companyId,
        kind: 'opened',
        noticeId,
        signingRequestId: requestId,
        at: '2026-11-09T10:00:00.000Z',
      }),
      ctx,
    );
    expect(tracking.onSigningEvent).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ kind: 'opened', noticeId, signingRequestId: requestId }),
    );
    const delivery = byName.get('notices.delivery-status')!;
    await delivery.handle(
      delivery.schema.parse({
        companyId,
        recipientId,
        messageId,
        eventId,
        status: 'delivered',
        channel: 'sms',
        at: '2026-11-09T10:01:00.000Z',
      }),
      ctx,
    );
    expect(tracking.onDeliveryStatus).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ recipientId, status: 'delivered', channel: 'sms' }),
    );
    const notSent = byName.get('messaging.not_sent')!;
    await notSent.handle(
      notSent.schema.parse({
        companyId,
        messageId,
        reason: 'no_consent',
        related: { type: 'notice_recipient', id: recipientId },
      }),
      ctx,
    );
    expect(tracking.onMessageNotSent).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ messageId, reason: 'no_consent' }),
    );
    const escalate = byName.get('notices.escalate')!;
    await escalate.handle(escalate.schema.parse({ companyId, noticeId }), ctx);
    expect(tracking.escalate).toHaveBeenCalledWith(companyId, noticeId);
    const ladder = byName.get('notices.ladder.company')!;
    await ladder.handle(ladder.schema.parse({ companyId, slot: '2026-11-09T10:00:00.000Z' }), ctx);
    expect(tracking.runLadder).toHaveBeenCalledWith(companyId);
  });

  it('refuses an event without its ids rather than guessing', () => {
    const { byName } = harness();
    expect(() =>
      byName.get('notices.delivery-status')!.schema.parse({ companyId, status: 'delivered' }),
    ).toThrow();
    expect(() => byName.get('notices.escalate')!.schema.parse({ companyId })).toThrow();
  });
});
