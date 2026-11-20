'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { alertContextRows, alertDataOf } from '@/lib/ops';
import { ALERT_SEVERITY_LABELS } from '@/lib/subscription';
import { useLoad } from '@/lib/use-load';

const time = (iso: string) => formatTime(iso, 'UTC');

const SEVERITY_TONES = { info: 'blue', warning: 'amber', critical: 'red' } as const;

export function HealthView() {
  const load = useCallback(() => api().platformAdmin.health(), []);
  const { state, reload } = useLoad(load);

  if (state.status === 'loading') return <Loading what="system health" />;
  if (state.status === 'error')
    return <LoadFailed message={state.problem.message} onRetry={reload} />;
  const health = state.data;

  return (
    <>
      <p className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
        <span>Checked {time(health.checkedAt)}.</span>
        <Link href="/platform/retention" className="font-medium underline underline-offset-2">
          Retention review
        </Link>
        <Button size="sm" variant="secondary" onClick={reload}>
          Check again
        </Button>
      </p>
      <Card data-testid="health-summary">
        <CardBody>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-slate-600">Jobs failed for good, last 24 hours</dt>
              <dd
                className={
                  health.deadLettered24h > 0
                    ? 'text-lg font-semibold text-red-800'
                    : 'text-lg font-semibold'
                }
              >
                {health.deadLettered24h}
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">Webhooks not processed</dt>
              <dd
                className={
                  health.failedWebhooks > 0
                    ? 'text-lg font-semibold text-red-800'
                    : 'text-lg font-semibold'
                }
              >
                {health.failedWebhooks}
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">Audit chains broken</dt>
              <dd
                className={
                  health.auditChains.broken > 0
                    ? 'text-lg font-semibold text-red-800'
                    : 'text-lg font-semibold'
                }
              >
                {health.auditChains.broken}
              </dd>
              <dd className="text-xs text-slate-600">
                {health.auditChains.checkedAt
                  ? `Checked ${time(health.auditChains.checkedAt)}`
                  : 'Not checked yet'}
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Queues" />
        <CardBody>
          {health.queues.length === 0 ? (
            <Empty>No queues reported.</Empty>
          ) : (
            <Table caption="Job queues">
              <thead>
                <tr>
                  <Th>Queue</Th>
                  <Th className="text-right">Waiting</Th>
                  <Th className="text-right">Running</Th>
                  <Th className="text-right">Failed, last 24 hours</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {health.queues.map((queue) => (
                  <tr key={queue.name}>
                    <Td className="font-mono text-xs">{queue.name}</Td>
                    <Td className="text-right tabular-nums">{queue.queued}</Td>
                    <Td className="text-right tabular-nums">{queue.active}</Td>
                    <Td
                      className={
                        queue.failed24h > 0
                          ? 'text-right font-medium text-red-800 tabular-nums'
                          : 'text-right tabular-nums'
                      }
                    >
                      {queue.failed24h}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Scheduled jobs" />
        <CardBody>
          {health.scheduledJobs.length === 0 ? (
            <Empty>No scheduled jobs reported.</Empty>
          ) : (
            <Table caption="Scheduled jobs and their last run">
              <thead>
                <tr>
                  <Th>Job</Th>
                  <Th>Last run</Th>
                  <Th>How it ended</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {health.scheduledJobs.map((job) => (
                  <tr key={job.name}>
                    <Td className="font-mono text-xs">{job.name}</Td>
                    <Td>{job.lastRunAt ? time(job.lastRunAt) : 'Never'}</Td>
                    <Td>{job.lastState ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Recent alerts" />
        <CardBody>
          {health.recentAlerts.length === 0 ? (
            <Empty>No recent alerts.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm" data-testid="health-alerts">
              {health.recentAlerts.map((alert, index) => (
                <li key={`${alert.at}-${index}`} className="space-y-1 py-2">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={SEVERITY_TONES[alert.severity]}>
                      {ALERT_SEVERITY_LABELS[alert.severity]}
                    </Badge>
                    <span className="font-mono text-xs">{alert.code}</span>
                    <span className="text-xs text-slate-600">{time(alert.at)}</span>
                  </p>
                  <p className="text-slate-800">{alert.message}</p>
                  {/* M11 runbook review: the stored, scrubbed context, as text only. */}
                  {alertContextRows(alertDataOf(alert)).length > 0 ? (
                    <details data-testid="health-alert-context">
                      <summary className="cursor-pointer text-xs font-medium text-slate-700">
                        Details
                      </summary>
                      <dl className="mt-1 space-y-1 text-xs">
                        {alertContextRows(alertDataOf(alert)).map((row) => (
                          <div key={row.key} className="grid gap-1 sm:grid-cols-[12rem_1fr]">
                            <dt className="font-mono text-slate-600">{row.key}</dt>
                            <dd className="font-mono break-all text-slate-900">{row.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </>
  );
}
