'use client';

import Link from 'next/link';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { CancelLink } from '@/components/cancel-link';
import { FileField } from '@/components/file-field';
import { secondaryLink, textLink } from '@/components/link-styles';
import { Empty, Loading, LoadFailed } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import type { ReceivingAccount } from '@/lib/billing-format';
import { todayIn } from '@/lib/business-dates';
import { isKeyReused, moneyProblem, sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { useHoldWhileSending } from '@/lib/in-flight';
import { amountInput } from '@/lib/lease-form';
import { waitingNote } from '@/lib/money-requests';
import {
  bankableHoldings,
  bankingForm,
  holdingKey,
  type BankingDraft,
  type CollectorCash,
} from '@/lib/payment-form';
import {
  fileAgainMessage,
  needsFileAgain,
  PAYMENT_PROOF_UPLOAD,
  uploadOnce,
} from '@/lib/payment-upload';
import { formatMinor } from '@/lib/tenancy-format';
import { fileProblem, StorageUploadError } from '@/lib/upload';
import { useLoad } from '@/lib/use-load';

const DESTINATIONS: Record<ReceivingAccount, string> = {
  owner_account: 'Banked into the owner’s own account',
  agency_account: 'Handed to the agency',
};

/** Loads what can be banked, then shows the form (P07). */
export function BankingForm({
  initial,
  bankOthers,
  agency,
}: {
  readonly initial: { readonly collectorPersonId: string | null; readonly ownerId: string | null };
  readonly bankOthers: boolean;
  readonly agency: boolean;
}) {
  const { me } = useApp();
  const load = useCallback(() => api().payments.collectorsCash(), []);
  const { state, reload } = useLoad(load);
  // "Start again" begins a new round: fresh fields, a new Idempotency-Key, the holdings reloaded.
  const [round, setRound] = useState(0);
  if (state.status === 'loading') return <Loading what="the cash held" />;
  if (state.status === 'error')
    return <LoadFailed message={state.problem.message} onRetry={reload} />;
  const holdings = bankableHoldings(state.data, { personId: me.personId, others: bankOthers });
  if (holdings.length === 0)
    return (
      <Card>
        <CardBody>
          <Empty>
            There is no cash or cheque left to bank: everything held is banked or waiting for
            approval.
          </Empty>
          <Link href="/cash" className={textLink}>
            Back to cash on hand
          </Link>
        </CardBody>
      </Card>
    );
  const chosen =
    holdings.find(
      (h) => h.collectorPersonId === initial.collectorPersonId && h.ownerId === initial.ownerId,
    ) ?? (holdings.length === 1 ? holdings[0]! : null);
  return (
    <BankingFields
      key={round}
      holdings={holdings}
      chosen={chosen}
      agency={agency}
      onStartAgain={() => {
        setRound((r) => r + 1);
        reload();
      }}
    />
  );
}

function BankingFields({
  holdings,
  chosen,
  agency,
  onStartAgain,
}: {
  readonly holdings: readonly CollectorCash[];
  readonly chosen: CollectorCash | null;
  readonly agency: boolean;
  /** A new round of the form: cleared details and slip, a new key, the holdings reloaded. */
  readonly onStartAgain: () => void;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const keeper = useIdempotencyKeeper();
  const [uploads] = useState(() => uploadOnce());
  const slip = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<BankingDraft>(() => ({
    holding: chosen ? holdingKey(chosen) : '',
    bankedInto: agency ? '' : 'owner_account',
    amount: chosen ? amountInput(chosen.bankableMinor) : '',
    bankedOn: today,
    note: '',
  }));
  const [tried, setTried] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // An earlier attempt reached the API with other details: offer a fresh form, never a retry.
  const [reused, setReused] = useState(false);
  const [slipError, setSlipError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const holding = holdings.find((h) => holdingKey(h) === draft.holding) ?? null;
  const parsed = bankingForm(draft, holdings, today);
  const errors = tried ? parsed.errors : {};
  const set = (patch: Partial<BankingDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const working = status !== null;
  useHoldWhileSending(working);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setProblem(null);
    setReused(false);
    const file = slip.current?.files?.[0];
    const fileError = file
      ? fileProblem(file, PAYMENT_PROOF_UPLOAD)
      : 'Attach a photo of the slip.';
    setSlipError(fileError);
    const input = parsed.input;
    if (!input || fileError || !file || !holding) return;
    try {
      setStatus('Uploading the slip…');
      const slipUploadId = await uploads.idFor(file, 'banking_slip');
      setStatus('Recording the banking…');
      const { approval } = await sendOnce(keeper, (key) =>
        keyedApi(key).payments.recordBanking({ ...input, slipUploadId }),
      );
      setStatus(null);
      setDone(
        `${formatMinor(input.amountMinor)} of ${holding.collectorName}’s cash for ${holding.ownerName}. It stays in their cash on hand until it is confirmed. ${waitingNote(approval, timeZone)}`,
      );
    } catch (failure) {
      setStatus(null);
      if (failure instanceof StorageUploadError) {
        setProblem(failure.message);
        return;
      }
      // The upload itself was refused (expired or missing): the slip must be chosen again. For
      // anything else the same upload is sent again, which the API accepts.
      if (needsFileAgain(failure)) {
        uploads.forget(file);
        if (slip.current) slip.current.value = '';
        setSlipError(fileAgainMessage('slip'));
        setProblem(fileAgainMessage('slip'));
        return;
      }
      setProblem(moneyProblem(failure));
      setReused(isKeyReused(failure));
    }
  }

  if (done)
    return (
      <Card data-testid="banking-recorded">
        <CardBody>
          <Alert tone="success" title="Banking recorded, waiting for confirmation">
            {done}
          </Alert>
          <Link href="/cash" className={secondaryLink}>
            Back to cash on hand
          </Link>
        </CardBody>
      </Card>
    );

  return (
    <form onSubmit={submit} noValidate aria-label="Record banking" className="space-y-6">
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      <Card>
        <CardHeader title="The cash banked" />
        <CardBody className="grid gap-4 sm:grid-cols-2 sm:space-y-0">
          <SelectField
            label="Whose cash"
            value={draft.holding}
            error={errors.holding}
            className="sm:col-span-2"
            options={[
              ...(holdings.length > 1 ? [{ value: '', label: 'Choose whose cash it is' }] : []),
              ...holdings.map((h) => ({
                value: holdingKey(h),
                label: `${h.collectorName}, for ${h.ownerName}: ${formatMinor(h.bankableMinor)} to bank`,
              })),
            ]}
            onChange={(event) => {
              // A new choice of whose cash starts the amount at all of it.
              const next = holdings.find((h) => holdingKey(h) === event.target.value);
              set({
                holding: event.target.value,
                amount: next ? amountInput(next.bankableMinor) : '',
              });
            }}
          />
          {agency ? (
            <SelectField
              label="Where it went"
              value={draft.bankedInto}
              error={errors.bankedInto}
              options={[
                { value: '', label: 'Choose where it went' },
                { value: 'owner_account', label: DESTINATIONS.owner_account },
                { value: 'agency_account', label: DESTINATIONS.agency_account },
              ]}
              onChange={(event) =>
                set({
                  bankedInto:
                    event.target.value === 'owner_account' ||
                    event.target.value === 'agency_account'
                      ? event.target.value
                      : '',
                })
              }
            />
          ) : (
            <p className="text-sm text-slate-700">{DESTINATIONS.owner_account}.</p>
          )}
          <TextField
            label="Amount (GH₵)"
            inputMode="decimal"
            autoComplete="off"
            hint={holding ? `At most ${formatMinor(holding.bankableMinor)}.` : undefined}
            value={draft.amount}
            error={errors.amount}
            onChange={(event) => set({ amount: event.target.value })}
          />
          <TextField
            label="Date banked"
            type="date"
            max={today}
            value={draft.bankedOn}
            error={errors.bankedOn}
            onChange={(event) => set({ bankedOn: event.target.value })}
          />
          <TextAreaField
            label="Note (optional)"
            rows={2}
            maxLength={500}
            value={draft.note}
            error={errors.note}
            onChange={(event) => set({ note: event.target.value })}
            className="sm:col-span-2 [&_textarea]:font-sans"
          />
          <div className="sm:col-span-2">
            <FileField
              ref={slip}
              label="Photo of the banking slip"
              rule={PAYMENT_PROOF_UPLOAD}
              disabled={working}
              error={slipError}
              note="The bank’s slip or the agency’s acknowledgement, with the amount and the date readable."
            />
          </div>
        </CardBody>
      </Card>

      {status ? <Alert tone="info">{status}</Alert> : null}
      {problem ? (
        <Alert tone="error" live={false}>
          {problem}
        </Alert>
      ) : null}
      {reused ? (
        <Button variant="secondary" onClick={onStartAgain}>
          Start again
        </Button>
      ) : null}
      {tried && !working && !problem && (!parsed.input || slipError) ? (
        <p className="text-sm text-slate-600">Check the fields marked above.</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" pending={working}>
          Record the banking
        </Button>
        <CancelLink href="/cash" disabled={working} />
      </div>
    </form>
  );
}
