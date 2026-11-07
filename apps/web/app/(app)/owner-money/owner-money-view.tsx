'use client';

import { MEDIA_RULES } from '@rent/domain/maintenance';
import { REMITTANCE_METHODS } from '@rent/domain/ledger';
import { money, toDecimal } from '@rent/domain/money';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { FileField } from '@/components/file-field';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { openFetchedLink } from '@/lib/browser-files';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { errorCode, toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { isKeyReused, moneyProblem, sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { useHoldWhileSending } from '@/lib/in-flight';
import { declaredMediaType } from '@/lib/maintenance';
import {
  feesOverTakenText,
  methodOf,
  nothingToRemitText,
  OWNER_MONEY_KIND_LABELS,
  ownerMoneyMessage,
  remittanceDraftOf,
  remittanceInput,
  remittanceWarning,
  reversalReasonProblem,
  simpleTransferInput,
  suggestionProposal,
  type OwnerMoneyRow,
  type RemittanceDraft,
  type RemittanceSuggestion,
} from '@/lib/owner-money';
import { REMITTANCE_METHOD_LABELS } from '@/lib/reporting';
import { formatMinor } from '@/lib/tenancy-format';
import { fileProblem, sendToStorage, StorageUploadError, type UploadRule } from '@/lib/upload';
import { useLoad } from '@/lib/use-load';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Proof of a transfer: a PDF or a photo, 10 MB (`POST /owner-money-uploads`). */
const PROOF_RULE: UploadRule = {
  types: [...MEDIA_RULES.document.contentTypes, ...MEDIA_RULES.image.contentTypes],
  maxBytes: 10_000_000,
};

const METHOD_OPTIONS = [
  { value: '', label: 'Choose how it was paid' },
  ...REMITTANCE_METHODS.map((m) => ({ value: m, label: REMITTANCE_METHOD_LABELS[m] })),
];

export function OwnerMoneyView({
  initialOwnerId,
  canRecord,
}: {
  readonly initialOwnerId: string;
  readonly canRecord: boolean;
}) {
  const [owners, setOwners] = useState<readonly { id: string; name: string }[] | null>(null);
  const [ownerId, setOwnerId] = useState(UUID.test(initialOwnerId) ? initialOwnerId : '');
  const [open, setOpen] = useState<'remit' | 'fees' | 'fund' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [feesPrefill, setFeesPrefill] = useState<number | null>(null);

  useEffect(() => {
    let current = true;
    api()
      .owners.list({})
      .then(
        (rows) => {
          if (!current) return;
          const live = rows
            .filter((o) => !o.archived)
            .map((o) => ({ id: o.id, name: o.displayName }));
          setOwners(live);
          if (live.length === 1) setOwnerId((id) => id || live[0]!.id);
        },
        () => {
          if (current) setOwners([]);
        },
      );
    return () => {
      current = false;
    };
  }, []);

  const done = (text: string) => {
    setNotice(text);
    setOpen(null);
    setVersion((v) => v + 1);
  };

  return (
    <>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {owners && owners.length > 1 ? (
        <SelectField
          label="Owner"
          value={ownerId}
          options={[
            { value: '', label: 'Every owner' },
            ...owners.map((o) => ({ value: o.id, label: o.name })),
          ]}
          onChange={(event) => {
            setOwnerId(event.target.value);
            setOpen(null);
          }}
          className="max-w-md"
        />
      ) : null}
      {canRecord && ownerId ? (
        <Card>
          <CardHeader
            title="Record money moved"
            description="Each is a transfer already made, recorded with its proof."
          />
          <CardBody>
            {open === null ? (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setOpen('remit')}>Record a remittance</Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setFeesPrefill(null);
                    setOpen('fees');
                  }}
                >
                  Record fees taken
                </Button>
                <Button variant="secondary" onClick={() => setOpen('fund')}>
                  Record money from the owner
                </Button>
              </div>
            ) : null}
            {open === 'remit' ? (
              <RemittanceForm
                key={`${ownerId}-${version}`}
                ownerId={ownerId}
                onDone={done}
                onCancel={() => setOpen(null)}
                onTakeFees={(amountMinor) => {
                  setFeesPrefill(amountMinor);
                  setOpen('fees');
                }}
              />
            ) : null}
            {open === 'fees' ? (
              <FeesTakenForm
                ownerId={ownerId}
                initialAmountMinor={feesPrefill}
                onDone={done}
                onCancel={() => setOpen(null)}
              />
            ) : null}
            {open === 'fund' ? (
              <FundingForm ownerId={ownerId} onDone={done} onCancel={() => setOpen(null)} />
            ) : null}
          </CardBody>
        </Card>
      ) : null}
      <MoneyList ownerId={ownerId} version={version} canRecord={canRecord} onReversed={done} />
    </>
  );
}

function MoneyList({
  ownerId,
  version,
  canRecord,
  onReversed,
}: {
  readonly ownerId: string;
  readonly version: number;
  readonly canRecord: boolean;
  readonly onReversed: (text: string) => void;
}) {
  const { timeZone } = useApp();
  const [problem, setProblem] = useState<string | null>(null);
  const [reversing, setReversing] = useState<string | null>(null);
  const load = useCallback(
    // `version` reloads the list after a record.
    () => (version >= 0 ? api().ownerMoney.list(ownerId ? { ownerId } : {}) : Promise.resolve([])),
    [ownerId, version],
  );
  const { state, reload } = useLoad(load);
  return (
    <Card>
      <CardHeader title="Money moved for owners" description="Newest first." />
      <CardBody>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {state.status === 'loading' ? <Loading what="the records" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' && state.data.length === 0 ? (
          <Empty>Nothing recorded yet.</Empty>
        ) : null}
        {state.status === 'ready' && state.data.length > 0 ? (
          <ul className="divide-y divide-slate-100 text-sm">
            {state.data.map((row: OwnerMoneyRow) => (
              <li
                key={row.id}
                className="flex flex-wrap items-start justify-between gap-2 py-3"
                data-testid="owner-money-row"
                data-kind={row.kind}
              >
                <span className="space-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        row.kind === 'remittance'
                          ? 'green'
                          : row.kind === 'fees_taken'
                            ? 'blue'
                            : 'neutral'
                      }
                    >
                      {OWNER_MONEY_KIND_LABELS[row.kind]}
                    </Badge>
                    <span className="font-medium">{row.owner.name}</span>
                  </span>
                  <span className="block text-slate-700">
                    {formatBusinessDate(row.on)}
                    {row.method ? ` · ${REMITTANCE_METHOD_LABELS[row.method]}` : ''}
                    {row.reference ? ` · ${row.reference}` : ''}
                  </span>
                  <span className="block text-xs text-slate-600">
                    Recorded {formatTime(row.recordedAt, timeZone)}
                    {row.recordedByName ? ` by ${row.recordedByName}` : ''}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-1">
                  <span
                    className={
                      row.reversed
                        ? 'font-semibold tabular-nums text-slate-500 line-through'
                        : 'font-semibold tabular-nums'
                    }
                    data-testid="owner-money-amount"
                  >
                    {formatMinor(row.amountMinor)}
                  </span>
                  {row.feesRetainedMinor > 0 ? (
                    <span className="text-xs text-slate-600">
                      and {formatMinor(row.feesRetainedMinor)} fees retained
                    </span>
                  ) : null}
                  {row.hasProof ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        void openFetchedLink(
                          async () => (await api().ownerMoney.proof({ id: row.id })).url,
                        ).catch((failure: unknown) => setProblem(toProblem(failure).message))
                      }
                    >
                      Open the proof
                    </Button>
                  ) : null}
                  {canRecord && !row.reversed && reversing !== row.id ? (
                    <Button size="sm" variant="ghost" onClick={() => setReversing(row.id)}>
                      Reverse
                    </Button>
                  ) : null}
                </span>
                {/* M9 review: a record is never edited; a mistake is reversed (P21a) and stays. */}
                {row.reversed ? (
                  <p
                    className="basis-full text-sm text-slate-700"
                    data-testid="owner-money-reversed"
                  >
                    <Badge tone="dark">Reversed</Badge> on {formatBusinessDate(row.reversed.on)}
                    {row.reversed.byName ? ` by ${row.reversed.byName}` : ''},{' '}
                    {formatTime(row.reversed.at, timeZone)}: {row.reversed.reason}
                  </p>
                ) : null}
                {reversing === row.id ? (
                  <ReverseForm
                    row={row}
                    onDone={(text) => {
                      setReversing(null);
                      onReversed(text);
                    }}
                    onCancel={() => setReversing(null)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** Reverse a record made in error (P21a), with the reason; the record stays, marked reversed. */
function ReverseForm({
  row,
  onDone,
  onCancel,
}: {
  readonly row: OwnerMoneyRow;
  readonly onDone: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = reversalReasonProblem(reason);
  useHoldWhileSending(pending);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (problem) return;
    const text = reason.trim();
    if (keyedFor.current !== text) {
      keeper.reset();
      keyedFor.current = text;
    }
    setPending(true);
    try {
      await sendOnce(keeper, (key) =>
        keyedApi(key).ownerMoney.reverse({ id: row.id, reason: text }),
      );
      onDone(
        `Reversed: ${OWNER_MONEY_KIND_LABELS[row.kind].toLowerCase()} of ${formatMinor(row.amountMinor)} on ${formatBusinessDate(row.on)}.`,
      );
    } catch (failure) {
      setError(ownerMoneyMessage(failure) ?? moneyProblem(failure));
      if (isKeyReused(failure)) {
        keeper.reset();
        keyedFor.current = null;
      }
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={`Reverse ${OWNER_MONEY_KIND_LABELS[row.kind].toLowerCase()} of ${formatMinor(row.amountMinor)}`}
      className="basis-full space-y-3 rounded-md border border-red-200 bg-red-50 p-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <p className="text-sm text-red-900">
        A reversal posts the record again with each line’s sign flipped; the record stays, marked
        reversed. Record the right one afterwards if it was wrong.
      </p>
      <TextAreaField
        label="Reason"
        rows={2}
        maxLength={500}
        value={reason}
        error={tried ? problem : undefined}
        onChange={(event) => setReason(event.target.value)}
        className="[&_textarea]:font-sans"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" pending={pending}>
          Reverse it
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** One upload per chosen file: a retry sends the same proof, so the write stays the same request. */
function useProof() {
  const uploaded = useRef(new WeakMap<File, string>());
  return {
    async idFor(file: File): Promise<string> {
      const known = uploaded.current.get(file);
      if (known) return known;
      const slot = await api().ownerMoney.createUpload({
        contentType: declaredMediaType(file),
        sizeBytes: file.size,
      });
      await sendToStorage(slot, file);
      uploaded.current.set(file, slot.uploadId);
      return slot.uploadId;
    },
    forget(file: File) {
      uploaded.current.delete(file);
    },
  };
}

const proofProblem = (file: File | null): string | null =>
  file
    ? fileProblem({ name: file.name, type: declaredMediaType(file), size: file.size }, PROOF_RULE)
    : 'Attach the proof of the transfer.';

/** The remittance, prefilled from the API's suggestion (P16); proof required. */
function RemittanceForm({
  ownerId,
  onDone,
  onCancel,
  onTakeFees,
}: {
  readonly ownerId: string;
  readonly onDone: (text: string) => void;
  readonly onCancel: () => void;
  /** The suggestion proposes fees taken instead (`take_fees`), for this amount. */
  readonly onTakeFees: (amountMinor: number) => void;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const load = useCallback(() => api().ownerMoney.suggestion({ ownerId }), [ownerId]);
  const { state, reload } = useLoad(load);
  if (state.status === 'loading') return <Loading what="the suggestion" />;
  if (state.status === 'error')
    return <LoadFailed message={state.problem.message} onRetry={reload} />;
  const proposal = suggestionProposal(state.data);
  if (proposal !== 'remit')
    return (
      <div
        className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4"
        data-testid="remittance-proposal"
        data-proposal={proposal}
      >
        <SuggestionFacts suggestion={state.data} />
        <Alert tone="info" live={false}>
          <span data-testid="nothing-to-remit">
            {proposal === 'take_fees'
              ? `Nothing to remit: the fees due take everything that could be paid out. Record the ${formatMinor(state.data.feesRetainedMinor || state.data.feesDueMinor)} of fees taken instead.`
              : (nothingToRemitText(state.data) ?? 'Nothing to remit.')}
          </span>
        </Alert>
        <div className="flex flex-wrap gap-2">
          {proposal === 'take_fees' ? (
            <Button
              onClick={() => onTakeFees(state.data.feesRetainedMinor || state.data.feesDueMinor)}
            >
              Record fees taken
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  return (
    <RemittanceFields suggestion={state.data} today={today} onDone={onDone} onCancel={onCancel} />
  );
}

/** The suggestion as the API worked it out from the ledger (M9 review: with its notes). */
function SuggestionFacts({ suggestion: s }: { readonly suggestion: RemittanceSuggestion }) {
  return (
    <>
      <dl className="grid gap-2 text-sm sm:grid-cols-2" data-testid="remittance-suggestion">
        <div className="flex justify-between gap-2">
          <dt className="text-slate-600">Held for {s.owner.name}</dt>
          <dd className="tabular-nums">{formatMinor(s.agentCashMinor)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-600">Fees due to the agency</dt>
          <dd className="tabular-nums">{formatMinor(s.feesDueMinor)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-600">
            Rent tax held back{' '}
            {s.graPaidBy === 'agency' ? '(the agency pays GRA)' : '(the owner pays GRA)'}
          </dt>
          <dd className="tabular-nums" data-testid="suggestion-tax-held">
            {formatMinor(s.rentTaxHeldBackMinor)}
          </dd>
        </div>
        {s.rentTaxWithheldMinor > 0 ? (
          <div className="flex justify-between gap-2" data-testid="suggestion-tax-withheld">
            <dt className="text-slate-600">
              Rent tax tenants withheld, awaiting certificates (not held back: the agency does not
              pay it)
            </dt>
            <dd className="tabular-nums">{formatMinor(s.rentTaxWithheldMinor)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-2 font-semibold">
          <dt>Suggested: to the owner</dt>
          <dd className="tabular-nums" data-testid="suggestion-net">
            {formatMinor(s.netMinor)}
          </dd>
        </div>
      </dl>
      <p className="text-xs text-slate-600">As of {formatBusinessDate(s.asOf)}, from the ledger.</p>
      {feesOverTakenText(s) ? (
        <Alert tone="warning" live={false}>
          <span data-testid="fees-over-taken">{feesOverTakenText(s)}</span>
        </Alert>
      ) : null}
    </>
  );
}

function RemittanceFields({
  suggestion: s,
  today,
  onDone,
  onCancel,
}: {
  readonly suggestion: RemittanceSuggestion;
  readonly today: string;
  readonly onDone: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);
  const proof = useRef<HTMLInputElement>(null);
  const uploads = useProof();
  const [draft, setDraft] = useState<RemittanceDraft>(() => remittanceDraftOf(s, today));
  const [tried, setTried] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const parsed = remittanceInput(draft, today);
  const errors = tried ? parsed.errors : {};
  const warning = parsed.input ? remittanceWarning(parsed.input, s) : null;
  useHoldWhileSending(status !== null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    const file = proof.current?.files?.[0] ?? null;
    const issue = proofProblem(file);
    setFileError(issue);
    const input = parsed.input;
    if (!input || issue || !file) return;
    const content = JSON.stringify([input, file.name, file.size, file.lastModified]);
    if (keyedFor.current !== content) {
      keeper.reset();
      keyedFor.current = content;
    }
    try {
      setStatus('Uploading the proof…');
      const proofUploadId = await uploads.idFor(file);
      setStatus('Recording the remittance…');
      await sendOnce(keeper, (key) =>
        keyedApi(key).ownerMoney.remit({ ownerId: s.owner.id, ...input, proofUploadId }),
      );
      setStatus(null);
      onDone(
        `Recorded ${formatMinor(input.netMinor)} paid to ${s.owner.name}${input.feesRetainedMinor > 0 ? `, with ${formatMinor(input.feesRetainedMinor)} of fees retained` : ''}.`,
      );
    } catch (failure) {
      setStatus(null);
      if (failure instanceof StorageUploadError) {
        setError(failure.message);
        return;
      }
      if (/^(UPLOAD|MEDIA)_/.test(errorCode(failure))) uploads.forget(file);
      setError(ownerMoneyMessage(failure) ?? moneyProblem(failure));
      if (isKeyReused(failure)) {
        keeper.reset();
        keyedFor.current = null;
      }
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Record a remittance"
      className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <SuggestionFacts suggestion={s} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Paid to the owner (GH₵)"
          inputMode="decimal"
          autoComplete="off"
          value={draft.net}
          error={errors.net}
          onChange={(event) => setDraft((d) => ({ ...d, net: event.target.value }))}
        />
        <TextField
          label="Fees retained (GH₵)"
          inputMode="decimal"
          autoComplete="off"
          value={draft.feesRetained}
          error={errors.feesRetained}
          hint="The agency’s fees taken out of this transfer."
          onChange={(event) => setDraft((d) => ({ ...d, feesRetained: event.target.value }))}
        />
        <TextField
          label="Date of the transfer"
          type="date"
          max={today}
          value={draft.on}
          error={errors.on}
          onChange={(event) => setDraft((d) => ({ ...d, on: event.target.value }))}
        />
        <SelectField
          label="How it was paid"
          value={draft.method}
          error={errors.method}
          options={METHOD_OPTIONS}
          onChange={(event) =>
            setDraft((d) => ({ ...d, method: methodOf(event.target.value) ?? '' }))
          }
        />
        <TextField
          label="Reference"
          autoComplete="off"
          maxLength={120}
          value={draft.reference}
          error={errors.reference}
          onChange={(event) => setDraft((d) => ({ ...d, reference: event.target.value }))}
        />
      </div>
      {warning ? (
        <Alert tone="warning" live={false}>
          <span data-testid="remittance-warning">{warning}</span>
        </Alert>
      ) : null}
      <FileField
        ref={proof}
        label="Proof of the transfer (required)"
        rule={PROOF_RULE}
        disabled={status !== null}
        error={fileError}
        note="The bank or MoMo confirmation, or a photo of the cheque."
      />
      {status ? (
        <p role="status" className="text-sm text-slate-700">
          {status}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={status !== null}>
          Record the remittance
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={status !== null}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function FeesTakenForm({
  ownerId,
  initialAmountMinor,
  onDone,
  onCancel,
}: {
  readonly ownerId: string;
  /** From the suggestion's `take_fees` proposal, or none. */
  readonly initialAmountMinor: number | null;
  readonly onDone: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);
  const [draft, setDraft] = useState(() => ({
    amount: initialAmountMinor ? toDecimal(money(initialAmountMinor)) : '',
    on: today,
    reference: '',
  }));
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = simpleTransferInput(draft, today, { needsMethod: false, needsReference: false });
  const errors = tried ? parsed.errors : {};
  useHoldWhileSending(pending);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    const input = parsed.input;
    if (!input) return;
    const content = JSON.stringify(input);
    if (keyedFor.current !== content) {
      keeper.reset();
      keyedFor.current = content;
    }
    setPending(true);
    try {
      await sendOnce(keeper, (key) =>
        keyedApi(key).ownerMoney.takeFees({
          ownerId,
          on: input.on,
          amountMinor: input.amountMinor,
          reference: input.reference,
        }),
      );
      onDone(`Recorded ${formatMinor(input.amountMinor)} of fees taken.`);
    } catch (failure) {
      setError(ownerMoneyMessage(failure) ?? moneyProblem(failure));
      if (isKeyReused(failure)) {
        keeper.reset();
        keyedFor.current = null;
      }
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Record fees taken"
      className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <p className="text-sm text-slate-700">
        Fees the agency took from the owner’s money without a remittance (Dr 2300, Cr 1070).
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label="Amount (GH₵)"
          inputMode="decimal"
          autoComplete="off"
          value={draft.amount}
          error={errors.amount}
          onChange={(event) => setDraft((d) => ({ ...d, amount: event.target.value }))}
        />
        <TextField
          label="Date"
          type="date"
          max={today}
          value={draft.on}
          error={errors.on}
          onChange={(event) => setDraft((d) => ({ ...d, on: event.target.value }))}
        />
        <TextField
          label="Reference (optional)"
          autoComplete="off"
          maxLength={120}
          value={draft.reference}
          error={errors.reference}
          onChange={(event) => setDraft((d) => ({ ...d, reference: event.target.value }))}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Record the fees taken
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function FundingForm({
  ownerId,
  onDone,
  onCancel,
}: {
  readonly ownerId: string;
  readonly onDone: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);
  const proof = useRef<HTMLInputElement>(null);
  const uploads = useProof();
  const [draft, setDraft] = useState({ amount: '', on: today, reference: '', method: '' });
  const [tried, setTried] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const parsed = simpleTransferInput(draft, today, { needsMethod: true, needsReference: true });
  const errors = tried ? parsed.errors : {};
  useHoldWhileSending(status !== null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    const file = proof.current?.files?.[0] ?? null;
    const issue = proofProblem(file);
    setFileError(issue);
    const input = parsed.input;
    if (!input || !input.method || !input.reference || issue || !file) return;
    const { method, reference } = input;
    const content = JSON.stringify([input, file.name, file.size, file.lastModified]);
    if (keyedFor.current !== content) {
      keeper.reset();
      keyedFor.current = content;
    }
    try {
      setStatus('Uploading the proof…');
      const proofUploadId = await uploads.idFor(file);
      setStatus('Recording the money from the owner…');
      await sendOnce(keeper, (key) =>
        keyedApi(key).ownerMoney.fund({
          ownerId,
          on: input.on,
          method,
          reference,
          amountMinor: input.amountMinor,
          proofUploadId,
        }),
      );
      setStatus(null);
      onDone(`Recorded ${formatMinor(input.amountMinor)} received from the owner.`);
    } catch (failure) {
      setStatus(null);
      if (failure instanceof StorageUploadError) {
        setError(failure.message);
        return;
      }
      if (/^(UPLOAD|MEDIA)_/.test(errorCode(failure))) uploads.forget(file);
      setError(ownerMoneyMessage(failure) ?? moneyProblem(failure));
      if (isKeyReused(failure)) {
        keeper.reset();
        keyedFor.current = null;
      }
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Record money from the owner"
      className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <p className="text-sm text-slate-700">
        Money the owner sent the agency for their bills (P30: Dr 1070, Cr 1010).
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Amount (GH₵)"
          inputMode="decimal"
          autoComplete="off"
          value={draft.amount}
          error={errors.amount}
          onChange={(event) => setDraft((d) => ({ ...d, amount: event.target.value }))}
        />
        <TextField
          label="Date of the transfer"
          type="date"
          max={today}
          value={draft.on}
          error={errors.on}
          onChange={(event) => setDraft((d) => ({ ...d, on: event.target.value }))}
        />
        <SelectField
          label="How it was paid"
          value={draft.method}
          error={errors.method}
          options={METHOD_OPTIONS}
          onChange={(event) => setDraft((d) => ({ ...d, method: event.target.value }))}
        />
        <TextField
          label="Reference"
          autoComplete="off"
          maxLength={120}
          value={draft.reference}
          error={errors.reference}
          onChange={(event) => setDraft((d) => ({ ...d, reference: event.target.value }))}
        />
      </div>
      <FileField
        ref={proof}
        label="Proof of the transfer (required)"
        rule={PROOF_RULE}
        disabled={status !== null}
        error={fileError}
      />
      {status ? (
        <p role="status" className="text-sm text-slate-700">
          {status}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={status !== null}>
          Record the money from the owner
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={status !== null}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
