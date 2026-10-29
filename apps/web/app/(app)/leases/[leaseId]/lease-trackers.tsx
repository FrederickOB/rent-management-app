'use client';

import type { LeaseDetailView } from '@rent/contracts';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useApp } from '@/components/app-context';
import { LeasePaperField } from '@/components/lease-paper-field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { leasePaperProblems, uploadLeasePaper } from '@/lib/lease-upload';
import { stillTracked } from '@/lib/lease-view';
import { daysLeftLabel, ruleNote } from '@/lib/tenancy-format';
import { StorageUploadError } from '@/lib/upload';
import { parseBusinessDate, daysBetween } from '@rent/domain/dates';

type Trackers = LeaseDetailView['trackers'];
type Changed = (next: LeaseDetailView, text: string) => void;

function daysTo(today: string, date: string): number | null {
  try {
    return daysBetween(parseBusinessDate(today), parseBusinessDate(date));
  } catch {
    return null;
  }
}

function RuleWarning({ rule }: { readonly rule: Trackers['stamping']['rule'] }) {
  const note = ruleNote(rule);
  return note.warn ? (
    <Alert tone="warning" title="Unverified rule">
      {note.text}
    </Alert>
  ) : (
    <p className="text-sm text-slate-600">{note.text}</p>
  );
}

function Deadline({ deadline, today }: { readonly deadline: string; readonly today: string }) {
  const days = daysTo(today, deadline);
  return (
    <p className="text-sm">
      <span className="text-slate-600">Deadline: </span>
      <strong>{formatBusinessDate(deadline)}</strong>
      {days !== null && days < 0 ? (
        <strong className="text-red-700"> (overdue by {-days} days)</strong>
      ) : days !== null ? (
        <span className="text-slate-700"> ({daysLeftLabel(days)})</span>
      ) : null}
    </p>
  );
}

function Tracker({
  title,
  state,
  children,
  testId,
}: {
  readonly title: string;
  readonly state: 'done' | 'to_do' | 'not_needed';
  readonly children: ReactNode;
  readonly testId: string;
}) {
  return (
    <section data-testid={testId} className="space-y-3 rounded-md border border-slate-200 p-4">
      <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
        {title}
        {state === 'done' ? (
          <Badge tone="green">Done</Badge>
        ) : state === 'to_do' ? (
          <Badge tone="amber">To do</Badge>
        ) : (
          <Badge>Not needed</Badge>
        )}
      </h3>
      {children}
    </section>
  );
}

/**
 * The compliance trackers (TX-05, OQ-44, OQ-45; plan 4.11): Rent Control registration, stamping
 * and, for long terms, the formal lease. Deadlines come from the rules table and show as
 * unverified until counsel confirms them. Nothing here blocks rent collection or the lease.
 */
export function LeaseTrackers({
  lease,
  canManage,
  onChanged,
}: {
  readonly lease: LeaseDetailView;
  readonly canManage: boolean;
  readonly onChanged: Changed;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const { rentControl, stamping, formalLease } = lease.trackers;
  const live = stillTracked(lease);
  const manage = canManage && live;

  return (
    <Card data-testid="lease-trackers">
      <CardHeader
        title="Registration and stamping"
        description={
          live
            ? 'Reminders continue until each one is recorded. None of this stops rent being collected.'
            : 'This lease is no longer in force, so no more reminders go out. What was recorded stays.'
        }
      />
      <CardBody>
        <Tracker
          title="Rent Control registration"
          state={!rentControl.applies ? 'not_needed' : rentControl.done ? 'done' : 'to_do'}
          testId="tracker-rent-control"
        >
          {!rentControl.applies ? (
            <p className="text-sm text-slate-600">
              Not tracked for this lease. Commercial leases are tracked only when your company
              chooses.
            </p>
          ) : rentControl.done ? (
            <p className="text-sm">
              Registered as <strong className="font-mono">{rentControl.registrationNumber}</strong>{' '}
              on {formatBusinessDate(rentControl.registeredOn!)}.
            </p>
          ) : (
            <>
              {rentControl.deadline ? (
                <Deadline deadline={rentControl.deadline} today={today} />
              ) : null}
              <RuleWarning rule={rentControl.rule} />
              {manage ? (
                <RentControlForm lease={lease} today={today} onChanged={onChanged} />
              ) : null}
            </>
          )}
        </Tracker>

        <Tracker
          title="Stamping"
          state={stamping.done ? 'done' : 'to_do'}
          testId="tracker-stamping"
        >
          {stamping.done ? (
            <p className="text-sm">Stamped on {formatBusinessDate(stamping.stampedOn!)}.</p>
          ) : (
            <>
              {stamping.deadline ? <Deadline deadline={stamping.deadline} today={today} /> : null}
              <RuleWarning rule={stamping.rule} />
              {manage ? <StampingForm lease={lease} today={today} onChanged={onChanged} /> : null}
            </>
          )}
        </Tracker>

        <Tracker
          title="Formal lease"
          state={!formalLease.required ? 'not_needed' : formalLease.done ? 'done' : 'to_do'}
          testId="tracker-formal-lease"
        >
          {!formalLease.required ? (
            <>
              <p className="text-sm text-slate-600">Not needed for a term of this length.</p>
              <RuleWarning rule={formalLease.rule} />
            </>
          ) : (
            <>
              <p className="text-sm text-slate-700">
                For a term this long, the lease is also drawn up by a legal practitioner, signed in
                ink and registered with the Lands Commission. The e-signed lease records the agreed
                terms.
              </p>
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-slate-600">Legal practitioner</dt>
                  <dd>{formalLease.practitioner ?? 'Not recorded'}</dd>
                </div>
                <div>
                  <dt className="text-slate-600">Wet-signed copy</dt>
                  <dd>{formalLease.wetSignedCopy ? 'Uploaded' : 'Not uploaded'}</dd>
                </div>
                <div>
                  <dt className="text-slate-600">Lands Commission</dt>
                  <dd>
                    {formalLease.registeredOn
                      ? `${formalLease.registrationNumber ?? 'Registered'}, ${formatBusinessDate(formalLease.registeredOn)}`
                      : 'Not registered'}
                  </dd>
                </div>
              </dl>
              <RuleWarning rule={formalLease.rule} />
              {manage && !formalLease.done ? (
                <FormalLeaseForm lease={lease} today={today} onChanged={onChanged} />
              ) : null}
            </>
          )}
        </Tracker>
      </CardBody>
    </Card>
  );
}

function RentControlForm({
  lease,
  today,
  onChanged,
}: {
  readonly lease: LeaseDetailView;
  readonly today: string;
  readonly onChanged: Changed;
}) {
  const [number, setNumber] = useState('');
  const [date, setDate] = useState(today);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (number.trim().length < 2) {
      setError('Enter the Rent Control registration number.');
      return;
    }
    setPending(true);
    try {
      const next = await api().leases.rentControl({
        leaseId: lease.id,
        registrationNumber: number.trim(),
        registeredOn: date,
      });
      onChanged(next, 'Recorded the Rent Control registration.');
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Record the Rent Control registration"
      className="space-y-3"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Registration number"
          autoComplete="off"
          maxLength={40}
          value={number}
          onChange={(event) => setNumber(event.target.value)}
        />
        <TextField
          label="Registered on"
          type="date"
          max={today}
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      </div>
      <Button type="submit" variant="secondary" pending={pending}>
        Record the registration
      </Button>
    </form>
  );
}

function StampingForm({
  lease,
  today,
  onChanged,
}: {
  readonly lease: LeaseDetailView;
  readonly today: string;
  readonly onChanged: Changed;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [date, setDate] = useState(today);
  const [noIdCopy, setNoIdCopy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [tickError, setTickError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const file = input.current?.files?.[0];
    const paper = leasePaperProblems(file, { noIdCopy, missing: 'Choose the stamped copy.' });
    setFileError(paper.file);
    setTickError(paper.tick);
    if (!file || paper.file || paper.tick) return;
    try {
      setStatus('Uploading…');
      const uploadId = await uploadLeasePaper(file, lease.id);
      setStatus('Saving…');
      const next = await api().leases.stamping({ leaseId: lease.id, stampedOn: date, uploadId });
      onChanged(next, 'Recorded the stamped copy.');
    } catch (failure) {
      setStatus(null);
      setError(
        failure instanceof StorageUploadError ? failure.message : toProblem(failure).message,
      );
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Record the stamped copy" className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {status ? <Alert tone="info">{status}</Alert> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Stamped on"
          type="date"
          max={today}
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
        <LeasePaperField
          ref={input}
          label="Stamped copy"
          disabled={status !== null}
          error={fileError}
          required
          noIdCopy={noIdCopy}
          onNoIdCopy={(next) => {
            setNoIdCopy(next);
            setTickError(null);
          }}
          tickError={tickError}
        />
      </div>
      <Button type="submit" variant="secondary" pending={status !== null}>
        Record the stamped copy
      </Button>
    </form>
  );
}

function FormalLeaseForm({
  lease,
  today,
  onChanged,
}: {
  readonly lease: LeaseDetailView;
  readonly today: string;
  readonly onChanged: Changed;
}) {
  const formal = lease.trackers.formalLease;
  const input = useRef<HTMLInputElement>(null);
  const [practitioner, setPractitioner] = useState(formal.practitioner ?? '');
  const [registeredOn, setRegisteredOn] = useState(formal.registeredOn ?? '');
  const [number, setNumber] = useState(formal.registrationNumber ?? '');
  const [noIdCopy, setNoIdCopy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [tickError, setTickError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const file = input.current?.files?.[0];
    // The wet-signed copy is optional; when one is chosen, it is checked like any lease paper.
    const paper = leasePaperProblems(file, { noIdCopy });
    setFileError(paper.file);
    setTickError(paper.tick);
    if (paper.file || paper.tick) return;
    try {
      setStatus(file ? 'Uploading…' : 'Saving…');
      const wetSignedUploadId = file ? await uploadLeasePaper(file, lease.id) : undefined;
      setStatus('Saving…');
      const next = await api().leases.formalLease({
        leaseId: lease.id,
        practitioner: practitioner.trim() || null,
        ...(wetSignedUploadId ? { wetSignedUploadId } : {}),
        registeredOn: registeredOn || null,
        registrationNumber: number.trim() || null,
      });
      setStatus(null);
      // The copy is recorded: clear the picker, so saving again does not send it a second time.
      if (input.current) input.current.value = '';
      setNoIdCopy(false);
      onChanged(next, 'Saved the formal lease details.');
    } catch (failure) {
      setStatus(null);
      setError(
        failure instanceof StorageUploadError ? failure.message : toProblem(failure).message,
      );
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Record the formal lease" className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {status ? <Alert tone="info">{status}</Alert> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Legal practitioner"
          maxLength={160}
          value={practitioner}
          onChange={(event) => setPractitioner(event.target.value)}
        />
        <LeasePaperField
          ref={input}
          label="Wet-signed copy (optional)"
          disabled={status !== null}
          error={fileError}
          noIdCopy={noIdCopy}
          onNoIdCopy={(next) => {
            setNoIdCopy(next);
            setTickError(null);
          }}
          tickError={tickError}
        />
        <TextField
          label="Registered with the Lands Commission on (optional)"
          type="date"
          max={today}
          value={registeredOn}
          onChange={(event) => setRegisteredOn(event.target.value)}
        />
        <TextField
          label="Registration number (optional)"
          maxLength={60}
          value={number}
          onChange={(event) => setNumber(event.target.value)}
        />
      </div>
      <Button type="submit" variant="secondary" pending={status !== null}>
        Save the formal lease details
      </Button>
    </form>
  );
}
