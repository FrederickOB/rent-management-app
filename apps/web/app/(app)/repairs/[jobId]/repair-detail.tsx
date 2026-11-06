'use client';

import type { MaintenanceJobDetail } from '@rent/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/components/app-context';
import { LoadFailed, Loading } from '@/components/load-state';
import { MaintenanceLaterNote } from '@/components/maintenance-later-note';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { openFetchedLink } from '@/lib/browser-files';
import { toProblem, type Problem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { REPAIR_MEDIA_LABELS, REPAIR_SOURCE_LABELS, REPAIR_STATUS_LABELS } from '@/lib/repairs';

export function RepairDetail({
  jobId,
  canOpenConversation,
}: {
  readonly jobId: string;
  readonly canOpenConversation: boolean;
}) {
  const { timeZone } = useApp();
  const [job, setJob] = useState<MaintenanceJobDetail | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [mediaProblem, setMediaProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setJob(await api().maintenance.get({ jobId }));
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure));
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(attachmentId: string) {
    setMediaProblem(null);
    try {
      await openFetchedLink(
        async () => (await api().maintenance.attachmentDownload({ jobId, attachmentId })).url,
      );
    } catch (failure) {
      setMediaProblem(toProblem(failure).message);
    }
  }

  const breadcrumb = (
    <nav aria-label="Breadcrumb" className="text-sm">
      <Link href="/repairs" className="underline underline-offset-2">
        Reported repairs
      </Link>{' '}
      <span aria-hidden="true">›</span> <span>{job?.ticket ?? 'Repair'}</span>
    </nav>
  );

  if (!job) {
    return (
      <>
        {breadcrumb}
        <PageHeader title="Reported repair" />
        {problem ? (
          problem.status === 404 ? (
            <Alert tone="info">This repair does not exist, or it is not one you can see.</Alert>
          ) : (
            <LoadFailed message={problem.message} onRetry={() => void load()} />
          )
        ) : (
          <Loading what="the repair" />
        )}
      </>
    );
  }

  return (
    <>
      {breadcrumb}
      <div className="space-y-2">
        <PageHeader title={`Repair ${job.ticket}`} />
        <p className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
          <span data-testid="repair-status">
            <Badge tone="amber">{REPAIR_STATUS_LABELS[job.status]}</Badge>
          </span>
          {REPAIR_SOURCE_LABELS[job.source]},{' '}
          <time dateTime={job.createdAt}>{formatTime(job.createdAt, timeZone)}</time>
        </p>
      </div>
      <MaintenanceLaterNote />
      <Card>
        <CardHeader title="What was reported" />
        <CardBody>
          <p
            className="break-words whitespace-pre-wrap text-sm text-slate-900"
            data-testid="repair-description"
          >
            {job.description}
          </p>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-600">Tenant</dt>
              <dd>
                {job.tenant ? (
                  <Link href={`/tenants/${job.tenant.id}`} className="underline underline-offset-2">
                    {job.tenant.name}
                  </Link>
                ) : (
                  'Not known'
                )}
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">Unit</dt>
              <dd>
                {job.unit ? (
                  <Link
                    href={`/portfolio/units/${job.unit.id}`}
                    className="font-mono underline underline-offset-2"
                  >
                    {job.unit.code}
                  </Link>
                ) : (
                  'Not known'
                )}{' '}
                <span className="text-slate-600">({job.property.name})</span>
              </dd>
            </div>
          </dl>
          {job.conversationId && canOpenConversation ? (
            <Link
              href={`/inbox/${job.conversationId}`}
              className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-2"
            >
              Open the conversation it came from
            </Link>
          ) : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Photos, videos and voice notes"
          description={
            job.attachments.length < job.attachmentCount
              ? `${job.attachmentCount - job.attachments.length} more still being copied.`
              : undefined
          }
        />
        <CardBody>
          {job.attachments.length === 0 ? (
            <p className="text-sm text-slate-600">None were sent.</p>
          ) : (
            <ul className="flex flex-wrap gap-2" aria-label="Media">
              {job.attachments.map((attachment, index) => (
                <li key={attachment.id} data-testid="repair-attachment">
                  <Button size="sm" variant="secondary" onClick={() => void open(attachment.id)}>
                    Open {REPAIR_MEDIA_LABELS[attachment.kind].toLowerCase()} {index + 1}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {mediaProblem ? <Alert tone="error">{mediaProblem}</Alert> : null}
        </CardBody>
      </Card>
    </>
  );
}
