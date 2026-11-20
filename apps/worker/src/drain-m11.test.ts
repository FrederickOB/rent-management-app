import type { JobDefinition } from '@rent/server/jobs';
import { describe, expect, it } from 'vitest';
import { messagingJobs } from './messaging.jobs';
import { noticesJobs } from './notices.jobs';
import { paymentsJobs } from './payments.jobs';

/**
 * The per-item queues a payment peak fills (M11 decision 7: 1,000 webhooks in 10 minutes). Each
 * fetches its next job as soon as the last one ends, so the queue clears in seconds, not one job a
 * second (the operations drill's finding).
 */
const PEAK_FILLED = [
  'payments.process-webhook',
  'payments.verify-pending.company',
  'messaging.fetch-media',
  'notices.delivery-status',
];

describe('NFR-PERF the queues a payment peak fills drain their backlog (M11 decision 7)', () => {
  it('drains the webhook, verify, media and delivery-status queues', () => {
    const deps = {} as never;
    const jobs = [
      ...paymentsJobs(deps),
      ...messagingJobs(deps),
      ...noticesJobs(deps),
    ] as JobDefinition<unknown>[];
    const byName = new Map(jobs.map((j) => [j.name, j]));
    for (const name of PEAK_FILLED) {
      expect(byName.has(name), name).toBe(true);
      expect(byName.get(name)!.drain, name).toBe(true);
    }
  });
});
