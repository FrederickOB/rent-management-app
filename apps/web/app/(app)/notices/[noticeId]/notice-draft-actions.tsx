'use client';

import type { NoticeCompose, NoticeDetail } from '@rent/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useApp } from '@/components/app-context';
import { ConfirmBox } from '@/components/confirm-box';
import { secondaryLink } from '@/components/link-styles';
import { NoticeChannelPlan } from '@/components/notice-channel-plan';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  composeInputOf,
  earliestText,
  effectiveProblem,
  issuePlanLines,
  noticeRefusal,
  tooEarly,
} from '@/lib/notices';

const APPROVAL_STATUS_TEXT: Record<NonNullable<NoticeDetail['approval']>['status'], string> = {
  pending: 'Waiting for a second person to approve it',
  cooling_off: 'Waiting out the cooling-off period before it can be confirmed',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

/**
 * Before issue (plan 4.4 and 4.6; decision 8): the preview, editing, submitting, issuing,
 * returning to draft and discarding. A notice to quit never issues from here: it issues itself
 * when its two-person approval completes, and its initiator never approves it.
 */
export function DraftActions({
  notice,
  personId,
  onChanged,
}: {
  readonly notice: NoticeDetail;
  readonly personId: string;
  readonly onChanged: (next: NoticeDetail, text?: string) => void;
}) {
  const router = useRouter();
  const { timeZone } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [confirmingIssue, setConfirmingIssue] = useState(false);
  // The draft checked as the composer checks it: its channel plan and whether its date holds.
  const [check, setCheck] = useState<NoticeCompose | null>(null);
  const [checkProblem, setCheckProblem] = useState<string | null>(null);
  const { actions } = notice;
  const preIssue =
    !notice.issuedAt && notice.status !== 'cancelled' && notice.status !== 'received';

  useEffect(() => {
    if (!preIssue) return undefined;
    let current = true;
    api()
      .notices.compose(composeInputOf(notice))
      .then(
        (answer) => {
          if (current) {
            setCheck(answer);
            setCheckProblem(null);
          }
        },
        (failure: unknown) => {
          if (current) setCheckProblem(toProblem(failure).message);
        },
      );
    return () => {
      current = false;
    };
  }, [preIssue, notice]);

  if (!preIssue) return null;
  const early = tooEarly(check);
  const dateProblem = check ? effectiveProblem(check.effectiveCheck) : null;

  async function act(
    name: 'submit' | 'issue' | 'returnToDraft' | 'discard',
    text: string,
  ): Promise<void> {
    setBusy(name);
    setProblem(null);
    try {
      const call = api().notices;
      const next =
        name === 'submit'
          ? await call.submit({ noticeId: notice.id })
          : name === 'issue'
            ? await call.issue({ noticeId: notice.id })
            : name === 'returnToDraft'
              ? await call.returnToDraft({ noticeId: notice.id })
              : await call.discard({ noticeId: notice.id });
      setDiscarding(false);
      onChanged(next, text);
      router.refresh();
    } catch (failure) {
      const refusal = noticeRefusal(failure);
      setProblem(
        refusal === 'quit_disabled'
          ? 'Notices to quit are turned off for your company until an administrator accepts the risk statement in Notice settings.'
          : toProblem(failure).message,
      );
      // Issue checks the date and the s.23 bar again; a refusal comes back with its reasons.
      try {
        onChanged(await api().notices.get({ noticeId: notice.id }));
      } catch {
        // The error above is what matters.
      }
    } finally {
      setBusy(null);
    }
  }

  const approval = notice.approval;
  const isQuit = notice.type === 'notice_to_quit';
  const mine = approval?.initiatedBy === personId;
  return (
    <Card data-testid="draft-actions">
      <CardHeader
        title={notice.status === 'draft' ? 'Draft' : 'Before issue'}
        description={
          isQuit
            ? 'A notice to quit needs two people: it issues itself once a second person approves it. Whoever submits it can never approve it.'
            : 'Nothing is sent until the notice is issued.'
        }
      />
      <CardBody>
        {approval ? (
          <p className="text-sm" data-testid="notice-approval">
            Approval: <strong>{APPROVAL_STATUS_TEXT[approval.status]}</strong>
            {approval.status === 'cooling_off' && approval.coolingOffUntil
              ? ` until ${formatTime(approval.coolingOffUntil, timeZone)}`
              : ''}
            .{' '}
            {approval.status === 'pending' || approval.status === 'cooling_off' ? (
              <>
                {mine
                  ? 'You submitted it, so someone else must approve it. '
                  : approval.mayDecide
                    ? 'You may approve it. '
                    : ''}
                <Link href="/approvals" className="underline underline-offset-2">
                  Open Approvals
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
        {dateProblem ? (
          <Alert tone="error" title="The date is too early">
            <span data-testid="effective-problem">{dateProblem}</span> It can be saved, but not
            submitted or issued, until the date is changed.
          </Alert>
        ) : null}
        {check?.earliest ? (
          <p className="text-sm text-slate-700" data-testid="earliest-date">
            Earliest lawful date: {earliestText(check.earliest)}
          </p>
        ) : null}
        {check ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-900">Who it goes to, and how</p>
            <NoticeChannelPlan recipients={check.recipients} />
          </div>
        ) : null}
        {checkProblem ? <Alert tone="warning">{checkProblem}</Alert> : null}
        <Preview noticeId={notice.id} />
        <div className="flex flex-wrap gap-2">
          {actions.edit ? (
            <Link href={`/notices/${notice.id}/edit`} className={secondaryLink}>
              Edit the draft
            </Link>
          ) : null}
          {actions.issue && !confirmingIssue ? (
            <Button
              pending={busy === 'issue'}
              disabled={busy !== null || notice.blockers.length > 0 || early || check === null}
              onClick={() => setConfirmingIssue(true)}
            >
              Issue now
            </Button>
          ) : null}
          {actions.submit ? (
            <Button
              variant={actions.issue ? 'secondary' : 'primary'}
              pending={busy === 'submit'}
              disabled={busy !== null || early}
              onClick={() =>
                void act(
                  'submit',
                  isQuit
                    ? 'Submitted. It issues itself once a second person approves it.'
                    : 'Submitted for approval.',
                )
              }
            >
              Submit for approval
            </Button>
          ) : null}
          {actions.returnToDraft ? (
            <Button
              variant="secondary"
              pending={busy === 'returnToDraft'}
              disabled={busy !== null}
              onClick={() =>
                void act('returnToDraft', 'Back to draft. Its approval request is cancelled.')
              }
            >
              Take it back to change it
            </Button>
          ) : null}
          {actions.discard && !discarding ? (
            <Button variant="ghost" disabled={busy !== null} onClick={() => setDiscarding(true)}>
              Discard
            </Button>
          ) : null}
        </div>
        {confirmingIssue ? (
          <ConfirmBox
            label="Confirm issuing the notice"
            confirmText="Issue it now"
            pending={busy === 'issue'}
            onConfirm={() =>
              void act('issue', 'Issued. The notice is frozen and on its way.').then(() =>
                setConfirmingIssue(false),
              )
            }
            onCancel={() => setConfirmingIssue(false)}
          >
            <p className="font-medium">
              Issue it now? It is frozen, numbered and sent at once; it can then only be corrected
              by a new notice.
            </p>
            <ul className="mt-1 list-disc pl-5" data-testid="issue-plan">
              {issuePlanLines(check?.recipients ?? []).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </ConfirmBox>
        ) : null}
        {discarding ? (
          <ConfirmBox
            label="Confirm discarding the draft"
            confirmText="Discard the draft"
            pending={busy === 'discard'}
            onConfirm={() => void act('discard', 'Discarded. The draft stays on record.')}
            onCancel={() => setDiscarding(false)}
          >
            Discard this draft? It was never sent, and it stays on record as discarded.
          </ConfirmBox>
        ) : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
      </CardBody>
    </Card>
  );
}

/**
 * The notice as its PDF will read (plan 4.10). The HTML comes from our own template; it is still
 * shown in a sandboxed frame with no scripts, forms or access to this page, never inserted into
 * the page itself (M6 lesson).
 */
function Preview({ noticeId }: { readonly noticeId: string }) {
  const [preview, setPreview] = useState<{ html: string; counselReviewed: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function load() {
    setPending(true);
    setProblem(null);
    try {
      setPreview(await api().notices.preview({ noticeId }));
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      {preview ? (
        <>
          {!preview.counselReviewed ? (
            <Alert tone="warning" title="The wording is still to come from your lawyer">
              Every legal sentence reads “Wording to be supplied by your lawyer” until counsel
              supplies it. Do not send this to a real tenant before then.
            </Alert>
          ) : null}
          <iframe
            title="Preview of the notice"
            sandbox=""
            srcDoc={preview.html}
            className="h-[32rem] w-full rounded-md border border-slate-300 bg-white"
            data-testid="notice-preview"
          />
          <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
            Hide the preview
          </Button>
        </>
      ) : (
        <Button size="sm" variant="secondary" pending={pending} onClick={() => void load()}>
          Preview the notice
        </Button>
      )}
      {problem ? <Alert tone="error">{problem}</Alert> : null}
    </div>
  );
}
