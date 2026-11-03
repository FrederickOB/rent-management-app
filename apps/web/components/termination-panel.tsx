'use client';

import { RECEIVING_ACCOUNTS } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import Link from 'next/link';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { api, keyedApi } from '@/lib/api';
import { RECEIVING_ACCOUNT_LABELS, type ReceivingAccount } from '@/lib/billing-format';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { creditNoteWithheld } from '@/lib/credit-withheld';
import { toProblem } from '@/lib/errors';
import {
  isKeyReused,
  moneyProblem,
  sendOnce,
  useIdempotencyKeeper,
  type IdempotencyKeeper,
} from '@/lib/idempotency';
import { useHoldWhileSending } from '@/lib/in-flight';
import { waitingNote } from '@/lib/money-requests';
import { fileAgainMessage, needsFileAgain } from '@/lib/payment-upload';
import { TAX_LIMITS } from '@/lib/tax-limits';
import { TAX_FILE_UPLOAD, taxUploadOnce } from '@/lib/tax-upload';
import { formatMinor } from '@/lib/tenancy-format';
import {
  emptyRefundPaid,
  emptyRow,
  emptyTermination,
  mayRequestAgain,
  previewInput,
  refundPaidForm,
  TERMINATION_TAX_NOTE,
  terminationForm,
  terminationNext,
  type AmountLine,
  type AmountRow,
  type RefundPaidDraft,
  type TerminationDraft,
  type TerminationFigures,
} from '@/lib/termination';
import { fileProblem, StorageUploadError } from '@/lib/upload';
import { useLoad } from '@/lib/use-load';
import { useApp } from './app-context';
import { FileField } from './file-field';
import { Loading, LoadFailed } from './load-state';
import { TaxFileButton } from './tax-file-button';
import { TerminationStatusBadge } from './tax-badges';
import { TerminationSteps } from './termination-steps';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Card, CardBody, CardHeader } from './ui/card';
import { SelectField, TextAreaField, TextField } from './ui/field';

type EarlyTermination = Awaited<ReturnType<ApiClient['earlyTermination']['list']>>[number];

export interface TerminationPermissions {
  /** billing.manage: ask for the settlement and refund, and record the refund as paid. */
  readonly manage: boolean;
  readonly seeApprovals: boolean;
}

/**
 * Early termination (AR-04, P13; plan 5.4 and decision 6), once a move-out has ended the lease
 * before its end date: the calculation step by step, then "Request the refund", which a second
 * person approves, then the refund recorded as paid with its reference and proof (D1: it is paid
 * outside the platform). Every figure is the API's, worked out from the ledger.
 */
export function TerminationPanel({
  leaseId,
  agency,
  can,
}: {
  readonly leaseId: string;
  readonly agency: boolean;
  readonly can: TerminationPermissions;
}) {
  const load = useCallback(async () => {
    // The newest request first, as the API orders them.
    const [latest] = await api().earlyTermination.list({ leaseId });
    // The settlement with nothing agreed yet: where the form starts, or all a reader sees. Decision
    // 9: one that would credit back tax the tenant withheld is refused, in the API's own words.
    const preview = mayRequestAgain(latest?.status ?? null)
      ? await api()
          .earlyTermination.preview({ leaseId, charges: [], deductions: [] })
          .then(
            (figures) => ({ figures, refused: null }),
            (failure: unknown) => {
              const refused = creditNoteWithheld(failure);
              if (refused === null) throw failure;
              return { figures: null, refused };
            },
          )
      : { figures: null, refused: null };
    return { current: latest ?? null, ...preview };
  }, [leaseId]);
  const { state, reload } = useLoad(load);
  const [notice, setNotice] = useState<string | null>(null);
  const requestKeeper = useIdempotencyKeeper();
  const paidKeeper = useIdempotencyKeeper();

  async function changed(text: string) {
    setNotice(text);
    reload();
  }

  const current = state.status === 'ready' ? state.data.current : null;
  return (
    <Card data-testid="early-termination">
      <CardHeader
        title="Early termination"
        description="The lease ended before its end date. What the tenant paid ahead settles what is still owed; anything left, less agreed deductions, is refunded."
        actions={current ? <TerminationStatusBadge status={current.status} /> : null}
      />
      <CardBody>
        {notice ? (
          <Alert tone="success">
            {notice}{' '}
            {can.seeApprovals && current?.status === 'awaiting_approval' ? (
              <Link href="/approvals" className="font-medium underline underline-offset-2">
                Open Approvals
              </Link>
            ) : null}
          </Alert>
        ) : null}
        {state.status === 'loading' ? <Loading what="the calculation" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {current ? (
          <CurrentRequest
            termination={current}
            agency={agency}
            can={can}
            keeper={paidKeeper}
            onChanged={changed}
          />
        ) : null}
        {state.status === 'ready' && state.data.refused ? (
          <Alert tone="warning">
            <span data-testid="termination-refused">{state.data.refused}</span>
          </Alert>
        ) : null}
        {state.status === 'ready' && state.data.figures ? (
          can.manage ? (
            <RequestForm
              leaseId={leaseId}
              initial={state.data.figures}
              keeper={requestKeeper}
              onDone={changed}
            />
          ) : (
            <TerminationSteps figures={state.data.figures} charges={[]} deductions={[]} />
          )
        ) : null}
        <p className="text-xs text-slate-600">{TERMINATION_TAX_NOTE}</p>
      </CardBody>
    </Card>
  );
}

/** A request already made: its figures as asked, where it stands, and what is left to do. */
function CurrentRequest({
  termination,
  agency,
  can,
  keeper,
  onChanged,
}: {
  readonly termination: EarlyTermination;
  readonly agency: boolean;
  readonly can: TerminationPermissions;
  readonly keeper: IdempotencyKeeper;
  readonly onChanged: (text: string) => Promise<void>;
}) {
  const next = terminationNext(termination.status, termination.refundMinor);
  return (
    <div className="space-y-3" data-testid="termination-request">
      {/* Every step as the request showed it, the figures the second person decides on. */}
      <div data-testid="termination-figures">
        <TerminationSteps
          figures={termination}
          charges={termination.charges}
          deductions={termination.deductions}
        />
      </div>
      {termination.note ? <p className="text-sm text-slate-700">Note: {termination.note}</p> : null}
      {next ? (
        <Alert tone={termination.status === 'rejected' ? 'warning' : 'info'} live={false}>
          {next}
        </Alert>
      ) : null}
      {termination.paid ? (
        <div className="space-y-2 text-sm" data-testid="refund-paid">
          <p>
            Paid {formatBusinessDate(termination.paid.paidOn)} from{' '}
            {RECEIVING_ACCOUNT_LABELS[termination.paid.paidFrom].toLowerCase()}, reference{' '}
            <span className="font-mono">{termination.paid.reference}</span>.
          </p>
          <TaxFileButton documentId={termination.paid.proofDocumentId} label="Open the proof" />
        </div>
      ) : null}
      {termination.status === 'settled' && termination.refundMinor > 0 && can.manage ? (
        <RefundPaidForm
          termination={termination}
          agency={agency}
          keeper={keeper}
          onDone={onChanged}
        />
      ) : null}
    </div>
  );
}

/** Rows of what-for and how-much, with a row to add another. */
function AmountRows({
  legend,
  rows,
  errors,
  kind,
  disabled,
  onChange,
}: {
  readonly legend: string;
  readonly rows: readonly AmountRow[];
  readonly errors: Partial<Record<string, string>>;
  readonly kind: 'charges' | 'deductions';
  readonly disabled: boolean;
  readonly onChange: (rows: readonly AmountRow[]) => void;
}) {
  const noun = kind === 'charges' ? 'charge' : 'deduction';
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-slate-900">{legend}</legend>
      {rows.map((row, index) => (
        <div
          key={index}
          className="grid gap-2 sm:grid-cols-[1fr_12rem]"
          data-testid={`${kind}-row`}
        >
          <TextField
            label={`What the ${noun} is for`}
            value={row.description}
            maxLength={TAX_LIMITS.descriptionMax}
            disabled={disabled}
            error={errors[`${kind}.${index}.description`]}
            onChange={(event) =>
              onChange(
                rows.map((r, i) => (i === index ? { ...r, description: event.target.value } : r)),
              )
            }
          />
          <TextField
            label="Amount (GH₵)"
            inputMode="decimal"
            autoComplete="off"
            value={row.amount}
            disabled={disabled}
            error={errors[`${kind}.${index}.amount`]}
            onChange={(event) =>
              onChange(rows.map((r, i) => (i === index ? { ...r, amount: event.target.value } : r)))
            }
          />
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => onChange([...rows, emptyRow])}
      >
        Add another {noun}
      </Button>
    </fieldset>
  );
}

/**
 * The request (P13): agreed charges and deductions change the settlement, so the API works the
 * figures out again for them before anything is asked for, and again when the request is made.
 */
function RequestForm({
  leaseId,
  initial,
  keeper,
  onDone,
}: {
  readonly leaseId: string;
  readonly initial: TerminationFigures;
  readonly keeper: IdempotencyKeeper;
  readonly onDone: (text: string) => Promise<void>;
}) {
  const { timeZone } = useApp();
  const [draft, setDraft] = useState<TerminationDraft>(emptyTermination);
  const [figures, setFigures] = useState<TerminationFigures>(initial);
  // The charges and deductions the figures shown were worked out with.
  const [previewed, setPreviewed] = useState(JSON.stringify({ charges: [], deductions: [] }));
  const [previewing, setPreviewing] = useState(false);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const asked = previewInput(draft);
  const stale = JSON.stringify(asked) !== previewed;
  const shown: { charges: readonly AmountLine[]; deductions: readonly AmountLine[] } =
    JSON.parse(previewed);
  const parsed = terminationForm(draft, stale ? null : figures.creditLeftMinor);
  const errors = tried ? parsed.errors : {};
  useHoldWhileSending(pending);

  async function preview() {
    setPreviewing(true);
    setError(null);
    try {
      setFigures(await api().earlyTermination.preview({ leaseId, ...asked }));
      setPreviewed(JSON.stringify(asked));
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPreviewing(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    setReused(false);
    const input = parsed.input;
    if (!input) return;
    if (stale) {
      setError('Work the figures out again with these charges and deductions before asking.');
      return;
    }
    setPending(true);
    try {
      const { approval } = await sendOnce(keeper, (key) =>
        keyedApi(key).earlyTermination.request({ leaseId, ...input }),
      );
      setPending(false);
      await onDone(
        `Asked to settle the early termination and refund ${formatMinor(figures.refundMinor)}. ${waitingNote(approval, timeZone)}`,
      );
    } catch (failure) {
      setError(moneyProblem(failure));
      setReused(isKeyReused(failure));
      setPending(false);
    }
  }

  function startAgain() {
    keeper.reset();
    setDraft(emptyTermination);
    setFigures(initial);
    setPreviewed(JSON.stringify({ charges: [], deductions: [] }));
    setTried(false);
    setError(null);
    setReused(false);
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Request the refund" className="space-y-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <AmountRows
        legend="Agreed termination charges"
        rows={draft.charges}
        errors={errors}
        kind="charges"
        disabled={pending}
        onChange={(rows) => setDraft((d) => ({ ...d, charges: rows }))}
      />
      <AmountRows
        legend="Deductions agreed with the tenant"
        rows={draft.deductions}
        errors={errors}
        kind="deductions"
        disabled={pending}
        onChange={(rows) => setDraft((d) => ({ ...d, deductions: rows }))}
      />
      {errors.deductions ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {errors.deductions}
        </p>
      ) : null}
      {stale ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" pending={previewing} onClick={() => void preview()}>
            Work it out with these
          </Button>
          <p className="text-sm text-slate-600">
            The figures below do not include the charges and deductions as now typed.
          </p>
        </div>
      ) : null}
      <TerminationSteps figures={figures} charges={shown.charges} deductions={shown.deductions} />
      <TextAreaField
        label="Note (optional)"
        rows={2}
        maxLength={500}
        value={draft.note}
        error={errors.note}
        onChange={(event) => setDraft((d) => ({ ...d, note: event.target.value }))}
        className="[&_textarea]:font-sans"
      />
      <p className="text-sm text-slate-700">
        A second person approves it. On approval the charges and deductions are raised, the
        prepayment pays the open charges, and the refund is owed to the tenant until it is paid.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Request the refund
        </Button>
        {reused ? (
          <Button variant="secondary" onClick={startAgain}>
            Start again
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** The refund recorded as paid (P13 pay): the date, the account, the reference and the proof. */
function RefundPaidForm({
  termination,
  agency,
  keeper,
  onDone,
}: {
  readonly termination: EarlyTermination;
  readonly agency: boolean;
  readonly keeper: IdempotencyKeeper;
  readonly onDone: (text: string) => Promise<void>;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const [uploads] = useState(() => taxUploadOnce());
  const proof = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<RefundPaidDraft>(() => emptyRefundPaid(today, agency));
  const [tried, setTried] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const parsed = refundPaidForm(draft, termination.settledOn, today);
  const errors = tried ? parsed.errors : {};
  const working = status !== null;
  useHoldWhileSending(working);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    setReused(false);
    const file = proof.current?.files?.[0];
    const issue = file ? fileProblem(file, TAX_FILE_UPLOAD) : 'Attach the proof of the refund.';
    setFileError(issue);
    const input = parsed.input;
    if (!input || issue || !file) return;
    try {
      setStatus('Uploading the proof…');
      const proofUploadId = await uploads.idFor(file, 'refund_proof');
      setStatus('Recording the refund…');
      await sendOnce(keeper, (key) =>
        keyedApi(key).earlyTermination.recordRefundPaid({
          terminationId: termination.id,
          ...input,
          proofUploadId,
        }),
      );
      setStatus(null);
      await onDone(`Recorded the refund of ${formatMinor(termination.refundMinor)} as paid.`);
    } catch (failure) {
      setStatus(null);
      if (failure instanceof StorageUploadError) {
        setError(failure.message);
        return;
      }
      if (needsFileAgain(failure)) {
        uploads.forget(file);
        if (proof.current) proof.current.value = '';
        setFileError(fileAgainMessage('proof'));
        return;
      }
      setError(moneyProblem(failure));
      setReused(isKeyReused(failure));
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Record the refund as paid"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <p className="text-sm font-medium text-slate-900">
        Record the refund of {formatMinor(termination.refundMinor)} as paid
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Date paid"
          type="date"
          max={today}
          value={draft.paidOn}
          error={errors.paidOn}
          onChange={(event) => setDraft((d) => ({ ...d, paidOn: event.target.value }))}
        />
        <TextField
          label="Transfer or MoMo reference"
          autoComplete="off"
          spellCheck={false}
          maxLength={TAX_LIMITS.refundReferenceMax}
          value={draft.reference}
          error={errors.reference}
          onChange={(event) => setDraft((d) => ({ ...d, reference: event.target.value }))}
        />
        {agency ? (
          <SelectField
            label="Paid from"
            value={draft.paidFrom}
            error={errors.paidFrom}
            options={[
              { value: '', label: 'Choose the account' },
              ...RECEIVING_ACCOUNTS.map((a) => ({ value: a, label: RECEIVING_ACCOUNT_LABELS[a] })),
            ]}
            onChange={(event) =>
              setDraft((d) => ({
                ...d,
                paidFrom:
                  RECEIVING_ACCOUNTS.find((a): a is ReceivingAccount => a === event.target.value) ??
                  '',
              }))
            }
          />
        ) : null}
      </div>
      <FileField
        ref={proof}
        label="Proof of the refund"
        rule={TAX_FILE_UPLOAD}
        disabled={working}
        error={fileError}
        note="A screenshot of the transfer or the MoMo confirmation."
      />
      {status ? <Alert tone="info">{status}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={working}>
          Record the refund as paid
        </Button>
        {reused ? (
          <Button
            variant="secondary"
            onClick={() => {
              keeper.reset();
              setReused(false);
              setError(null);
            }}
          >
            Start again
          </Button>
        ) : null}
      </div>
    </form>
  );
}
