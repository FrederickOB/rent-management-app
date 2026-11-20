import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { HealthView } from './health-view';
import { JobsPanel, QueuesPanel, WebhooksPanel } from './ops-panels';

export const metadata: Metadata = { title: 'System health' };

/**
 * System health (AD-10; M10 decision 15; M11 decision 9): the worker and its queues, webhooks and
 * jobs to replay or retry, scheduled jobs, audit chains and alerts.
 */
export default async function PlatformHealthPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'System health',
    what: 'system health',
    needs: 'health.read',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="System health"
        description="Job queues and the jobs that failed for good, webhooks that could not be processed, the last run of each scheduled job, the audit chain checks and recent alerts."
      />
      {/* M11 decision 9: the worker's heartbeat, queue ages, and replay and retry. */}
      <QueuesPanel />
      <WebhooksPanel canReplay={allowed(me, 'platform.ops.replay')} />
      <JobsPanel canRetry={allowed(me, 'platform.ops.redrive')} />
      <HealthView />
    </>
  );
}
