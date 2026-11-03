'use client';

import type { LeaseDetailView } from '@rent/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { secondaryLink } from '@/components/link-styles';
import { ReasonForm } from '@/components/reason-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import type { ApprovalRow } from '@/lib/approvals';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import type { LeasePermissions } from './lease-detail';
import { IssueForSigning } from './lease-signing';

type Open = 'issue' | 'cancel' | 'cancel_signed' | 'ending' | 'move_out' | null;

/** The reason the cancel-signed approval needs (the API asks for at least 10 characters). */
const CANCEL_SIGNED_MIN = 10;

/**
 * What can be done with a lease now (plan 4.7 and 4.10): edit or cancel a draft; cancel a signed
 * lease before it starts, which a second person approves (decision 6); offer a renewal; record
 * that it is ending; record the move-out. Issuing a draft for signing is the e-signing step.
 */
export function LeaseActions({
  lease,
  can,
  onChanged,
}: {
  readonly lease: LeaseDetailView;
  readonly can: LeasePermissions;
  readonly onChanged: (next: LeaseDetailView, text: string) => void;
}) {
  const router = useRouter();
  const { me, timeZone } = useApp();
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<ApprovalRow | null>(null);
  const today = todayIn(timeZone);
  const status = lease.status;
  const beforeStart = today < lease.terms.startDate;
  const current = status === 'active' || status === 'holding_over';

  // A cancellation already waiting for a second person, so nobody asks twice.
  const findRequest = useCallback(async () => {
    if (!can.seeApprovals || status !== 'signed') return;
    try {
      const rows = await api().approvals.list({ status: 'open' });
      setRequest(
        rows.find(
          (r) =>
            r.actionType === 'lease.cancel_signed' &&
            r.subjectType === 'lease' &&
            r.subjectId === lease.id,
        ) ?? null,
      );
    } catch {
      setRequest(null);
    }
  }, [can.seeApprovals, status, lease.id]);

  useEffect(() => {
    void findRequest();
  }, [findRequest]);

  async function renew() {
    setBusy(true);
    setError(null);
    try {
      const renewal = await api().leases.renewal({ leaseId: lease.id });
      router.push(`/leases/${renewal.id}?saved=renewal`);
    } catch (failure) {
      setError(toProblem(failure).message);
      setBusy(false);
    }
  }

  const anything =
    can.manage &&
    (status === 'draft' ||
      current ||
      status === 'ending' ||
      (status === 'signed' && beforeStart && can.cancelSigned));

  return (
    <Card data-testid="lease-actions">
      <CardHeader title="What happens next" />
      <CardBody>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {status === 'draft' ? (
          <p className="text-sm text-slate-700">
            This is a draft. Its terms can change until it is sent for signing.
          </p>
        ) : null}
        {status === 'pending_signatures' ? (
          <p className="text-sm text-slate-700">
            Out for signature. Follow each signer, hand over links and recall it under Signing.
          </p>
        ) : null}
        {status === 'signed' ? (
          <p className="text-sm text-slate-700">
            Signed. The unit is reserved, and the lease starts on{' '}
            {formatBusinessDate(lease.terms.startDate)}.
          </p>
        ) : null}
        {request ? (
          <Alert tone="info" title="Cancellation waiting for approval">
            {request.initiatedBy === me.personId ? 'You' : 'Someone'} asked on{' '}
            {formatTime(request.createdAt, timeZone)} to cancel this lease. A second person must
            approve it; whoever asked cannot.{' '}
            <Link href="/approvals" className="font-medium underline underline-offset-2">
              Open approvals
            </Link>
          </Alert>
        ) : null}
        {lease.renewal ? (
          <p className="text-sm">
            A renewal is drafted.{' '}
            <Link
              href={`/leases/${lease.renewal.id}`}
              className="font-medium underline underline-offset-2"
            >
              Open the renewal
            </Link>
          </p>
        ) : null}

        {anything && open === null ? (
          <div className="flex flex-wrap gap-2">
            {status === 'draft' ? (
              <>
                {lease.template ? (
                  <Button onClick={() => setOpen('issue')}>Send for signing</Button>
                ) : null}
                <Link href={`/leases/${lease.id}/edit`} className={secondaryLink}>
                  Edit the draft
                </Link>
                <Button variant="ghost" onClick={() => setOpen('cancel')}>
                  Cancel the draft
                </Button>
              </>
            ) : null}
            {status === 'signed' && beforeStart && can.cancelSigned && !request ? (
              <Button variant="secondary" onClick={() => setOpen('cancel_signed')}>
                Cancel the signed lease
              </Button>
            ) : null}
            {current && !lease.renewal ? (
              <Button pending={busy} onClick={() => void renew()}>
                Offer a renewal
              </Button>
            ) : null}
            {current ? (
              <Button variant="secondary" onClick={() => setOpen('ending')}>
                Record that it is ending
              </Button>
            ) : null}
            {current || status === 'ending' ? (
              <Button variant="secondary" onClick={() => setOpen('move_out')}>
                Record the move-out
              </Button>
            ) : null}
          </div>
        ) : null}

        {open === 'issue' ? (
          <IssueForSigning
            lease={lease}
            onChanged={(next, text) => {
              setOpen(null);
              onChanged(next, text);
            }}
            onCancel={() => setOpen(null)}
          />
        ) : null}
        {open === 'cancel' ? (
          <ReasonForm
            label="Cancel the draft"
            intro="The draft is kept, marked cancelled. Nothing was signed."
            minLength={3}
            submitText="Cancel the draft"
            danger
            onSubmit={async (reason) => {
              const next = await api().leases.cancel({ leaseId: lease.id, reason });
              setOpen(null);
              onChanged(next, 'Cancelled the draft.');
            }}
            onCancel={() => setOpen(null)}
          />
        ) : null}
        {open === 'cancel_signed' ? (
          <ReasonForm
            label="Cancel the signed lease"
            intro="A signed lease is cancelled only when a second person approves. You cannot approve your own request."
            minLength={CANCEL_SIGNED_MIN}
            submitText="Ask for approval"
            onSubmit={async (reason) => {
              const created = await api().leases.cancelSigned({ leaseId: lease.id, reason });
              setRequest(created);
              setOpen(null);
              onChanged(
                lease,
                created.mode === 'single_user'
                  ? 'Asked to cancel the lease. Nobody else can approve, so you can confirm it yourself in Approvals after the cooling-off period.'
                  : 'Asked to cancel the lease. A second person must approve it in Approvals.',
              );
            }}
            onCancel={() => setOpen(null)}
          />
        ) : null}
        {open === 'ending' ? (
          <EndingForm
            lease={lease}
            onChanged={(next, text) => {
              setOpen(null);
              onChanged(next, text);
            }}
            onCancel={() => setOpen(null)}
          />
        ) : null}
        {open === 'move_out' ? (
          <MoveOutForm
            lease={lease}
            today={today}
            onChanged={(next, text) => {
              setOpen(null);
              onChanged(next, text);
            }}
            onCancel={() => setOpen(null)}
          />
        ) : null}
      </CardBody>
    </Card>
  );
}

function EndingForm({
  lease,
  onChanged,
  onCancel,
}: {
  readonly lease: LeaseDetailView;
  readonly onChanged: (next: LeaseDetailView, text: string) => void;
  readonly onCancel: () => void;
}) {
  const [reason, setReason] = useState<'non_renewal' | 'notice'>('non_renewal');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const next = await api().leases.ending({
        leaseId: lease.id,
        reason,
        note: note.trim() || null,
      });
      onChanged(next, 'Recorded that the lease is ending.');
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Record that the lease is ending"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <p className="text-sm text-slate-700">
        The lease stays in force until the move-out is recorded. A notice to quit never ends a
        tenancy by itself.
      </p>
      <SelectField
        label="Why"
        value={reason}
        options={[
          { value: 'non_renewal', label: 'It will not be renewed' },
          { value: 'notice', label: 'Notice has been given' },
        ]}
        onChange={(event) => setReason(event.target.value === 'notice' ? 'notice' : 'non_renewal')}
      />
      <TextAreaField
        label="Note (optional)"
        rows={2}
        maxLength={500}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        className="[&_textarea]:font-sans"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Record it
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function MoveOutForm({
  lease,
  today,
  onChanged,
  onCancel,
}: {
  readonly lease: LeaseDetailView;
  readonly today: string;
  readonly onChanged: (next: LeaseDetailView, text: string) => void;
  readonly onCancel: () => void;
}) {
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outOfRange = !date || date < lease.terms.startDate || date > today;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (outOfRange) {
      setError('The move-out date is between the start of the lease and today.');
      return;
    }
    setPending(true);
    try {
      const next = await api().leases.moveOut({
        leaseId: lease.id,
        moveOutDate: date,
        note: note.trim() || null,
      });
      onChanged(next, 'Recorded the move-out. The lease has ended and the unit is free.');
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Record the move-out"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <p className="text-sm text-slate-700">
        The lease ends on the move-out date and the unit becomes vacant. The full move-out, with the
        inspection and the deposit, comes later.
      </p>
      <TextField
        label="Moved out on"
        type="date"
        min={lease.terms.startDate}
        max={today}
        value={date}
        onChange={(event) => setDate(event.target.value)}
        className="max-w-xs"
      />
      <TextAreaField
        label="Note (optional)"
        rows={2}
        maxLength={300}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        className="[&_textarea]:font-sans"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" pending={pending}>
          Record the move-out
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
