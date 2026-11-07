'use client';

import type { MaintenanceJobDetail } from '@rent/contracts';
import { TASK_KIND_LABELS } from '@rent/domain/tasks';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useApp } from '@/components/app-context';
import { LoadFailed, Loading } from '@/components/load-state';
import {
  CategoryBadge,
  JobStatusBadge,
  OverdueBadge,
  PriorityBadge,
} from '@/components/maintenance-badges';
import { MediaView } from '@/components/media';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { openFetchedLink } from '@/lib/browser-files';
import { formatBusinessDate } from '@/lib/business-dates';
import { EXPENSE_STATUS_LABELS, NO_RECEIPT, needsReceiptFlag } from '@/lib/expenses';
import { toProblem, type Problem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  anyAction,
  assigneeLabel,
  attachmentsByStage,
  costText,
  emergencyAlertText,
  EVENT_LABELS,
  eventActor,
  eventDetail,
  isEmergency,
  playerOf,
  targetText,
} from '@/lib/maintenance';
import { REPAIR_MEDIA_LABELS, REPAIR_SOURCE_LABELS } from '@/lib/repairs';
import { TASK_STATUS_LABELS } from '@/lib/tasks';
import { formatMinor } from '@/lib/tenancy-format';
import { JobActions } from './job-actions';

export interface JobPermissions {
  readonly openConversation: boolean;
  readonly seeTenant: boolean;
  readonly seeUnit: boolean;
  readonly listStaff: boolean;
  readonly listArtisans: boolean;
  readonly seeExpenses: boolean;
}

export function RepairDetail({
  jobId,
  can,
}: {
  readonly jobId: string;
  readonly can: JobPermissions;
}) {
  const { timeZone } = useApp();
  const [job, setJob] = useState<MaintenanceJobDetail | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);

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

  const breadcrumb = (
    <nav aria-label="Breadcrumb" className="text-sm">
      <Link href="/repairs" className="underline underline-offset-2">
        Maintenance board
      </Link>{' '}
      <span aria-hidden="true">›</span> <span>{job?.ticket ?? 'Repair'}</span>
    </nav>
  );

  if (!job) {
    return (
      <>
        {breadcrumb}
        <PageHeader title="Repair" />
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

  const changed = (next: MaintenanceJobDetail, text: string) => {
    setJob(next);
    setNotice(text);
    setStale(null);
  };

  return (
    <>
      {breadcrumb}
      <div className="space-y-2">
        <PageHeader title={`Repair ${job.ticket}`} />
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
          <PriorityBadge job={job} />
          <span data-testid="repair-status">
            <JobStatusBadge status={job.status} />
          </span>
          <CategoryBadge job={job} />
          <OverdueBadge job={job} />
          <span>
            {REPAIR_SOURCE_LABELS[job.source]},{' '}
            <time dateTime={job.createdAt}>{formatTime(job.createdAt, timeZone)}</time>
          </span>
        </div>
      </div>
      {isEmergency(job) && job.status !== 'closed' && job.status !== 'cancelled' ? (
        <Alert tone="error" title="Emergency">
          <span data-testid="emergency-alerts">{emergencyAlertText(job.events)}</span>
          {job.priority === null
            ? ' The tenant flagged it; triage it to confirm or lower the priority.'
            : ''}
        </Alert>
      ) : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {stale ? <Alert tone="warning">{stale}</Alert> : null}

      <Card data-testid="repair-facts">
        <CardHeader title="What was reported" />
        <CardBody>
          <p
            className="break-words whitespace-pre-wrap text-sm text-slate-900"
            data-testid="repair-description"
          >
            {job.description}
          </p>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Fact label="Where">
              {job.unit ? (
                can.seeUnit ? (
                  <Link
                    href={`/portfolio/units/${job.unit.id}`}
                    className="font-mono underline underline-offset-2"
                  >
                    {job.unit.code}
                  </Link>
                ) : (
                  <span className="font-mono">{job.unit.code}</span>
                )
              ) : (
                'A common area'
              )}{' '}
              <span className="text-slate-600">({job.property.name})</span>
            </Fact>
            <Fact label="Tenant">
              {job.tenant ? (
                can.seeTenant ? (
                  <Link href={`/tenants/${job.tenant.id}`} className="underline underline-offset-2">
                    {job.tenant.name}
                  </Link>
                ) : (
                  job.tenant.name
                )
              ) : (
                'None'
              )}
            </Fact>
            <Fact label="Assigned to">{assigneeLabel(job.assignee)}</Fact>
            <Fact label="Visit">
              {job.visitAt ? formatTime(job.visitAt, timeZone) : 'None planned'}
            </Fact>
            {job.targets ? (
              <>
                <Fact label="Response target">{targetText(job.targets, 'respond', timeZone)}</Fact>
                <Fact label="Completion target">
                  {targetText(job.targets, 'complete', timeZone)}
                </Fact>
              </>
            ) : (
              <Fact label="Targets">Set when the job is triaged</Fact>
            )}
            <Fact label="Cost">
              <span data-testid="job-cost" className="tabular-nums">
                {costText(job)}
              </span>
              <span className="text-slate-600"> (the sum of its expenses)</span>
            </Fact>
            {job.closedAt ? <Fact label="Closed">{formatTime(job.closedAt, timeZone)}</Fact> : null}
            {job.beforePhotoReason ? (
              <Fact label="No before photo, because">{job.beforePhotoReason}</Fact>
            ) : null}
            {job.completionNote ? (
              <Fact label="Completion note">
                <span className="whitespace-pre-wrap" data-testid="completion-note">
                  {job.completionNote}
                </span>
              </Fact>
            ) : null}
            {job.tenantResponse ? (
              <Fact label="The tenant’s answer">
                {job.tenantResponse.kind === 'confirmed' ? 'Confirmed it is done' : 'Disputed it'}
                {job.tenantResponse.reason ? `: ${job.tenantResponse.reason}` : ''} (
                {formatTime(job.tenantResponse.at, timeZone)})
              </Fact>
            ) : null}
          </dl>
          {job.conversationId && can.openConversation ? (
            <Link
              href={`/inbox/${job.conversationId}`}
              className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-2"
            >
              Open the conversation it came from
            </Link>
          ) : null}
        </CardBody>
      </Card>

      {anyAction(job.actions) ? (
        <JobActions
          job={job}
          can={{ listStaff: can.listStaff, listArtisans: can.listArtisans }}
          onChanged={changed}
          onStale={async (text) => {
            await load();
            setNotice(null);
            setStale(text);
          }}
        />
      ) : (
        <p className="text-sm text-slate-600" data-testid="job-read-only">
          {job.status === 'closed' || job.status === 'cancelled'
            ? 'This job is finished.'
            : 'You can follow this job; you cannot change it.'}
        </p>
      )}

      <JobFiles job={job} />
      <JobTimeline job={job} />
      {can.seeExpenses || job.expenses.length > 0 ? <JobExpenses job={job} /> : null}
      {job.tasks.length > 0 ? <JobTasks job={job} /> : null}
    </>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-slate-600">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

function JobFiles({ job }: { readonly job: MaintenanceJobDetail }) {
  const groups = attachmentsByStage(job.attachments);
  let index = 0;
  return (
    <Card data-testid="repair-files">
      <CardHeader
        title="Photos, videos and voice notes"
        description={
          job.attachments.length < job.attachmentCount
            ? `${job.attachmentCount - job.attachments.length} more still being copied.`
            : 'Each opens by a link that lasts a few minutes.'
        }
      />
      <CardBody>
        {groups.length === 0 ? <p className="text-sm text-slate-600">None yet.</p> : null}
        {groups.map((group) => (
          <section key={group.stage} className="space-y-2" aria-label={group.label}>
            <h3 className="text-sm font-semibold text-slate-900">{group.label}</h3>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map((attachment) => {
                index += 1;
                const name = `${REPAIR_MEDIA_LABELS[attachment.kind]} ${index}, ${group.label.toLowerCase()}`;
                return (
                  <li
                    key={attachment.id}
                    data-testid="repair-attachment"
                    data-stage={attachment.stage}
                  >
                    <MediaView
                      kind={playerOf(attachment)}
                      name={name}
                      durationSeconds={attachment.durationSeconds}
                      when={{ label: 'Added', at: attachment.createdAt }}
                      load={async () =>
                        (
                          await api().maintenance.attachmentDownload({
                            jobId: job.id,
                            attachmentId: attachment.id,
                          })
                        ).url
                      }
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </CardBody>
    </Card>
  );
}

function JobTimeline({ job }: { readonly job: MaintenanceJobDetail }) {
  const { timeZone } = useApp();
  return (
    <Card data-testid="repair-timeline">
      <CardHeader
        title="Timeline"
        description="Every step, oldest first, with the server’s time."
      />
      <CardBody>
        {job.events.length === 0 ? (
          <p className="text-sm text-slate-600">Nothing recorded yet.</p>
        ) : (
          <ol className="space-y-3 border-l-2 border-slate-200 pl-4 text-sm">
            {job.events.map((event) => {
              const detail = eventDetail(event, timeZone);
              return (
                <li key={event.id} data-testid="timeline-event" data-kind={event.kind}>
                  <p className="font-medium text-slate-900">{EVENT_LABELS[event.kind]}</p>
                  <p className="text-slate-600">
                    <time dateTime={event.at}>{formatTime(event.at, timeZone)}</time> ·{' '}
                    {eventActor(event)}
                  </p>
                  {detail ? (
                    <p className="break-words whitespace-pre-wrap text-slate-800">{detail}</p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

function JobExpenses({ job }: { readonly job: MaintenanceJobDetail }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Card data-testid="repair-expenses">
      <CardHeader
        title="Expenses"
        description={`The job’s cost is ${costText(job)}: the sum of its expenses, less any reversed.`}
        actions={
          job.actions.recordExpense ? (
            <Link
              href={`/expenses/new?jobId=${job.id}&propertyId=${job.property.id}${job.unit ? `&unitId=${job.unit.id}` : ''}`}
              className="inline-flex min-h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-100"
            >
              Record an expense
            </Link>
          ) : null
        }
      />
      <CardBody>
        {job.expenses.length === 0 ? (
          <p className="text-sm text-slate-600">No expense is linked to this job yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {job.expenses.map((expense) => (
              <li
                key={expense.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
                data-testid="job-expense"
              >
                <span
                  className={expense.status === 'reversed' ? 'text-slate-500 line-through' : ''}
                >
                  {expense.supplierName} · {expense.categoryLabel} ·{' '}
                  {formatBusinessDate(expense.expenseDate)}
                </span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums">{formatMinor(expense.amountMinor)}</span>
                  <Badge
                    tone={
                      expense.status === 'paid'
                        ? 'green'
                        : expense.status === 'unpaid'
                          ? 'amber'
                          : 'dark'
                    }
                  >
                    {EXPENSE_STATUS_LABELS[expense.status]}
                  </Badge>
                  {needsReceiptFlag(expense) ? (
                    <span data-testid="no-receipt">
                      <Badge tone="red">{NO_RECEIPT}</Badge>
                    </span>
                  ) : null}
                  {expense.hasReceipt ? (
                    <button
                      type="button"
                      className="min-h-9 text-sm font-medium underline underline-offset-2"
                      onClick={() =>
                        void openFetchedLink(
                          async () =>
                            (await api().expenses.receiptDownload({ expenseId: expense.id })).url,
                        ).catch((failure: unknown) => setProblem(toProblem(failure).message))
                      }
                    >
                      Receipt
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
      </CardBody>
    </Card>
  );
}

function JobTasks({ job }: { readonly job: MaintenanceJobDetail }) {
  const { timeZone } = useApp();
  return (
    <Card>
      <CardHeader title="Tasks" description="In-house work on this job, on the Tasks page." />
      <CardBody>
        <ul className="divide-y divide-slate-100 text-sm">
          {job.tasks.map((task) => (
            <li key={task.id} className="py-2">
              {TASK_KIND_LABELS[task.kind]} · {TASK_STATUS_LABELS[task.status]} ·{' '}
              {task.assignee?.name ?? 'Nobody assigned'} · due {formatTime(task.dueAt, timeZone)}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
