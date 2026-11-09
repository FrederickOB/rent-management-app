'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import { toProblem, type Problem } from '@/lib/errors';
import { formatTime, humanise } from '@/lib/format';
import { subscriptionMessage } from '@/lib/subscription';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';

const time = (iso: string) => formatTime(iso, 'UTC');

/** 403 `SUPPORT_NO_GRANT` in plain words: no consent, no view (decision 13). */
const supportProblem = (failure: unknown): Problem => {
  const problem = toProblem(failure);
  return { ...problem, message: subscriptionMessage(failure) ?? problem.message };
};

/**
 * What support sees of a company under its grant: counts, recent payments and recent audit
 * events, read-only. The API records this request in the company's audit chain.
 */
export function SupportOverview({ companyId }: { readonly companyId: string }) {
  const load = useCallback(() => api().platformAdmin.supportOverview({ companyId }), [companyId]);
  const { state, reload } = useLoad(load, supportProblem);

  const back = (
    <p className="text-sm">
      <Link href="/platform/support" className="underline underline-offset-2">
        Support access
      </Link>
    </p>
  );
  if (state.status === 'loading')
    return (
      <>
        {back}
        <Loading what="the company" />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        {back}
        <LoadFailed message={state.problem.message} onRetry={reload} />
      </>
    );
  const view = state.data;
  const counts = [
    ['Properties', view.counts.properties],
    ['Units', view.counts.units],
    ['Leases', view.counts.leases],
    ['Tenants', view.counts.tenants],
    ['Approvals waiting', view.counts.openApprovals],
  ] as const;

  return (
    <>
      {back}
      <PageHeader title={`${view.company.name}, read-only`} />
      <Alert tone="warning" title="Support access">
        Granted for “{view.grant.reason}” until {time(view.grant.until)}. You can read, not change,
        and this visit is recorded in the company’s audit log.
      </Alert>
      <Card data-testid="support-overview">
        <CardHeader title="At a glance" />
        <CardBody>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-5">
            {counts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-slate-600">{label}</dt>
                <dd className="text-lg font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Recent payments" />
        <CardBody>
          {view.recentPayments.length === 0 ? (
            <Empty>No payments yet.</Empty>
          ) : (
            <Table caption="Recent payments">
              <thead>
                <tr>
                  <Th>Received</Th>
                  <Th>How</Th>
                  <Th className="text-right">Amount</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {view.recentPayments.map((payment) => (
                  <tr key={payment.id}>
                    <Td>{formatBusinessDate(payment.receivedOn)}</Td>
                    <Td>{humanise(payment.method)}</Td>
                    <Td className="text-right tabular-nums">{formatMinor(payment.amountMinor)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Recent activity" />
        <CardBody>
          {view.recentAudit.length === 0 ? (
            <Empty>Nothing recorded yet.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {view.recentAudit.map((event, index) => (
                <li key={`${event.at}-${index}`} className="py-2">
                  <span className="font-medium text-slate-900">{event.action}</span>
                  <span className="text-slate-700">
                    {' '}
                    by {event.actorName ?? 'the system'}, {time(event.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </>
  );
}
