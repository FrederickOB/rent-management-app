'use client';

import type { BroadcastDetail } from '@rent/contracts';
import { CHANNEL_LABELS } from '@rent/domain/messaging';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/components/app-context';
import { MessageStatusBadge } from '@/components/inbox-badges';
import { LoadFailed, Loading } from '@/components/load-state';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { BROADCAST_STATUS_LABELS, STAT_COLUMNS, statRows } from '@/lib/broadcasts';
import { toProblem, type Problem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { statusReasonText } from '@/lib/inbox';
import { useVisibleInterval } from '@/lib/use-visible-interval';

/** A broadcast's delivery (CM-08): it refreshes while sending. */
export function BroadcastDetailView({
  broadcastId,
  justSent,
}: {
  readonly broadcastId: string;
  readonly justSent: boolean;
}) {
  const { timeZone } = useApp();
  const [broadcast, setBroadcast] = useState<BroadcastDetail | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  const load = useCallback(async () => {
    try {
      setBroadcast(await api().broadcasts.get({ broadcastId }));
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure));
    }
  }, [broadcastId]);

  useEffect(() => {
    void load();
  }, [load]);
  useVisibleInterval(() => void load(), broadcast?.status === 'sending' ? 5_000 : null);

  const breadcrumb = (
    <nav aria-label="Breadcrumb" className="text-sm">
      <Link href="/broadcasts" className="underline underline-offset-2">
        Broadcasts
      </Link>{' '}
      <span aria-hidden="true">›</span> <span>{broadcast?.topic ?? 'Broadcast'}</span>
    </nav>
  );

  if (!broadcast) {
    return (
      <>
        {breadcrumb}
        <PageHeader title="Broadcast" />
        {problem ? (
          problem.status === 404 ? (
            <Alert tone="info">This broadcast does not exist, or it is not one you can see.</Alert>
          ) : (
            <LoadFailed message={problem.message} onRetry={() => void load()} />
          )
        ) : (
          <Loading what="the broadcast" />
        )}
      </>
    );
  }

  return (
    <>
      {breadcrumb}
      <div className="space-y-2">
        <PageHeader title={broadcast.topic} description={`To ${broadcast.audienceLabel}`} />
        <p className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
          <span data-testid="broadcast-status">
            <Badge tone={broadcast.status === 'sending' ? 'blue' : 'green'}>
              {BROADCAST_STATUS_LABELS[broadcast.status]}
            </Badge>
          </span>
          Sent by {broadcast.createdBy.name},{' '}
          <time dateTime={broadcast.confirmedAt}>
            {formatTime(broadcast.confirmedAt, timeZone)}
          </time>
          {broadcast.completedAt ? (
            <>
              {' '}
              · finished{' '}
              <time dateTime={broadcast.completedAt}>
                {formatTime(broadcast.completedAt, timeZone)}
              </time>
            </>
          ) : null}
        </p>
      </div>
      {justSent ? (
        <Alert tone="success">
          Sent to {broadcast.queuedCount} of {broadcast.audienceCount} tenants. Messages go out in
          batches; this page updates as they are delivered.
        </Alert>
      ) : null}
      {problem ? <Alert tone="warning">{problem.message}</Alert> : null}

      <Card>
        <CardHeader title="Message" />
        <CardBody>
          <p className="break-words whitespace-pre-wrap text-sm text-slate-900">{broadcast.body}</p>
        </CardBody>
      </Card>

      <Card data-testid="broadcast-stats">
        <CardHeader
          title="Delivery"
          description="Each tenant is counted once, at their message’s latest status."
        />
        <CardBody>
          <Table caption="Delivery by channel">
            <thead>
              <tr>
                <Th>Channel</Th>
                {STAT_COLUMNS.map((column) => (
                  <Th key={column.key} className="text-right">
                    {column.label}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {statRows(broadcast.stats).map((row) => (
                <tr key={row.label} data-testid="stats-row">
                  <Td className={row.label === 'Total' ? 'font-semibold' : undefined}>
                    {row.label}
                  </Td>
                  {STAT_COLUMNS.map((column) => (
                    <Td
                      key={column.key}
                      className="text-right tabular-nums"
                      data-testid={`stat-${column.key}`}
                    >
                      {row[column.key]}
                    </Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Tenants"
          description={`${broadcast.recipients.length} in the audience.`}
        />
        <CardBody>
          <Table caption="Tenants and their delivery">
            <thead>
              <tr>
                <Th>Tenant</Th>
                <Th>Unit</Th>
                <Th>Channel</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {broadcast.recipients.map((recipient) => (
                <tr key={recipient.tenantId} data-testid="recipient-row">
                  <Td>
                    <Link
                      href={`/tenants/${recipient.tenantId}`}
                      className="underline underline-offset-2"
                    >
                      {recipient.name}
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs">{recipient.unitCode ?? '—'}</Td>
                  <Td>{recipient.channel ? CHANNEL_LABELS[recipient.channel] : '—'}</Td>
                  <Td>
                    <MessageStatusBadge status={recipient.status} />
                    {recipient.reason ? (
                      <p className="text-xs text-slate-600">{statusReasonText(recipient.reason)}</p>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>
    </>
  );
}
