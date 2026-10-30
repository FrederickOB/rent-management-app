'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useApp } from '@/components/app-context';
import { Alert } from '@/components/ui/alert';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextAreaField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import {
  APPROVAL_STATUS_LABELS,
  approvalActionLabel,
  approvalMoves,
  closeReasonLabel,
  payloadReason,
  personName,
  subjectHref,
  type ApprovalRow,
} from '@/lib/approvals';
import { formatBusinessDate } from '@/lib/business-dates';
import { cn } from '@/lib/cn';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { useRequestGate } from '@/lib/request-gate';

type Which = 'open' | 'closed';

const STATUS_TONES: Record<ApprovalRow['status'], BadgeTone> = {
  pending: 'blue',
  cooling_off: 'amber',
  approved: 'green',
  rejected: 'red',
  cancelled: 'dark',
  expired: 'dark',
};

const DECISION_LABELS: Record<ApprovalRow['decisions'][number]['kind'], string> = {
  approve: 'Approved',
  reject: 'Rejected',
  self_confirm: 'Confirmed after the cooling-off',
};

interface Subject {
  readonly title: string;
  readonly detail: string | null;
}

/** A line about the record a request is for: the lease's unit and tenant, when this person may see it. */
async function describe(row: ApprovalRow): Promise<Subject | null> {
  if (row.subjectType !== 'lease') return null;
  try {
    const lease = await api().leases.get({ leaseId: row.subjectId });
    return lease.access === 'full'
      ? {
          title: `Lease for ${lease.unit.code}`,
          detail: `${lease.tenant.displayName} · starts ${formatBusinessDate(lease.terms.startDate)}`,
        }
      : { title: `Lease for ${lease.unit.code}`, detail: null };
  } catch {
    return null;
  }
}

/** The approvals screen (AD-05; M3 decision 6), on M1's endpoints. */
export function ApprovalsView({ names }: { readonly names: readonly [string, string][] }) {
  const { me } = useApp();
  const [which, setWhich] = useState<Which>('open');
  const [rows, setRows] = useState<readonly ApprovalRow[] | null>(null);
  const [subjects, setSubjects] = useState<ReadonlyMap<string, Subject>>(new Map());
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const people = useMemo(() => new Map(names), [names]);
  const tabRefs = useRef<Record<Which, HTMLButtonElement | null>>({ open: null, closed: null });
  // A reply for the other tab, or an older reload, is dropped: switching to "Closed" mid-load
  // never shows waiting requests with their Approve buttons.
  const gate = useRequestGate();

  function choose(tab: Which) {
    if (tab === which) return;
    gate.cancel();
    setWhich(tab);
    setRows(null);
    setSubjects(new Map());
    setNotice(null);
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: Which = which === 'open' ? 'closed' : 'open';
    choose(next);
    tabRefs.current[next]?.focus();
  }

  const load = useCallback(async () => {
    const current = gate.begin();
    try {
      const list = await api().approvals.list({ status: which });
      if (!current()) return;
      setRows(list);
      setProblem(null);
      const described = await Promise.all(
        list.map(async (r) => [r.id, await describe(r)] as const),
      );
      if (!current()) return;
      setSubjects(new Map(described.filter((d): d is readonly [string, Subject] => d[1] !== null)));
    } catch (failure) {
      if (current()) setProblem(toProblem(failure).message);
    }
  }, [gate, which]);

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);

  const changed = async (text: string) => {
    setNotice(text);
    await load();
  };

  return (
    <>
      <div role="tablist" aria-label="Which requests" className="flex gap-2">
        {(['open', 'closed'] as const).map((tab) => (
          <button
            key={tab}
            ref={(element) => {
              tabRefs.current[tab] = element;
            }}
            id={`approvals-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={which === tab}
            aria-controls="approvals-panel"
            tabIndex={which === tab ? 0 : -1}
            onKeyDown={onTabKey}
            onClick={() => choose(tab)}
            className={cn(
              'min-h-11 rounded-md px-4 py-2 text-sm font-medium',
              which === tab
                ? 'bg-brand text-brand-contrast'
                : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-100',
            )}
          >
            {tab === 'open' ? 'Waiting' : 'Closed'}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="approvals-panel"
        aria-labelledby={`approvals-tab-${which}`}
        className="space-y-4"
      >
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {rows === null ? (
          <p role="status" className="text-sm text-slate-600">
            Loading…
          </p>
        ) : rows.length === 0 ? (
          <Card>
            <CardBody>
              <p className="text-sm text-slate-600">
                {which === 'open'
                  ? 'Nothing is waiting for a decision.'
                  : 'No closed requests yet.'}
              </p>
            </CardBody>
          </Card>
        ) : (
          <ul className="space-y-4">
            {rows.map((row) => (
              <li key={row.id}>
                <ApprovalItem
                  row={row}
                  subject={subjects.get(row.id) ?? null}
                  personId={me.personId}
                  people={people}
                  onChanged={changed}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function ApprovalItem({
  row,
  subject,
  personId,
  people,
  onChanged,
}: {
  readonly row: ApprovalRow;
  readonly subject: Subject | null;
  readonly personId: string;
  readonly people: ReadonlyMap<string, string>;
  readonly onChanged: (text: string) => Promise<void>;
}) {
  const { timeZone } = useApp();
  const moves = approvalMoves(row, personId, new Date());
  const reason = payloadReason(row.payload);
  const href = subjectHref(row);
  const who = personName(row.initiatedBy, { personId }, people);
  const closed = closeReasonLabel(row.closeReason);
  const label = approvalActionLabel(row.actionType);

  return (
    <Card data-testid="approval">
      <CardHeader
        title={label}
        description={
          <>
            Asked by {who}, {formatTime(row.createdAt, timeZone)}
          </>
        }
        actions={
          <Badge tone={STATUS_TONES[row.status]}>{APPROVAL_STATUS_LABELS[row.status]}</Badge>
        }
      />
      <CardBody>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {subject || href ? (
            <div className="min-w-0">
              <dt className="text-slate-600">For</dt>
              <dd>
                {href ? (
                  <Link href={href} className="font-medium underline underline-offset-2">
                    {subject?.title ?? 'Open the record'}
                  </Link>
                ) : (
                  subject?.title
                )}
                {subject?.detail ? <p className="text-slate-700">{subject.detail}</p> : null}
              </dd>
            </div>
          ) : null}
          {reason ? (
            <div className="min-w-0">
              <dt className="text-slate-600">Reason given</dt>
              <dd className="break-words">{reason}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-slate-600">
              {row.status === 'pending' || row.status === 'cooling_off'
                ? 'Closes unanswered'
                : 'Was open until'}
            </dt>
            <dd>{formatTime(row.expiresAt, timeZone)}</dd>
          </div>
          {closed ? (
            <div>
              <dt className="text-slate-600">Outcome</dt>
              <dd>{closed}</dd>
            </div>
          ) : null}
        </dl>

        {row.decisions.length ? (
          <ul className="space-y-1 text-sm" aria-label="Decisions">
            {row.decisions.map((d) => (
              <li key={`${d.decidedBy}-${d.decidedAt}`}>
                <strong>{DECISION_LABELS[d.kind]}</strong> by{' '}
                {personName(d.decidedBy, { personId }, people)}, {formatTime(d.decidedAt, timeZone)}
                {d.reason ? `: ${d.reason}` : ''}
              </li>
            ))}
          </ul>
        ) : null}

        {moves.waiting === 'second_person' ? (
          <Alert tone="info">
            Waiting for a second person. You asked, so you cannot approve this yourself.
          </Alert>
        ) : null}
        {moves.waiting === 'cooling_off' && row.coolingOffUntil ? (
          <Alert tone="info">
            Nobody else in your company can approve this. You can confirm it yourself after{' '}
            {formatTime(row.coolingOffUntil, timeZone)}, with a code from your authenticator app.
          </Alert>
        ) : null}

        {moves.decide ? <Decide row={row} label={label} onChanged={onChanged} /> : null}
        {moves.selfConfirm ? <SelfConfirm row={row} onChanged={onChanged} /> : null}
        {moves.withdraw ? <Withdraw row={row} onChanged={onChanged} /> : null}
      </CardBody>
    </Card>
  );
}

function Decide({
  row,
  label,
  onChanged,
}: {
  readonly row: ApprovalRow;
  readonly label: string;
  readonly onChanged: (text: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'reject') {
    setPending(decision);
    setError(null);
    try {
      const result = await api().approvals.decide({
        id: row.id,
        decision,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      await onChanged(
        result.status === 'approved'
          ? `Approved: ${label.toLowerCase()}. It has taken effect.`
          : result.status === 'rejected'
            ? 'Rejected the request. Nothing changed.'
            : result.status === 'cancelled'
              ? 'The record changed since the request was made, so the request was closed and nothing was done.'
              : 'Your decision is recorded.',
      );
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(null);
    }
  }

  return (
    <div
      role="group"
      aria-label={`Decide: ${label}`}
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <TextAreaField
        label="Note (optional)"
        hint="Kept with your decision."
        rows={2}
        maxLength={500}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        className="[&_textarea]:font-sans"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          pending={pending === 'approve'}
          disabled={pending !== null}
          onClick={() => void decide('approve')}
        >
          Approve
        </Button>
        <Button
          variant="danger"
          pending={pending === 'reject'}
          disabled={pending !== null}
          onClick={() => void decide('reject')}
        >
          Reject
        </Button>
      </div>
    </div>
  );
}

function SelfConfirm({
  row,
  onChanged,
}: {
  readonly row: ApprovalRow;
  readonly onChanged: (text: string) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setPending(true);
    try {
      await api().approvals.decide({ id: row.id, decision: 'self_confirm', code });
      await onChanged('Confirmed. It has taken effect.');
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Confirm it yourself"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <TextField
        label="6-digit code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
        className="max-w-xs"
      />
      <Button type="submit" pending={pending}>
        Confirm it myself
      </Button>
    </form>
  );
}

function Withdraw({
  row,
  onChanged,
}: {
  readonly row: ApprovalRow;
  readonly onChanged: (text: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function withdraw() {
    setPending(true);
    setError(null);
    try {
      await api().approvals.cancel({ id: row.id });
      await onChanged('Withdrew the request. Nothing changed.');
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button variant="ghost" pending={pending} onClick={() => void withdraw()}>
        Withdraw the request
      </Button>
    </div>
  );
}
