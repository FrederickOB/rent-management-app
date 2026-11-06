'use client';

import type { NoticeCompose, NoticeDetail } from '@rent/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import {
  composeInputOf,
  earliestText,
  effectiveProblem,
  noticeTitle,
  orderedWarnings,
  quitBarText,
  warningTitle,
} from '@/lib/notices';
import { NoticeChannelPlan } from './notice-channel-plan';
import { NoticeWarnings } from './notice-warnings';
import { Alert } from './ui/alert';

/**
 * What an approver reads before approving a notice (review item 1; CLAUDE.md section 7: warnings
 * show where the value is used): the tenant, unit, type, effective date and earliest lawful date,
 * every warning (unverified rules, counsel's wording, no electronic-service clause, withheld
 * channels), the blockers, and a link to the notice with its preview.
 */
export function NoticeApprovalSummary({ notice }: { readonly notice: NoticeDetail }) {
  const [check, setCheck] = useState<NoticeCompose | null>(null);
  const preIssue = !notice.issuedAt;

  useEffect(() => {
    if (!preIssue) return undefined;
    let current = true;
    api()
      .notices.compose(composeInputOf(notice))
      .then(
        (answer) => {
          if (current) setCheck(answer);
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [preIssue, notice]);

  const warnings = orderedWarnings(check?.warnings ?? notice.warnings);
  const blockers = check?.blockers ?? notice.blockers;
  const earliest = check?.earliest ?? notice.earliest;
  const dateProblem = check ? effectiveProblem(check.effectiveCheck) : null;
  const bar = quitBarText(check?.quitBar ?? notice.quitBar);
  const counsel = check?.template.counselReviewed ?? notice.template.counselReviewed;
  const recipients = check?.recipients ?? notice.recipients;

  return (
    <div className="space-y-3" data-testid="approval-notice">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-slate-600">Notice</dt>
          <dd>
            <Link
              href={`/notices/${notice.id}`}
              className="font-medium underline underline-offset-2"
            >
              {noticeTitle(notice)}
            </Link>
            {notice.subtypeLabel ? <p className="text-slate-700">{notice.subtypeLabel}</p> : null}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600">To</dt>
          <dd>
            {notice.tenant?.name ?? `Every tenant of ${notice.property.name}`}
            {notice.unitCode ? (
              <span className="ml-1 font-mono text-xs">{notice.unitCode}</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-slate-600">Effective date</dt>
          <dd data-testid="approval-effective-date">
            {notice.effectiveDate ? formatBusinessDate(notice.effectiveDate) : 'None'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-600">Earliest lawful date</dt>
          <dd data-testid="approval-earliest-date">
            {earliest ? earliestText(earliest) : 'None for this type'}
          </dd>
        </div>
      </dl>
      {blockers.length ? (
        <Alert tone="error" title="It cannot be issued as it stands" live={false}>
          <ul className="list-disc space-y-1 pl-5">
            {blockers.map((b) => (
              <li key={b.code}>{b.message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {dateProblem ? (
        <Alert tone="error" title="The date is too early" live={false}>
          {dateProblem}
        </Alert>
      ) : null}
      {bar ? (
        <Alert tone="warning" title="Rent Officer assessment (s.23)" live={false}>
          {bar}
        </Alert>
      ) : null}
      <NoticeWarnings warnings={warnings} />
      {!counsel && !warnings.some((w) => w.code === 'counsel_wording_outstanding') ? (
        <Alert
          tone="warning"
          title={warningTitle({ code: 'counsel_wording_outstanding' })}
          live={false}
        >
          This version of the wording has not been reviewed by counsel.
        </Alert>
      ) : null}
      {recipients.length ? (
        <div className="space-y-1">
          <p className="text-sm font-medium text-slate-900">Who it goes to, and how</p>
          <NoticeChannelPlan recipients={recipients} />
        </div>
      ) : null}
      <Link
        href={`/notices/${notice.id}`}
        className="inline-flex min-h-9 items-center text-sm font-medium underline underline-offset-2"
      >
        Open the notice and its preview
      </Link>
    </div>
  );
}
