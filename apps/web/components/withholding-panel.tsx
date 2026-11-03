'use client';

import type { ApiClient } from '@rent/contracts/client';
import Link from 'next/link';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { api, keyedApi } from '@/lib/api';
import { periodLabel, rateLabel } from '@/lib/billing-format';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  isKeyReused,
  moneyProblem,
  sendOnce,
  useIdempotencyKeeper,
  useKeepers,
  type IdempotencyKeeper,
} from '@/lib/idempotency';
import { useHoldWhileSending } from '@/lib/in-flight';
import { waitingNote } from '@/lib/money-requests';
import { fileAgainMessage, needsFileAgain } from '@/lib/payment-upload';
import { TAX_LIMITS } from '@/lib/tax-limits';
import { TAX_FILE_UPLOAD, taxUploadOnce } from '@/lib/tax-upload';
import { formatMinor } from '@/lib/tenancy-format';
import { fileProblem, StorageUploadError } from '@/lib/upload';
import { useLoad } from '@/lib/use-load';
import {
  certificateEffect,
  certificateForm,
  certificateRejectForm,
  emptyWithholding,
  rateNote,
  suggestedInput,
  withholdableLines,
  withholdingForm,
  withholdingMoves,
  withholdingRate,
  withholdingWriteOffForm,
  type CertificateDraft,
  type WithholdableLine,
  type WithholdingDraft,
} from '@/lib/withholding';
import { useApp } from './app-context';
import { FileField } from './file-field';
import { Empty, Loading, LoadFailed } from './load-state';
import { RulesWarning } from './rules-warning';
import { TaxFileButton } from './tax-file-button';
import { WithholdingStatusBadge } from './tax-badges';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Card, CardBody, CardHeader } from './ui/card';
import { TextAreaField, TextField } from './ui/field';

type WithholdingRecord = Awaited<ReturnType<ApiClient['withholding']['list']>>[number];

/** The record form's choices: the lines still owed, and the rate for the lease's use. */
interface WithholdingOptions {
  readonly lines: readonly WithholdableLine[];
  readonly rate: ReturnType<typeof withholdingRate>;
}

export interface WithholdingPermissions {
  /** billing.manage: record withholding, upload a certificate, ask for a write-off (P24). */
  readonly manage: boolean;
  /** withholding.confirm: a user for the owner, or an agency admin (decision 3). */
  readonly confirm: boolean;
  readonly seeApprovals: boolean;
}

/**
 * Withholding tax by a corporate tenant (TX-04; P19, P20, P24), on a payment or a lease: what was
 * withheld on which lines, the certificate and who confirmed it. A manager records it and uploads
 * the certificate; a landlord user confirms it, never the uploader (decision 3).
 */
export function WithholdingPanel({
  leaseId,
  leaseUse,
  paymentId = null,
  paymentDate = null,
  can,
}: {
  readonly leaseId: string;
  /** The withholding rate is the rule for the lease's use (`withholding_tax.rate.*`). */
  readonly leaseUse: 'residential' | 'commercial';
  /** On a payment's page: the withholding recorded with it, and new withholding is pinned to it. */
  readonly paymentId?: string | null;
  readonly paymentDate?: string | null;
  readonly can: WithholdingPermissions;
}) {
  const { me } = useApp();
  const load = useCallback(
    () => api().withholding.list(paymentId ? { paymentId } : { leaseId }),
    [leaseId, paymentId],
  );
  const { state, reload } = useLoad(load);
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const keepers = useKeepers();
  const recordKeeper = useIdempotencyKeeper();

  async function changed(text: string) {
    setNotice(text);
    reload();
  }

  return (
    <Card data-testid="withholding">
      <CardHeader
        title="Withholding tax"
        description="Tax a company tenant withheld from rent and pays to GRA itself. Its certificate settles the owner’s rent tax on those lines once a landlord user confirms it."
        actions={
          can.manage && !recording ? (
            <Button variant="secondary" onClick={() => setRecording(true)}>
              Record withholding
            </Button>
          ) : null
        }
      />
      <CardBody>
        {notice ? (
          <Alert tone="success">
            {notice}{' '}
            {can.seeApprovals && notice.includes('approve') ? (
              <Link href="/approvals" className="font-medium underline underline-offset-2">
                Open Approvals
              </Link>
            ) : null}
          </Alert>
        ) : null}
        {recording ? (
          <RecordForm
            leaseId={leaseId}
            leaseUse={leaseUse}
            paymentId={paymentId}
            paymentDate={paymentDate}
            keeper={recordKeeper}
            onDone={async (text) => {
              setRecording(false);
              await changed(text);
            }}
            onCancel={() => setRecording(false)}
          />
        ) : null}
        {state.status === 'loading' ? <Loading what="withholding" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' && state.data.length === 0 ? (
          <Empty>
            {paymentId ? 'No tax was withheld from this payment.' : 'No tax has been withheld.'}
          </Empty>
        ) : null}
        {state.status === 'ready' && state.data.length ? (
          <ul className="space-y-4">
            {state.data.map((record) => (
              <li key={record.id}>
                <WithholdingItem
                  record={record}
                  personId={me.personId}
                  can={can}
                  keeper={keepers(`write-off:${record.id}`)}
                  onChanged={changed}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}

function WithholdingItem({
  record,
  personId,
  can,
  keeper,
  onChanged,
}: {
  readonly record: WithholdingRecord;
  readonly personId: string;
  readonly can: WithholdingPermissions;
  readonly keeper: IdempotencyKeeper;
  readonly onChanged: (text: string) => Promise<void>;
}) {
  const { timeZone } = useApp();
  const moves = withholdingMoves(
    {
      status: record.status,
      certificateUploadedBy: record.certificate?.uploadedBy ?? null,
      mayConfirm: record.certificate?.mayDecide ?? false,
      openWriteOffApprovalId: record.openWriteOffApprovalId,
    },
    personId,
    { upload: can.manage, confirm: can.confirm, writeOff: can.manage },
  );
  const [open, setOpen] = useState<'upload' | 'reject' | 'write_off' | null>(null);
  const certificate = record.certificate;
  const effect =
    record.status === 'certified' ? certificateEffect(certificate?.debitAccount ?? null) : null;
  return (
    <div
      data-testid="withholding-record"
      data-withholding-id={record.id}
      className="space-y-3 rounded-md border border-slate-200 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm">
          <span className="font-semibold">{formatMinor(record.amountMinor)}</span> withheld,{' '}
          {formatBusinessDate(record.valueDate)}
        </p>
        <WithholdingStatusBadge status={record.status} />
      </div>
      <ul className="space-y-0.5 text-sm text-slate-700" aria-label="Withheld on">
        {record.lines.map((line) => (
          <li key={line.lineId} className="flex flex-wrap justify-between gap-2">
            <span>
              <span className="font-mono">{line.invoiceNumber}</span>
              {periodLabel(line.periodStart, line.periodEnd)
                ? `, ${periodLabel(line.periodStart, line.periodEnd)}`
                : ''}{' '}
              <span className="text-slate-600">(line of {formatMinor(line.lineAmountMinor)})</span>
            </span>
            <span className="tabular-nums">{formatMinor(line.withheldMinor)}</span>
          </li>
        ))}
      </ul>
      {record.differsFromRate ? (
        <Alert tone="warning" live={false}>
          The amount is not {rateLabel(record.rateBps)} of the lines it was withheld on. Check it
          against the tenant’s advice or certificate.
        </Alert>
      ) : null}
      <RulesWarning rules={[record.rule]} live={false} />
      {record.note ? <p className="text-sm text-slate-700">Note: {record.note}</p> : null}

      {certificate ? (
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2" data-testid="certificate">
          <div>
            <dt className="text-slate-600">Certificate</dt>
            <dd>
              {certificate.certificateNumber ?? 'No number given'}
              {certificate.issuedOn ? `, issued ${formatBusinessDate(certificate.issuedOn)}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-slate-600">Uploaded by</dt>
            <dd>
              {certificate.uploadedBy === personId ? 'You' : 'Another person in your company'}
            </dd>
          </div>
          {certificate.status === 'confirmed' && certificate.decidedAt ? (
            <div>
              <dt className="text-slate-600">Confirmed</dt>
              <dd>{formatTime(certificate.decidedAt, timeZone)}</dd>
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <TaxFileButton documentId={certificate.documentId} label="Open the certificate" />
          </div>
        </dl>
      ) : null}
      {effect ? <p className="text-sm text-slate-700">{effect}</p> : null}
      {record.rejectedCertificates > 0 ? (
        <p className="text-sm text-slate-700">
          {record.rejectedCertificates} certificate
          {record.rejectedCertificates === 1 ? ' was' : 's were'} rejected before.
        </p>
      ) : null}
      {record.writeOff ? (
        <p className="text-sm text-slate-700">
          Written off {formatBusinessDate(record.writeOff.valueDate)}: {record.writeOff.reason}
        </p>
      ) : null}
      {record.openWriteOffApprovalId ? (
        <Alert tone="info" live={false}>
          A write-off of this withholding is waiting for a second person to approve it.
        </Alert>
      ) : null}
      {moves.confirmBlocked ? (
        <Alert tone="info" live={false}>
          <span data-testid="confirm-blocked">{moves.confirmBlocked}</span>
        </Alert>
      ) : null}

      {open === 'upload' ? (
        <CertificateUpload
          record={record}
          onDone={async (text) => {
            setOpen(null);
            await onChanged(text);
          }}
          onCancel={() => setOpen(null)}
        />
      ) : null}
      {open === 'reject' ? (
        <ReasonForm
          label={`Reject the certificate for ${formatMinor(record.amountMinor)}`}
          field="Why it is rejected"
          hint="The person who uploaded it reads this before uploading the right one."
          submit="Reject the certificate"
          parse={certificateRejectForm}
          send={(reason) =>
            api()
              .withholding.rejectCertificate({ certificateId: certificate!.id, reason })
              .then(() => 'Rejected the certificate. The withholding waits for another one.')
          }
          onDone={async (text) => {
            setOpen(null);
            await onChanged(text);
          }}
          onCancel={() => setOpen(null)}
        />
      ) : null}
      {open === 'write_off' ? (
        <ReasonForm
          label={`Ask to write off ${formatMinor(record.amountMinor)} of withholding`}
          field="Why the certificate will not come"
          hint="At least 5 characters. A second person reads it before deciding."
          submit="Ask for the write-off"
          parse={withholdingWriteOffForm}
          send={(reason) =>
            sendOnce(keeper, (key) =>
              keyedApi(key).withholding.requestWriteOff({ withholdingId: record.id, reason }),
            ).then(
              ({ approval }) =>
                `Asked to write off ${formatMinor(record.amountMinor)} of withholding. ${waitingNote(approval, timeZone)}`,
            )
          }
          money
          onDone={async (text) => {
            setOpen(null);
            await onChanged(text);
          }}
          onCancel={() => setOpen(null)}
        />
      ) : null}
      {open === null ? (
        <div className="flex flex-wrap gap-2">
          {moves.upload ? (
            <Button size="sm" variant="secondary" onClick={() => setOpen('upload')}>
              Upload the certificate
            </Button>
          ) : null}
          {moves.confirm ? (
            <ConfirmButton record={record} onDone={onChanged} onReject={() => setOpen('reject')} />
          ) : null}
          {moves.writeOff ? (
            <Button size="sm" variant="ghost" onClick={() => setOpen('write_off')}>
              Ask to write it off
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Confirm the certificate (P20), or open the rejection: the API refuses the uploader again. */
function ConfirmButton({
  record,
  onDone,
  onReject,
}: {
  readonly record: WithholdingRecord;
  readonly onDone: (text: string) => Promise<void>;
  readonly onReject: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await api().withholding.confirmCertificate({ certificateId: record.certificate!.id });
      await onDone(`Confirmed the certificate for ${formatMinor(record.amountMinor)}.`);
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }
  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <Button size="sm" pending={pending} onClick={() => void confirm()}>
        Confirm the certificate
      </Button>
      <Button size="sm" variant="danger" disabled={pending} onClick={onReject}>
        Reject it
      </Button>
      {error ? (
        <p role="alert" className="w-full text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A reason someone else reads: a certificate rejected, or a write-off asked for (P24). */
function ReasonForm({
  label,
  field,
  hint,
  submit,
  parse,
  send,
  money = false,
  onDone,
  onCancel,
}: {
  readonly label: string;
  readonly field: string;
  readonly hint: string;
  readonly submit: string;
  readonly parse: typeof withholdingWriteOffForm;
  readonly send: (reason: string) => Promise<string>;
  /** A money request: its answer may be lost, so the problem says whether to send it again. */
  readonly money?: boolean;
  readonly onDone: (text: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parse(reason);
  useHoldWhileSending(pending && money);

  async function go(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (!parsed.input) return;
    setPending(true);
    try {
      await onDone(await send(parsed.input.reason));
    } catch (failure) {
      setError(money ? moneyProblem(failure) : toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={go}
      noValidate
      aria-label={label}
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <TextAreaField
        label={field}
        hint={hint}
        rows={2}
        maxLength={500}
        value={reason}
        error={tried ? parsed.errors.reason : null}
        onChange={(event) => setReason(event.target.value)}
        className="[&_textarea]:font-sans"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" pending={pending}>
          {submit}
        </Button>
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The certificate's upload (P20): the file, with its number and date when they are known. */
function CertificateUpload({
  record,
  onDone,
  onCancel,
}: {
  readonly record: WithholdingRecord;
  readonly onDone: (text: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const [uploads] = useState(() => taxUploadOnce());
  const file = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<CertificateDraft>({ certificateNumber: '', issuedOn: '' });
  const [tried, setTried] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const parsed = certificateForm(draft, today);
  const errors = tried ? parsed.errors : {};
  const working = status !== null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    const chosen = file.current?.files?.[0];
    const issue = chosen ? fileProblem(chosen, TAX_FILE_UPLOAD) : 'Attach the certificate.';
    setFileError(issue);
    if (!parsed.input || issue || !chosen) return;
    try {
      setStatus('Uploading the certificate…');
      const uploadId = await uploads.idFor(chosen, 'withholding_certificate');
      setStatus('Saving…');
      await api().withholding.uploadCertificate({
        withholdingId: record.id,
        uploadId,
        ...parsed.input,
      });
      setStatus(null);
      await onDone(
        'Uploaded the certificate. A landlord user confirms it; you cannot confirm a certificate you uploaded.',
      );
    } catch (failure) {
      setStatus(null);
      if (failure instanceof StorageUploadError) {
        setError(failure.message);
        return;
      }
      if (needsFileAgain(failure)) {
        uploads.forget(chosen);
        if (file.current) file.current.value = '';
        setFileError(fileAgainMessage('certificate'));
        return;
      }
      setError(toProblem(failure).message);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Upload the withholding tax certificate"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Certificate number (optional)"
          autoComplete="off"
          maxLength={TAX_LIMITS.certificateNumberMax}
          value={draft.certificateNumber}
          error={errors.certificateNumber}
          onChange={(event) => setDraft((d) => ({ ...d, certificateNumber: event.target.value }))}
        />
        <TextField
          label="Date issued (optional)"
          type="date"
          max={today}
          value={draft.issuedOn}
          error={errors.issuedOn}
          onChange={(event) => setDraft((d) => ({ ...d, issuedOn: event.target.value }))}
        />
      </div>
      <FileField
        ref={file}
        label="The certificate"
        rule={TAX_FILE_UPLOAD}
        disabled={working}
        error={fileError}
        note="The withholding tax credit certificate the tenant got from GRA."
      />
      {status ? <Alert tone="info">{status}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={working}>
          Upload the certificate
        </Button>
        <Button variant="ghost" disabled={working} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Withholding recorded on the lines it was withheld on (P19): with the payment the tenant paid
 * net, or later when the tenant advises it. The rate's amount is a suggestion; an amount that
 * differs is recorded with a note to check it.
 */
function RecordForm({
  leaseId,
  leaseUse,
  paymentId,
  paymentDate,
  keeper,
  onDone,
  onCancel,
}: {
  readonly leaseId: string;
  readonly leaseUse: 'residential' | 'commercial';
  readonly paymentId: string | null;
  readonly paymentDate: string | null;
  readonly keeper: IdempotencyKeeper;
  readonly onDone: (text: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  // The lines still owed, from the lease's open invoices, and the rate in force today. The rules
  // table is for platform admins (`rules.view`), so without it the form offers no suggestion; the
  // API still compares the amount with the rate when it records it.
  const load = useCallback(async (): Promise<WithholdingOptions> => {
    const [invoices, rules] = await Promise.all([
      api().invoices.list({ leaseId, limit: 500 }),
      api()
        .rules.list({ asOf: today })
        .catch(() => []),
    ]);
    const open = invoices
      .filter((invoice) => invoice.outstandingMinor > 0)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number));
    const details = await Promise.all(
      open.map((invoice) => api().invoices.get({ invoiceId: invoice.id })),
    );
    return { lines: withholdableLines(details), rate: withholdingRate(rules, leaseUse) };
  }, [leaseId, leaseUse, today]);
  const { state, reload } = useLoad(load);
  const [draft, setDraft] = useState<WithholdingDraft>(() =>
    emptyWithholding(paymentDate ?? today),
  );
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const options: WithholdingOptions | null = state.status === 'ready' ? state.data : null;
  const rateBps = options?.rate?.rateBps ?? null;
  const parsed = withholdingForm(draft, options?.lines ?? [], rateBps, today);
  const errors = tried ? parsed.errors : {};
  const differs = new Set(parsed.differsFromRate);
  useHoldWhileSending(pending);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    setReused(false);
    const input = parsed.input;
    if (!input) return;
    setPending(true);
    try {
      await sendOnce(keeper, (key) =>
        keyedApi(key).withholding.record({ leaseId, paymentId, ...input }),
      );
      await onDone(
        `Recorded ${formatMinor(parsed.totalMinor)} withheld by the tenant. The rent tax on those lines is now the tenant’s to pay GRA; upload the certificate when it comes.`,
      );
    } catch (failure) {
      setError(moneyProblem(failure));
      setReused(isKeyReused(failure));
      setPending(false);
    }
  }

  function startAgain() {
    keeper.reset();
    setDraft(emptyWithholding(paymentDate ?? today));
    setTried(false);
    setError(null);
    setReused(false);
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Record withholding"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <p className="text-sm text-slate-700">
        Enter what the tenant withheld on each line. The rate’s amount is offered; the tenant’s
        advice or certificate decides.
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {state.status === 'loading' ? <Loading what="the lines" /> : null}
      {state.status === 'error' ? (
        <LoadFailed message={state.problem.message} onRetry={reload} />
      ) : null}
      {options ? (
        <RulesWarning rules={options.rate ? [options.rate.rule] : []} live={false} />
      ) : null}
      {options && options.lines.length === 0 ? (
        <Empty>Nothing is owed on the lease, so there is no line to record withholding on.</Empty>
      ) : null}
      {options?.lines.length ? (
        <ul className="space-y-3" aria-label="Lines withheld on">
          {options.lines.map((line) => (
            <li key={line.id} data-testid="withholding-line" className="space-y-1">
              <div className="flex flex-wrap items-end gap-2">
                <TextField
                  label={`${line.invoiceNumber} ${line.label} (still owed ${formatMinor(line.outstandingMinor)})`}
                  inputMode="decimal"
                  autoComplete="off"
                  value={draft.amounts[line.id] ?? ''}
                  error={errors[`line:${line.id}`]}
                  onChange={(event) =>
                    setDraft((d) => ({
                      ...d,
                      amounts: { ...d.amounts, [line.id]: event.target.value },
                    }))
                  }
                  className="min-w-64 flex-1"
                />
                {rateBps !== null ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        amounts: { ...d.amounts, [line.id]: suggestedInput(line, rateBps) },
                      }))
                    }
                  >
                    Use {rateLabel(rateBps)}
                  </Button>
                ) : null}
              </div>
              {differs.has(line.id) && rateBps !== null ? (
                <p className="text-sm text-amber-900">{rateNote(line, rateBps)}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {errors.lines ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {errors.lines}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Date withheld"
          type="date"
          max={today}
          hint="The day of the payment it was withheld from, or the date of the tenant’s advice."
          value={draft.valueDate}
          error={errors.valueDate}
          onChange={(event) => setDraft((d) => ({ ...d, valueDate: event.target.value }))}
        />
        <TextAreaField
          label="Note (optional)"
          rows={2}
          maxLength={500}
          value={draft.note}
          error={errors.note}
          onChange={(event) => setDraft((d) => ({ ...d, note: event.target.value }))}
          className="[&_textarea]:font-sans"
        />
      </div>
      {parsed.totalMinor > 0 ? (
        <p className="text-sm font-medium">Total withheld: {formatMinor(parsed.totalMinor)}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending} disabled={!options?.lines.length}>
          Record the withholding
        </Button>
        {reused ? (
          <Button variant="secondary" onClick={startAgain}>
            Start again
          </Button>
        ) : null}
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
