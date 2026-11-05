import type { JobDefinition } from '@rent/server/jobs';
import { describe, expect, it } from 'vitest';
import { billingJobs } from './billing.jobs';
import { esignJobs } from './esign.jobs';
import { workerJobs } from './jobs';
import { maintenanceJobs } from './maintenance.jobs';
import { messagingJobs } from './messaging.jobs';
import { noticesJobs } from './notices.jobs';
import { paymentsJobs } from './payments.jobs';
import { registerJobs } from './register.jobs';
import { renderPdfJob } from './render-pdf.job';
import { taxJobs } from './tax.jobs';
import { tenancyJobs } from './tenancy.jobs';

/**
 * The queues the demo seed fills at start-up (counted on the e2e stack, 2026-11-05). Each drains:
 * the next job is fetched as soon as the last one ends, still one at a time (M8 §9).
 */
const SEED_FILLED = [
  'messaging.send',
  'documents.render-pdf',
  'documents.rendered',
  'lease.signed',
  'lease.activated',
  'messaging.not_sent',
  'payment.posted',
  'messaging.process-inbound',
  'esign.notice-event',
  'esign.finalise',
  'settlement_account.approved',
  'lease.ended',
  'moveout.final-statement',
  'messaging.broadcast-fanout',
  'inspection.render-report',
  'maintenance.emergency-alert',
];

/** Every worker job, built as main.ts builds them; nothing here runs, so no dependency is used. */
function allJobs(): JobDefinition<unknown>[] {
  const deps = {} as never;
  return [
    ...workerJobs(deps),
    renderPdfJob(deps),
    ...registerJobs(deps),
    ...tenancyJobs(deps),
    ...esignJobs({ ...(deps as object), onRendered: [] } as never),
    ...messagingJobs(deps),
    ...billingJobs(deps),
    ...paymentsJobs(deps),
    ...noticesJobs(deps),
    ...maintenanceJobs(deps),
    ...taxJobs(deps),
  ] as JobDefinition<unknown>[];
}

describe('PLATFORM and CM-08 the queues the seed fills drain their backlog (M8)', () => {
  it('drains every queue the demo seed fills at start-up, the PDF renders among them', () => {
    const byName = new Map(allJobs().map((j) => [j.name, j]));
    for (const name of SEED_FILLED) {
      expect(byName.has(name), name).toBe(true);
      expect(byName.get(name)!.drain, name).toBe(true);
    }
  });

  it('leaves the scheduled jobs on the polling interval', () => {
    const scheduled = allJobs().filter((j) => j.cron);
    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled.filter((j) => j.drain).map((j) => j.name)).toEqual([]);
  });
});
