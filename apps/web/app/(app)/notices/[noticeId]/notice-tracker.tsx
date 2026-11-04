'use client';

import type { NoticeDetail } from '@rent/contracts';
import { NOTICE_FIELD_LABELS } from '@rent/domain/notices';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useApp } from '@/components/app-context';
import { LoadFailed, Loading } from '@/components/load-state';
import { NoticeOutcomeBadge, NoticeStatusBadge } from '@/components/notice-badges';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { openFetchedLink } from '@/lib/browser-files';
import { formatBusinessDate } from '@/lib/business-dates';
import { toProblem, type Problem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  approvedButReturned,
  draftOfFields,
  earliestText,
  fieldKind,
  isLiveStatus,
  noticeRefusal,
  noticeTitle,
  orderedWarnings,
  quitBarText,
  RECEIVED_VIA_LABELS,
} from '@/lib/notices';
import { useRequestGate } from '@/lib/request-gate';
import { formatMinor } from '@/lib/tenancy-format';
import { NoticeWarnings } from '../notice-warnings';
import { CloseAndCorrect } from './notice-close';
import { DraftActions } from './notice-draft-actions';
import { LadderCard } from './notice-ladder';
import { RecipientsCard } from './notice-recipients';
import { ServiceCard } from './notice-service';

/** The tracker: it loads the notice and hands each part what it needs. */
export function NoticeTracker({
  noticeId,
  saved,
  personId,
}: {
  readonly noticeId: string;
  readonly saved: boolean;
  readonly personId: string;
}) {
  const [notice, setNotice] = useState<NoticeDetail | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [message, setMessage] = useState<string | null>(saved ? 'Saved the draft.' : null);
  const gate = useRequestGate();

  const load = useCallback(async () => {
    const current = gate.begin();
    try {
      const next = await api().notices.get({ noticeId });
      if (!current()) return;
      setNotice(next);
      setProblem(null);
    } catch (failure) {
      if (current()) setProblem(toProblem(failure));
    }
  }, [gate, noticeId]);

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);

  const changed = useCallback((next: NoticeDetail, text?: string) => {
    setNotice(next);
    if (text) setMessage(text);
  }, []);

  const breadcrumb = (
    <nav aria-label="Breadcrumb" className="text-sm">
      <Link href="/notices" className="underline underline-offset-2">
        Notices
      </Link>{' '}
      <span aria-hidden="true">›</span> <span>{notice?.number ?? 'Notice'}</span>
    </nav>
  );

  if (!notice) {
    return (
      <>
        {breadcrumb}
        <PageHeader title="Notice" />
        {problem ? (
          problem.status === 404 || problem.status === 400 ? (
            <Alert tone="info">This notice does not exist, or it is not one you can see.</Alert>
          ) : noticeRefusal(problem) === 'not_on_plan' ||
            problem.code?.toUpperCase() === 'NOT_ON_PLAN' ? (
            <Alert tone="info">Legal notices are not on your company’s plan.</Alert>
          ) : (
            <LoadFailed message={problem.message} onRetry={() => void load()} />
          )
        ) : (
          <Loading what="the notice" />
        )}
      </>
    );
  }

  const live = isLiveStatus(notice.status);
  return (
    <>
      {breadcrumb}
      <div className="space-y-2">
        <PageHeader title={noticeTitle(notice)} description={notice.subtypeLabel ?? undefined} />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <NoticeStatusBadge status={notice.status} />
          {notice.outcome ? <NoticeOutcomeBadge outcome={notice.outcome} /> : null}
          {notice.ladder.paused ? <Badge tone="amber">Reminders paused</Badge> : null}
          {notice.ladder.cancelled ? <Badge tone="dark">Reminders cancelled</Badge> : null}
          {notice.servedTooLate ? <Badge tone="red">Served too late for its date</Badge> : null}
          {notice.tenant ? (
            <Link href={`/tenants/${notice.tenant.id}`} className="underline underline-offset-2">
              {notice.tenant.name}
            </Link>
          ) : (
            <span>Every tenant of {notice.property.name}</span>
          )}
          {notice.unitCode ? <span className="font-mono text-xs">{notice.unitCode}</span> : null}
        </div>
        {notice.corrects ? (
          <p className="text-sm text-slate-700" data-testid="notice-corrects">
            This notice corrects{' '}
            <Link href={`/notices/${notice.corrects.id}`} className="underline underline-offset-2">
              {notice.corrects.number ?? 'an earlier notice'}
            </Link>
            . Issuing it closes that one as superseded.
          </p>
        ) : null}
        {notice.correctedBy ? (
          <Alert tone="info" title="Corrected by a later notice">
            <span data-testid="notice-corrected-by">
              <Link
                href={`/notices/${notice.correctedBy.id}`}
                className="underline underline-offset-2"
              >
                {notice.correctedBy.number ?? 'The correction'}
              </Link>{' '}
              replaces this notice. This one stays on record as it was issued.
            </span>
          </Alert>
        ) : null}
      </div>

      {message ? <Alert tone="success">{message}</Alert> : null}

      {approvedButReturned(notice) ? (
        <Alert tone="error" title="Approved, but it could not be issued">
          <span data-testid="approved-not-issued">
            Both approvals were given, but when it came to issue the notice no longer held, so it
            went back to draft. Change the draft and submit it again.
          </span>
          {notice.blockers.length ? (
            <ul className="mt-1 list-disc pl-5">
              {notice.blockers.map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : notice.blockers.length ? (
        <Alert tone="error" title="It cannot be issued as it stands">
          <ul className="list-disc space-y-1 pl-5" data-testid="notice-blockers">
            {notice.blockers.map((b) => (
              <li key={b.code}>{b.message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {notice.servedTooLateDetail ? (
        <Alert tone="error" title="Served too late for its date">
          {notice.servedTooLateDetail.reason} From the service date, the earliest lawful date is{' '}
          {formatBusinessDate(notice.servedTooLateDetail.earliestFromService)},{' '}
          {notice.servedTooLateDetail.shortByDays} days after the date the notice states.
          {notice.actions.correct ? ' Correct it with a new notice below.' : ''}
        </Alert>
      ) : null}
      {quitBarText(notice.quitBar) ? (
        <Alert
          tone={notice.quitBar?.barred ? 'error' : 'info'}
          title="Rent Officer assessment (s.23)"
        >
          {quitBarText(notice.quitBar)}
        </Alert>
      ) : null}
      <NoticeWarnings warnings={orderedWarnings(notice.warnings)} />

      <DraftActions notice={notice} personId={personId} onChanged={changed} />
      <FactsCard notice={notice} />
      {notice.document.sha256 ||
      notice.document.servicePackReady ||
      notice.type === 'tenant_originated' ? (
        <DocumentsCard notice={notice} />
      ) : null}
      {notice.recipients.length ? <RecipientsCard notice={notice} /> : null}
      {notice.issuedAt ? <LadderCard notice={notice} onChanged={changed} /> : null}
      {notice.issuedAt || notice.serviceRecords.length ? (
        <ServiceCard notice={notice} personId={personId} onChanged={changed} />
      ) : null}
      {notice.tasks.length ? <TasksCard notice={notice} /> : null}
      {live || notice.actions.correct || notice.actions.close ? (
        <CloseAndCorrect notice={notice} onChanged={changed} />
      ) : null}
      {notice.closedAt ? (
        <Card data-testid="notice-closed">
          <CardHeader title="Closed" level={2} />
          <CardBody>
            <p className="text-sm">
              {notice.outcome ? <NoticeOutcomeBadge outcome={notice.outcome} /> : null}{' '}
              {notice.closedByName ? `by ${notice.closedByName}, ` : ''}
              <ClosedTime at={notice.closedAt} />
            </p>
            {notice.closeNote ? (
              <p className="text-sm whitespace-pre-wrap text-slate-800">{notice.closeNote}</p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}

function ClosedTime({ at }: { readonly at: string }) {
  const { timeZone } = useApp();
  return <time dateTime={at}>{formatTime(at, timeZone)}</time>;
}

const COMPLETION_TEXT: Record<NoticeDetail['completion'], string> = {
  any_one: 'One signature acknowledges receipt for the company, and stops every reminder.',
  each: 'Each recipient acknowledges receipt for themselves.',
};

/** The facts the notice carries, frozen at issue. */
function FactsCard({ notice }: { readonly notice: NoticeDetail }) {
  const { timeZone } = useApp();
  const fields = draftOfFields(notice.fields);
  return (
    <Card data-testid="notice-facts">
      <CardHeader
        title="The notice"
        description={
          notice.issuedAt
            ? 'Frozen at issue: an issued notice is never edited. A correction is a new notice.'
            : 'A draft: it can still change.'
        }
      />
      <CardBody>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Fact label="Effective date">
            {notice.effectiveDate ? formatBusinessDate(notice.effectiveDate) : 'None'}
          </Fact>
          <Fact label="Earliest lawful date">
            {notice.earliest
              ? earliestText(notice.earliest)
              : notice.earliestLawfulDate
                ? formatBusinessDate(notice.earliestLawfulDate)
                : 'None for this type'}
          </Fact>
          <Fact label="Issued">
            {notice.issuedAt ? formatTime(notice.issuedAt, timeZone) : 'Not yet'}
          </Fact>
          <Fact label="Links work until">
            {notice.linkExpiresAt ? formatTime(notice.linkExpiresAt, timeZone) : 'Set at issue'}
          </Fact>
          <Fact label="Electronic service">
            {notice.electronicService === null
              ? 'Decided at issue'
              : notice.electronicService
                ? 'Yes: the lease’s clause names the addresses it went to'
                : 'No: service is physical'}
          </Fact>
          <Fact label="Acknowledgement">{COMPLETION_TEXT[notice.completion]}</Fact>
          <Fact label="Wording">
            Template {notice.template.key}, version {notice.template.version}:{' '}
            {notice.template.counselReviewed
              ? 'reviewed by counsel'
              : 'not yet reviewed by counsel'}
          </Fact>
          {notice.createdByName ? <Fact label="Drafted by">{notice.createdByName}</Fact> : null}
          {Object.entries(fields)
            .filter(
              ([field]) => field !== 'documentId' && field !== 'propertyId' && field !== 'blockIds',
            )
            .map(([field, value]) => (
              <Fact key={field} label={NOTICE_FIELD_LABELS[field] ?? field}>
                {renderField(field, value, notice.fields[field])}
              </Fact>
            ))}
        </dl>
        {notice.ruleVersions.length ? (
          <div className="space-y-1 text-sm">
            <p className="font-medium text-slate-900">Rules used</p>
            <ul className="space-y-1">
              {notice.ruleVersions.map((rule) => (
                <li key={rule.ruleId} className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-xs">{rule.key}</code>
                  <Badge tone={rule.verificationStatus === 'verified' ? 'green' : 'amber'}>
                    {rule.verificationStatus === 'verified'
                      ? 'Verified'
                      : rule.verificationStatus === 'from_prd'
                        ? 'From the PRD, not verified'
                        : 'Not verified'}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function renderField(field: string, shown: string | readonly string[], raw: unknown): string {
  if (Array.isArray(shown)) return shown.length === 1 ? '1 item' : `${shown.length} items`;
  if (field === 'receivedVia' && typeof shown === 'string')
    return RECEIVED_VIA_LABELS[shown as keyof typeof RECEIVED_VIA_LABELS] ?? shown;
  const kind = fieldKind(field);
  if (kind === 'money' && typeof raw === 'number') return formatMinor(raw);
  if (kind === 'date' && typeof shown === 'string') return formatBusinessDate(shown);
  return shown as string;
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-slate-600">{label}</dt>
      <dd className="break-words whitespace-pre-wrap">{children}</dd>
    </div>
  );
}

/** The frozen notice, the signed acknowledgement and the service pack, each a short-lived link. */
function DocumentsCard({ notice }: { readonly notice: NoticeDetail }) {
  const [problem, setProblem] = useState<string | null>(null);
  async function open(which: 'notice' | 'signed' | 'service_pack' | 'received') {
    setProblem(null);
    try {
      await openFetchedLink(
        async () => (await api().notices.download({ noticeId: notice.id, which })).url,
      );
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }
  return (
    <Card data-testid="notice-documents">
      <CardHeader title="Documents" />
      <CardBody>
        <ul className="space-y-2 text-sm">
          {notice.type === 'tenant_originated' ? (
            <li>
              <Button size="sm" variant="secondary" onClick={() => void open('received')}>
                Open the tenant’s document
              </Button>
            </li>
          ) : null}
          {notice.document.sha256 ? (
            <li className="space-y-1">
              <Button size="sm" variant="secondary" onClick={() => void open('notice')}>
                Open the notice (PDF)
              </Button>
              <p className="font-mono text-xs break-all text-slate-600">
                SHA-256 {notice.document.sha256}
              </p>
            </li>
          ) : null}
          {notice.document.signedSha256 ? (
            <li className="space-y-1">
              <Button size="sm" variant="secondary" onClick={() => void open('signed')}>
                Open the signed acknowledgement (PDF)
              </Button>
              <p className="font-mono text-xs break-all text-slate-600">
                SHA-256 {notice.document.signedSha256}
              </p>
            </li>
          ) : null}
          {notice.document.servicePackReady ? (
            <li>
              <Button size="sm" variant="secondary" onClick={() => void open('service_pack')}>
                Open the physical service pack
              </Button>
              <p className="text-xs text-slate-600">
                A cover sheet, the frozen notice and a service affidavit to complete. The
                affidavit’s wording is still to come from your lawyer.
              </p>
            </li>
          ) : null}
        </ul>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
      </CardBody>
    </Card>
  );
}

function TasksCard({ notice }: { readonly notice: NoticeDetail }) {
  const { timeZone } = useApp();
  return (
    <Card data-testid="notice-tasks">
      <CardHeader
        title="Tasks"
        actions={
          <Link href="/tasks" className="text-sm font-medium underline underline-offset-2">
            All tasks
          </Link>
        }
      />
      <CardBody>
        <ul className="divide-y divide-slate-100 text-sm">
          {notice.tasks.map((task) => (
            <li key={task.id} className="space-y-1 py-2" data-testid="notice-task">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{task.title}</span>
                <Badge
                  tone={
                    task.status === 'open' ? 'amber' : task.status === 'done' ? 'green' : 'dark'
                  }
                >
                  {task.status === 'open' ? 'Open' : task.status === 'done' ? 'Done' : 'Cancelled'}
                </Badge>
              </p>
              <p className="text-slate-600">
                {task.kindLabel} · {task.assignee?.name ?? 'Nobody assigned'} · due{' '}
                {formatTime(task.dueAt, timeZone)}
              </p>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
