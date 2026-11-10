'use client';

import type { DataProtectionRequestView } from '@rent/contracts';
import {
  DATA_PROTECTION_REQUEST_KINDS,
  type DataProtectionRequestKind,
  type DataProtectionRequestStatus,
} from '@rent/domain/data-protection';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, keyedApi } from '@/lib/api';
import { startDownload } from '@/lib/browser-files';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import {
  dataProtectionMessage,
  dueText,
  erasureLines,
  EXPORT_KEPT_TEXT,
  EXPORT_POLL_MS,
  EXPORT_POLL_TRIES,
  isClosed,
  leftOutText,
  nextStatuses,
  receivedProblem,
  REQUEST_KIND_LABELS,
  REQUEST_STATUS_LABELS,
} from '@/lib/data-protection';
import { toProblem } from '@/lib/errors';
import { isKeyReused, sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import type { PickedTenant } from '@/lib/record-picks';
import { useLoad } from '@/lib/use-load';
import { useApp } from './app-context';
import { ConfirmBox } from './confirm-box';
import { Empty, LoadFailed, Loading } from './load-state';
import { TenantPicker } from './record-pickers';
import { Alert } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardBody, CardHeader } from './ui/card';
import { SelectField, TextAreaField, TextField } from './ui/field';

const problemText = (failure: unknown): string =>
  dataProtectionMessage(failure) ?? toProblem(failure).message;

const STATUS_TONES: Record<DataProtectionRequestStatus, 'blue' | 'amber' | 'green' | 'neutral'> = {
  received: 'blue',
  in_progress: 'amber',
  completed: 'green',
  refused: 'neutral',
};

/**
 * The data protection request register (M11 decision 5; Act 843): access, correction, erasure and
 * objection requests with their due date, status and outcome. On a tenant's page it shows that
 * tenant's; under Settings it shows every request and picks the tenant. Every change is audited.
 */
export function DataProtectionRequests({
  tenant,
  canExport,
}: {
  /** The tenant whose requests these are; none under Settings, where each request names one. */
  readonly tenant?: { readonly id: string; readonly name: string };
  readonly canExport: boolean;
}) {
  const load = useCallback(
    () => api().dataProtection.list(tenant ? { tenantId: tenant.id } : {}),
    [tenant],
  );
  const { state, reload } = useLoad(load);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <Card data-testid="data-protection-requests">
      <CardHeader
        title="Data protection requests"
        description="A tenant may ask to see, correct or erase their personal data, or object to a use of it (Act 843). Record each request on the day it arrives; the platform keeps what the law requires it to keep, and says so."
      />
      <CardBody className="space-y-4">
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        <NewRequest
          tenant={tenant}
          onCreated={(text) => {
            setNotice(text);
            reload();
          }}
        />
        {state.status === 'loading' ? <Loading what="the requests" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' && state.data.length === 0 ? (
          <Empty>No request recorded.</Empty>
        ) : null}
        {state.status === 'ready' && state.data.length > 0 ? (
          <ul className="space-y-3">
            {state.data.map((request) => (
              <RequestItem
                key={request.id}
                request={request}
                showTenant={!tenant}
                canExport={canExport}
                onChanged={(text) => {
                  setNotice(text);
                  reload();
                }}
              />
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}

function NewRequest({
  tenant,
  onCreated,
}: {
  readonly tenant?: { readonly id: string; readonly name: string };
  readonly onCreated: (text: string) => void;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<PickedTenant | null>(null);
  const [kind, setKind] = useState<DataProtectionRequestKind>('access');
  const [receivedOn, setReceivedOn] = useState(today);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<{ tenant?: string; receivedOn?: string }>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One key per request recorded (M11 review): a retry on a slow connection records it once.
  const keeper = useIdempotencyKeeper();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    const tenantId = tenant?.id ?? picked?.id ?? null;
    const next = {
      tenant: tenantId ? undefined : 'Choose the tenant who asked.',
      receivedOn: receivedProblem(receivedOn, today) ?? undefined,
    };
    setErrors(next);
    if (!tenantId || next.receivedOn) return;
    setPending(true);
    try {
      const created = await sendOnce(keeper, (key) =>
        keyedApi(key).dataProtection.create({
          tenantId,
          kind,
          receivedOn,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      );
      setOpen(false);
      setNotes('');
      setPicked(null);
      onCreated(
        created.kind === 'erasure'
          ? `Recorded. Messages to ${created.tenant.name} have stopped on every channel.`
          : `Recorded the request from ${created.tenant.name}.`,
      );
    } catch (failure) {
      setProblem(
        isKeyReused(failure)
          ? 'An earlier attempt may already have recorded this request. Check the list before recording it again.'
          : problemText(failure),
      );
    } finally {
      setPending(false);
    }
  }

  if (!open)
    return (
      <div>
        <Button onClick={() => setOpen(true)}>Record a request</Button>
      </div>
    );

  return (
    <form
      aria-label="Record a data protection request"
      className="space-y-3 rounded-md border border-slate-200 p-3"
      onSubmit={(event) => void submit(event)}
    >
      {tenant ? null : (
        <TenantPicker
          value={picked}
          onChange={setPicked}
          error={errors.tenant}
          label="The tenant who asked"
        />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="What they ask"
          value={kind}
          options={DATA_PROTECTION_REQUEST_KINDS.map((k) => ({
            value: k,
            label: REQUEST_KIND_LABELS[k],
          }))}
          onChange={(event) => setKind(event.target.value as DataProtectionRequestKind)}
        />
        <TextField
          label="Received on"
          type="date"
          max={today}
          value={receivedOn}
          onChange={(event) => setReceivedOn(event.target.value)}
          error={errors.receivedOn}
        />
      </div>
      {kind === 'erasure' ? (
        <Alert tone="warning">
          Recording an erasure request stops every message to the tenant at once, on every channel.
        </Alert>
      ) : null}
      <TextAreaField
        label="Notes (optional)"
        hint="How the request came in and what it asks. No ID numbers."
        rows={2}
        maxLength={2000}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        className="[&_textarea]:font-sans"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Record the request
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {problem ? <Alert tone="error">{problem}</Alert> : null}
    </form>
  );
}

function RequestItem({
  request,
  showTenant,
  canExport,
  onChanged,
}: {
  readonly request: DataProtectionRequestView;
  readonly showTenant: boolean;
  readonly canExport: boolean;
  readonly onChanged: (text: string) => void;
}) {
  const lines = request.kind === 'erasure' ? erasureLines(request) : [];
  return (
    <li
      className="space-y-2 rounded-md border border-slate-200 p-3 text-sm"
      data-testid="data-protection-request"
    >
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-900">{REQUEST_KIND_LABELS[request.kind]}</span>
        <Badge tone={STATUS_TONES[request.status]}>{REQUEST_STATUS_LABELS[request.status]}</Badge>
        {showTenant ? (
          <Link href={`/tenants/${request.tenant.id}`} className="underline underline-offset-2">
            {request.tenant.name}
          </Link>
        ) : null}
      </p>
      <p className="text-slate-700">
        Received {formatBusinessDate(request.receivedOn)}.{' '}
        <span data-testid="data-protection-due">{dueText(request)}</span>
      </p>
      {request.notes ? <p className="text-slate-700">{request.notes}</p> : null}
      {request.outcome ? (
        <p className="text-slate-800" data-testid="data-protection-outcome">
          Outcome: {request.outcome}
        </p>
      ) : null}
      {lines.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-slate-800" data-testid="erasure-outcome">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {request.kind === 'access' && canExport && !isClosed(request.status) ? (
        <ExportControl request={request} />
      ) : null}
      {request.kind === 'erasure' && !isClosed(request.status) ? (
        <EraseControl request={request} onDone={onChanged} />
      ) : null}
      {!isClosed(request.status) ? <StatusForm request={request} onDone={onChanged} /> : null}
    </li>
  );
}

function StatusForm({
  request,
  onDone,
}: {
  readonly request: DataProtectionRequestView;
  readonly onDone: (text: string) => void;
}) {
  const options = nextStatuses(request.status);
  const [status, setStatus] = useState<DataProtectionRequestStatus>(options[0]!);
  const [outcome, setOutcome] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    if ((status === 'completed' || status === 'refused') && !outcome.trim()) {
      setProblem('Say what was done, or why the request was refused.');
      return;
    }
    setPending(true);
    try {
      const next = await api().dataProtection.update({
        requestId: request.id,
        status,
        ...(outcome.trim() ? { outcome: outcome.trim() } : {}),
      });
      onDone(`The request is now ${REQUEST_STATUS_LABELS[next.status].toLowerCase()}.`);
    } catch (failure) {
      setProblem(problemText(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      aria-label="Move the request on"
      className="grid gap-2 sm:grid-cols-[12rem_1fr_auto] sm:items-end"
      onSubmit={(event) => void submit(event)}
    >
      <SelectField
        label="Status"
        value={status}
        options={options.map((s) => ({ value: s, label: REQUEST_STATUS_LABELS[s] }))}
        onChange={(event) => setStatus(event.target.value as DataProtectionRequestStatus)}
      />
      <TextField
        label="Outcome"
        maxLength={2000}
        value={outcome}
        onChange={(event) => setOutcome(event.target.value)}
      />
      <Button type="submit" variant="secondary" pending={pending}>
        Save
      </Button>
      {problem ? (
        <Alert tone="error" className="sm:col-span-3">
          {problem}
        </Alert>
      ) : null}
    </form>
  );
}

/** Access (decision 5): the tenant's export, prepared by a job, downloaded through a short link. */
function ExportControl({ request }: { readonly request: DataProtectionRequestView }) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [leftOut, setLeftOut] = useState<string | null>(() =>
    request.export?.status === 'ready' ? leftOutText(request.export) : null,
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function run() {
    setPending(true);
    setProblem(null);
    try {
      // Asked every time (M11 review C3): the list never carries a link, and a link lasts minutes.
      // The API answers with the live export (with a fresh link once it is ready), or prepares a
      // new one when there is none: after a failure, or once a ready one is deleted.
      let exported = await api().dataProtection.exportCreate({ requestId: request.id });
      for (
        let tries = 0;
        exported.status === 'preparing' && tries < EXPORT_POLL_TRIES;
        tries += 1
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, EXPORT_POLL_MS));
        if (!mounted.current) return;
        exported = await api().dataProtection.exportGet({ exportId: exported.id });
      }
      if (!mounted.current) return;
      if (exported.status === 'ready' && exported.url) {
        setLeftOut(leftOutText(exported));
        startDownload(exported.url);
        return;
      }
      setProblem(
        exported.status === 'failed'
          ? 'The export failed. Try again.'
          : 'The export is still being prepared. Try again in a few minutes.',
      );
    } catch (failure) {
      if (!mounted.current) return;
      setProblem(
        failure instanceof Error && failure.message === 'unexpected link'
          ? 'The export link could not be opened. Try again.'
          : problemText(failure),
      );
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  return (
    <div className="space-y-1">
      <Button size="sm" variant="secondary" pending={pending} onClick={() => void run()}>
        {request.export?.status === 'ready' ? 'Download the export' : 'Prepare the export'}
      </Button>
      <p className="text-xs text-slate-600">
        An Excel workbook of the tenant’s data, with their leases, receipts, notices and messages.
        Only this tenant’s records are in it. {EXPORT_KEPT_TEXT}
      </p>
      {leftOut ? (
        <p className="text-sm text-slate-800" data-testid="export-left-out">
          {leftOut}
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/** Erasure (decision 5): anonymises what retention allows and lists what is held, and why. */
function EraseControl({
  request,
  onDone,
}: {
  readonly request: DataProtectionRequestView;
  readonly onDone: (text: string) => void;
}) {
  const keeper = useIdempotencyKeeper();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function erase() {
    setPending(true);
    setProblem(null);
    try {
      const next = await sendOnce(keeper, (key) =>
        keyedApi(key).dataProtection.erase({ requestId: request.id }),
      );
      setConfirming(false);
      onDone(
        next.held.length > 0
          ? 'Erased what retention allows; the rest is kept, as listed.'
          : 'Erased.',
      );
    } catch (failure) {
      setProblem(problemText(failure));
      if (isKeyReused(failure)) keeper.reset();
    } finally {
      setPending(false);
    }
  }

  if (!confirming)
    return (
      <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
        Erase what the law allows
      </Button>
    );
  return (
    <>
      <ConfirmBox
        label="Confirm the erasure"
        confirmText="Yes, erase"
        pending={pending}
        onConfirm={() => void erase()}
        onCancel={() => setConfirming(false)}
      >
        The tenant’s name, phone, email, ID numbers, contacts and message text are anonymised where
        their retention period has passed under a verified rule. Financial records and notices keep
        their amounts and references. Anything still held is listed with its rule. This cannot be
        undone.
      </ConfirmBox>
      {problem ? <Alert tone="error">{problem}</Alert> : null}
    </>
  );
}
