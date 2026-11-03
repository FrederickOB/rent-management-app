'use client';

import type { ApiClient } from '@rent/contracts/client';
import Link from 'next/link';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { api, keyedApi } from '@/lib/api';
import { APPROVAL_STATUS_LABELS } from '@/lib/approvals';
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
import { pastDateProblem } from '@/lib/payment-form';
import { fileAgainMessage, needsFileAgain } from '@/lib/payment-upload';
import { TAX_LIMITS } from '@/lib/tax-limits';
import { verificationLabel } from '@/lib/tax-rules';
import { TAX_FILE_UPLOAD, taxUploadOnce } from '@/lib/tax-upload';
import { formatMinor } from '@/lib/tenancy-format';
import { fileProblem, StorageUploadError } from '@/lib/upload';
import { useLoad } from '@/lib/use-load';
import {
  certificateEffect,
  certificateForm,
  certificateRejectForm,
  differsWarning,
  emptyWithholding,
  formLines,
  HELD_AS_ADVANCE,
  rateNote,
  selfDecisionState,
  treatmentText,
  suggestionFor,
  withholdingForm,
  withholdingMoves,
  withholdingWriteOffForm,
  type CertificateDraft,
  type WithholdingDraft,
} from '@/lib/withholding';
import { useApp } from './app-context';
import { FileField } from './file-field';
import { Empty, Loading, LoadFailed } from './load-state';
import { RuleList } from './rule-list';
import { RulesWarning } from './rules-warning';
import { TaxFileButton } from './tax-file-button';
import { WithholdingStatusBadge } from './tax-badges';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Card, CardBody, CardHeader } from './ui/card';
import { SelectField, TextAreaField, TextField } from './ui/field';

type WithholdingRecord = Awaited<ReturnType<ApiClient['withholding']['list']>>[number];
/** The record form's choices: the started months still owed, the rule's rate, recent payments. */
type WithholdingOptions = Awaited<ReturnType<ApiClient['withholding']['options']>>;

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
  paymentId = null,
  paymentDate = null,
  can,
}: {
  readonly leaseId: string;
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
        description="Tax a company tenant withheld from rent and pays to GRA itself. Its certificate settles the owner’s rent tax on those months once a landlord user confirms it. When the tenant pays net, record the withholding before the payment."
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
  // Decision 7 and review 4: a sole uploader's own request to confirm or withdraw it.
  const self = certificate
    ? selfDecisionState(certificate, personId, new Date())
    : ({ kind: 'none' } as const);
  // Once confirmed, what the certificate did says it; before, how it will be treated.
  const treatment = record.status === 'certified' ? null : treatmentText(record.rentTaxTreatment);
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
              {line.heldAsAdvance ? (
                <span className="text-slate-700" data-testid="withholding-held">
                  {' '}
                  · {HELD_AS_ADVANCE}
                </span>
              ) : null}
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
      {/* M5 review: what a person must act on, such as rent tax already paid to GRA. */}
      {(record.warnings ?? []).map((text) => (
        <Alert key={text} tone="warning" live={false}>
          <span data-testid="withholding-warning">{text}</span>
        </Alert>
      ))}
      {treatment ? (
        <p className="text-sm text-slate-700" data-testid="withholding-treatment">
          {treatment}
        </p>
      ) : null}
      <RulesWarning rules={[record.rule]} live={false} />
      <RuleList
        rules={[record.rule]}
        label={`The rate it is compared with: ${rateLabel(record.rateBps)}`}
      />
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
            <dd data-testid="certificate-uploaded-by">
              {certificate.uploadedBy === personId
                ? 'You'
                : (certificate.uploadedByName ?? 'Another person in your company')}
            </dd>
          </div>
          {certificate.status === 'confirmed' && certificate.decidedAt ? (
            <div>
              <dt className="text-slate-600">Confirmed by</dt>
              <dd data-testid="certificate-confirmed-by">
                {certificate.decidedBy === personId
                  ? 'You'
                  : (certificate.decidedByName ?? 'A landlord user')}
                , {formatTime(certificate.decidedAt, timeZone)}
              </dd>
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
      {self.kind === 'none' && moves.confirmBlocked ? (
        <Alert tone="info" live={false}>
          <span data-testid="confirm-blocked">{moves.confirmBlocked}</span>
        </Alert>
      ) : null}
      {/* Decision 7 (OQ-29): nobody else can decide it, so its uploader does, after the cooling-off. */}
      {self.kind === 'waiting' ? (
        <Alert tone="info" live={false}>
          <span data-testid="self-confirm-waiting">
            Nobody else in your company can decide this certificate, so you{' '}
            {self.decision === 'confirm' ? 'confirm' : 'withdraw'} it yourself
            {self.until
              ? ` after ${formatTime(self.until, timeZone)}`
              : ' once the waiting time has passed'}
            , with a code from your authenticator app. A nominated second approver removes the wait.
          </span>
        </Alert>
      ) : null}
      {self.kind === 'ready' ? (
        <SelfConfirm approvalId={self.approvalId} decision={self.decision} onDone={onChanged} />
      ) : null}
      {self.kind === 'lapsed' && certificate ? (
        <div className="space-y-2">
          <Alert tone="warning" live={false}>
            <span data-testid="self-confirm-closed">
              Your request to {self.decision === 'confirm' ? 'confirm' : 'withdraw'} it yourself was
              closed ({APPROVAL_STATUS_LABELS[self.status].toLowerCase()}). The certificate is still
              waiting to be confirmed.
            </span>
          </Alert>
          {self.mayRequest ? (
            <SelfDecisionRequest certificateId={certificate.id} onDone={onChanged} />
          ) : null}
        </div>
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

/**
 * A sole uploader confirms their own certificate after the cooling-off (decision 7, OQ-29), with
 * a code from their authenticator app, through its approval request (`self_confirm`), never the
 * certificate's own confirm, which refuses its uploader.
 */
function SelfConfirm({
  approvalId,
  decision,
  onDone,
}: {
  readonly approvalId: string;
  /** Review 4: the request may be to withdraw the certificate instead (rejected, nothing posted). */
  readonly decision: 'confirm' | 'withdraw';
  readonly onDone: (text: string) => Promise<void>;
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
      await api().approvals.decide({ id: approvalId, decision: 'self_confirm', code });
      await onDone(
        decision === 'confirm'
          ? 'Confirmed the certificate yourself, after the cooling-off.'
          : 'Withdrew the certificate. Nothing was posted; upload the right one when it comes.',
      );
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={
        decision === 'confirm'
          ? 'Confirm the certificate yourself'
          : 'Withdraw the certificate yourself'
      }
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <p className="text-sm text-slate-700">
        Nobody else in your company can decide this certificate, and the cooling-off has passed.{' '}
        {decision === 'confirm' ? 'Confirm' : 'Withdraw'} it yourself with a code from your
        authenticator app.
      </p>
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
      <Button
        type="submit"
        pending={pending}
        variant={decision === 'confirm' ? 'primary' : 'danger'}
      >
        {decision === 'confirm' ? 'Confirm it myself' : 'Withdraw it'}
      </Button>
    </form>
  );
}

/**
 * Review 4: after a sole uploader's request lapsed, they ask again to confirm the certificate or
 * to withdraw it. Either is a fresh request with its own cooling-off, decided with a code then.
 */
function SelfDecisionRequest({
  certificateId,
  onDone,
}: {
  readonly certificateId: string;
  readonly onDone: (text: string) => Promise<void>;
}) {
  const [pending, setPending] = useState<'confirm' | 'withdraw' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask(decision: 'confirm' | 'withdraw') {
    setPending(decision);
    setError(null);
    try {
      await api().withholding.requestSelfDecision({ certificateId, decision });
      await onDone(
        decision === 'confirm'
          ? 'Asked again to confirm the certificate. Confirm it yourself after the cooling-off, with a code from your authenticator app.'
          : 'Asked to withdraw the certificate. Withdraw it yourself after the cooling-off, with a code from your authenticator app.',
      );
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(null);
    }
  }

  return (
    <div className="space-y-2" role="group" aria-label="Decide the certificate yourself">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          pending={pending === 'confirm'}
          disabled={pending !== null}
          onClick={() => void ask('confirm')}
        >
          Ask again to confirm
        </Button>
        <Button
          size="sm"
          variant="danger"
          pending={pending === 'withdraw'}
          disabled={pending !== null}
          onClick={() => void ask('withdraw')}
        >
          Withdraw this certificate
        </Button>
      </div>
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
        'Uploaded the certificate. A landlord user confirms it; you cannot confirm a certificate you uploaded. Where nobody else can, you confirm it yourself after the cooling-off.',
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
  paymentId,
  paymentDate,
  keeper,
  onDone,
  onCancel,
}: {
  readonly leaseId: string;
  readonly paymentId: string | null;
  readonly paymentDate: string | null;
  readonly keeper: IdempotencyKeeper;
  readonly onDone: (text: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const [draft, setDraft] = useState<WithholdingDraft>(() =>
    emptyWithholding(paymentDate ?? today),
  );
  // The payment it was paid net with, on the lease page; a payment's own page fixes it.
  const [netWith, setNetWith] = useState('');
  // The months still owed and the rule's rate as of the day it was withheld (a valid past day).
  const asOf = pastDateProblem(draft.valueDate, today, 'it was withheld') ? today : draft.valueDate;
  const load = useCallback(
    () => api().withholding.options({ leaseId, valueDate: asOf }),
    [leaseId, asOf],
  );
  const { state, reload } = useLoad(load);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const options: WithholdingOptions | null = state.status === 'ready' ? state.data : null;
  // Decision 8: months not started yet are offered too; their withholding is held until they start.
  const lines = options ? formLines(options) : [];
  const started = lines.filter((line) => line.started !== false);
  const ahead = lines.filter((line) => line.started === false);
  const rateBps = options?.rate.bps ?? null;
  const parsed = withholdingForm(draft, lines, rateBps, today);
  const errors = tried ? parsed.errors : {};
  const differs = new Set(parsed.differsFromRate);
  const warning = rateBps === null ? null : differsWarning(parsed.differsFromRate, lines, rateBps);
  const chosenPayment = paymentId ?? (netWith || null);
  useHoldWhileSending(pending);

  function lineInput(line: (typeof lines)[number]) {
    return (
      <li key={line.id} data-testid="withholding-line" className="space-y-1">
        <div className="flex flex-wrap items-end gap-2">
          <TextField
            label={`${line.invoiceNumber} ${line.label} (still owed ${formatMinor(line.outstandingMinor)})`}
            inputMode="decimal"
            autoComplete="off"
            value={draft.amounts[line.id] ?? ''}
            error={errors[`line:${line.id}`]}
            onChange={(event) =>
              setDraft((d) => ({ ...d, amounts: { ...d.amounts, [line.id]: event.target.value } }))
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
                  amounts: { ...d.amounts, [line.id]: suggestionFor(line, rateBps) },
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
    );
  }

  function chooseNetWith(id: string) {
    setNetWith(id);
    const payment = options?.payments.find((p) => p.paymentId === id);
    if (payment) setDraft((d) => ({ ...d, valueDate: payment.receivedOn }));
  }

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
        keyedApi(key).withholding.record({ leaseId, paymentId: chosenPayment, ...input }),
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
    setNetWith('');
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
        Enter what the tenant withheld on each month. The rule’s rate is offered; the tenant’s
        advice or certificate decides. When the tenant pays net, record the withholding before the
        payment, so the payment pays everything else.
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {state.status === 'loading' ? <Loading what="the months owed" /> : null}
      {state.status === 'error' ? (
        <LoadFailed message={state.problem.message} onRetry={reload} />
      ) : null}
      {options ? (
        <p className="text-sm text-slate-700" data-testid="withholding-rate">
          Rate for this lease: {rateLabel(options.rate.bps)} ({options.rate.key},{' '}
          {verificationLabel(options.rate).toLowerCase()})
        </p>
      ) : null}
      {options ? <RulesWarning rules={[options.rate]} live={false} /> : null}
      {options && lines.length === 0 ? (
        <Empty>
          No month is still owed on the lease, so there is nothing to record withholding on.
        </Empty>
      ) : null}
      {started.length ? (
        <ul className="space-y-3" aria-label="Months withheld on">
          {started.map(lineInput)}
        </ul>
      ) : null}
      {ahead.length ? (
        <div className="space-y-2" data-testid="withholding-ahead">
          <p className="text-sm font-medium text-slate-900">Months not started yet</p>
          <p className="text-sm text-slate-700">
            Withholding on these is {HELD_AS_ADVANCE}, as an advance on its rent, and settles it
            then.
          </p>
          <ul className="space-y-3" aria-label="Months not started yet, withheld on">
            {ahead.map(lineInput)}
          </ul>
        </div>
      ) : null}
      {errors.lines ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {errors.lines}
        </p>
      ) : null}
      {!paymentId && options?.payments.length ? (
        <SelectField
          label="Paid net with (optional)"
          hint="The payment the tenant made after withholding, if it is already recorded."
          value={netWith}
          options={[
            { value: '', label: 'No payment: advised separately' },
            ...options.payments.map((p) => ({
              value: p.paymentId,
              label: `${formatBusinessDate(p.receivedOn)}, ${formatMinor(p.amountMinor)}${p.receiptNumber ? `, ${p.receiptNumber}` : ''}`,
            })),
          ]}
          onChange={(event) => chooseNetWith(event.target.value)}
        />
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
      {warning ? (
        <Alert tone="warning" live={false}>
          <span data-testid="withholding-differs">{warning}</span>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending} disabled={!lines.length}>
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
