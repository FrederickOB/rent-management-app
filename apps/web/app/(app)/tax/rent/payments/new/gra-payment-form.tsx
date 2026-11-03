'use client';

import { RECEIVING_ACCOUNTS } from '@rent/contracts';
import Link from 'next/link';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { CancelLink } from '@/components/cancel-link';
import { FileField } from '@/components/file-field';
import { secondaryLink } from '@/components/link-styles';
import { Empty, Loading, LoadFailed } from '@/components/load-state';
import { RulesWarning } from '@/components/rules-warning';
import { DueBadge } from '@/components/tax-badges';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { RECEIVING_ACCOUNT_LABELS, type ReceivingAccount } from '@/lib/billing-format';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { isKeyReused, moneyProblem, sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { useHoldWhileSending } from '@/lib/in-flight';
import { amountInput } from '@/lib/lease-form';
import { fileAgainMessage, needsFileAgain } from '@/lib/payment-upload';
import {
  dueList,
  emptyGraPayment,
  GRA_LIMITS,
  graPaymentForm,
  owedOn,
  tickedItems,
  type GraPaymentDraft,
  type TaxItemRow,
} from '@/lib/rent-tax';
import { formatMinor } from '@/lib/tenancy-format';
import { TAX_FILE_UPLOAD, taxUploadOnce } from '@/lib/tax-upload';
import { fileProblem, StorageUploadError } from '@/lib/upload';
import { useLoad } from '@/lib/use-load';

interface Owed {
  readonly items: readonly TaxItemRow[];
  readonly rules: Parameters<typeof RulesWarning>[0]['rules'];
}

/**
 * A GRA payment (P18; plan 5.3). GRA's receipt goes straight to storage; the payment then settles
 * the ticked items, oldest first. The submission keeps one Idempotency-Key and one upload until
 * it is answered, so sending it again after a dropped connection never records it twice.
 */
export function GraPaymentForm({
  owners,
  initialOwnerId,
  agency,
}: {
  readonly owners: readonly { readonly id: string; readonly label: string }[];
  readonly initialOwnerId: string | null;
  readonly agency: boolean;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const keeper = useIdempotencyKeeper();
  const [uploads] = useState(() => taxUploadOnce());
  const receipt = useRef<HTMLInputElement>(null);
  const [ownerId, setOwnerId] = useState(
    initialOwnerId && owners.some((o) => o.id === initialOwnerId)
      ? initialOwnerId
      : owners.length === 1
        ? owners[0]!.id
        : '',
  );
  const [draft, setDraft] = useState<GraPaymentDraft>(() => emptyGraPayment(today, agency));
  const [tried, setTried] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async (): Promise<Owed> => {
    if (!ownerId) return { items: [], rules: [] };
    const rows = await api().rentTax.due({ ownerId });
    return { items: rows, rules: rows.flatMap((row) => row.rules) };
  }, [ownerId]);
  const { state, reload } = useLoad(load);
  const items = state.status === 'ready' ? dueList(state.data.items) : [];

  const parsed = graPaymentForm(draft, { ownerId: ownerId || null, items }, today);
  const errors = tried ? parsed.errors : {};
  const ticked = tickedItems(items, parsed.amountMinor, draft.chosen);
  const takes = new Map((parsed.plan?.lines ?? []).map((line) => [line.itemId, line.amountMinor]));
  const set = (patch: Partial<GraPaymentDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const working = status !== null;
  useHoldWhileSending(working);

  function chooseOwner(id: string) {
    setOwnerId(id);
    // Another owner's items: the choice starts again, following the amount.
    set({ chosen: null });
  }

  function tick(itemId: string, on: boolean) {
    const next = new Set(ticked);
    if (on) next.add(itemId);
    else next.delete(itemId);
    set({ chosen: items.filter((item) => next.has(item.id)).map((item) => item.id) });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setProblem(null);
    setReused(false);
    const file = receipt.current?.files?.[0];
    const fileIssue = file ? fileProblem(file, TAX_FILE_UPLOAD) : 'Attach GRA’s receipt.';
    setFileError(fileIssue);
    const input = parsed.input;
    if (!input || fileIssue || !file) return;
    try {
      setStatus('Uploading GRA’s receipt…');
      const receiptUploadId = await uploads.idFor(file, 'gra_receipt');
      setStatus('Recording the payment…');
      await sendOnce(keeper, (key) =>
        keyedApi(key).rentTax.recordGraPayment({ ...input, receiptUploadId }),
      );
      setStatus(null);
      const owner = owners.find((o) => o.id === input.ownerId)?.label ?? 'the owner';
      const settled = input.items?.length ?? 0;
      setDone(
        `Recorded ${formatMinor(input.amountMinor)} paid to GRA for ${owner}, settling ${settled} tax item${settled === 1 ? '' : 's'}.`,
      );
    } catch (failure) {
      setStatus(null);
      if (failure instanceof StorageUploadError) {
        setProblem(failure.message);
        return;
      }
      if (needsFileAgain(failure)) {
        uploads.forget(file);
        if (receipt.current) receipt.current.value = '';
        setFileError(fileAgainMessage('receipt'));
        setProblem(fileAgainMessage('receipt'));
        return;
      }
      setProblem(moneyProblem(failure));
      setReused(isKeyReused(failure));
    }
  }

  function another() {
    keeper.reset();
    setReused(false);
    setDone(null);
    setTried(false);
    setProblem(null);
    setFileError(null);
    setDraft(emptyGraPayment(today, agency));
    if (receipt.current) receipt.current.value = '';
    reload();
  }

  if (done)
    return (
      <Card data-testid="gra-payment-recorded">
        <CardBody>
          <Alert tone="success" title="Recorded">
            {done}
          </Alert>
          <div className="flex flex-wrap gap-2">
            <Button onClick={another}>Record another GRA payment</Button>
            <Link href={`/tax/rent?ownerId=${ownerId}`} className={secondaryLink}>
              Back to rent tax
            </Link>
          </div>
        </CardBody>
      </Card>
    );

  return (
    <form onSubmit={submit} noValidate aria-label="Record a GRA payment" className="space-y-6">
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      <Card>
        <CardHeader title="The payment" />
        <CardBody className="grid gap-4 sm:grid-cols-2 sm:space-y-0">
          <SelectField
            label="Owner"
            value={ownerId}
            options={[
              { value: '', label: owners.length ? 'Choose the owner' : 'No owners to choose from' },
              ...owners.map((o) => ({ value: o.id, label: o.label })),
            ]}
            disabled={working}
            onChange={(event) => chooseOwner(event.target.value)}
          />
          {agency ? (
            <SelectField
              label="Paid from"
              value={draft.paidFrom}
              error={errors.paidFrom}
              options={[
                { value: '', label: 'Choose the account' },
                ...RECEIVING_ACCOUNTS.map((a) => ({
                  value: a,
                  label: RECEIVING_ACCOUNT_LABELS[a],
                })),
              ]}
              onChange={(event) =>
                set({
                  paidFrom:
                    RECEIVING_ACCOUNTS.find(
                      (a): a is ReceivingAccount => a === event.target.value,
                    ) ?? '',
                })
              }
            />
          ) : (
            <p className="text-sm text-slate-700">Paid from your own account.</p>
          )}
          <TextField
            label="Amount paid (GH₵)"
            inputMode="decimal"
            autoComplete="off"
            value={draft.amount}
            error={errors.amount}
            onChange={(event) => set({ amount: event.target.value })}
          />
          <TextField
            label="Date paid"
            type="date"
            max={today}
            value={draft.paidOn}
            error={errors.paidOn}
            onChange={(event) => set({ paidOn: event.target.value })}
          />
          <TextField
            label="GRA receipt number"
            autoComplete="off"
            spellCheck={false}
            maxLength={GRA_LIMITS.receiptNumberMax}
            value={draft.graReceiptNumber}
            error={errors.graReceiptNumber}
            onChange={(event) => set({ graReceiptNumber: event.target.value })}
          />
          <TextAreaField
            label="Note (optional)"
            rows={2}
            maxLength={GRA_LIMITS.noteMax}
            value={draft.note}
            error={errors.note}
            onChange={(event) => set({ note: event.target.value })}
            className="sm:col-span-2 [&_textarea]:font-sans"
          />
          <div className="sm:col-span-2">
            <FileField
              ref={receipt}
              label="GRA’s receipt"
              rule={TAX_FILE_UPLOAD}
              disabled={working}
              error={fileError}
              note="A photo or scan of the receipt GRA issued for this payment."
            />
          </div>
        </CardBody>
      </Card>

      <Card data-testid="gra-payment-items">
        <CardHeader
          title="What it settles"
          description="The oldest rent tax is ticked first, as far as the amount goes. Tick or untick to choose others; the amount is still applied oldest first."
          actions={
            ticked.length ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  set({ amount: amountInput(owedOn(items, ticked)), chosen: [...ticked] })
                }
              >
                Pay all ticked: {formatMinor(owedOn(items, ticked))}
              </Button>
            ) : null
          }
        />
        <CardBody>
          {!ownerId ? <Empty>Choose the owner first.</Empty> : null}
          {ownerId && state.status === 'loading' ? <Loading what="the tax owed" /> : null}
          {state.status === 'error' ? (
            <LoadFailed message={state.problem.message} onRetry={reload} />
          ) : null}
          {state.status === 'ready' ? <RulesWarning rules={state.data.rules} /> : null}
          {ownerId && state.status === 'ready' && items.length === 0 ? (
            <Empty>Nothing is owed to GRA for this owner.</Empty>
          ) : null}
          {items.length ? (
            <ul className="divide-y divide-slate-100" aria-label="Rent tax owed, oldest first">
              {items.map((item) => (
                <li key={item.id} data-testid="gra-item" className="space-y-1 py-3">
                  <CheckboxField
                    label={`${item.receiptNumber ?? 'Receipt'} · ${item.unitCode} · received ${formatBusinessDate(item.valueDate)}: ${formatMinor(item.outstandingMinor)} still to pay`}
                    checked={ticked.includes(item.id)}
                    disabled={working}
                    onChange={(event) => tick(item.id, event.target.checked)}
                    hint={
                      takes.has(item.id)
                        ? `This payment settles ${formatMinor(takes.get(item.id)!)} of it.`
                        : undefined
                    }
                  />
                  <div className="pl-8">
                    <DueBadge item={item} today={today} />
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {errors.items ? (
            <p className="text-sm font-medium text-red-700" role="alert">
              {errors.items}
            </p>
          ) : null}
        </CardBody>
      </Card>

      {status ? <Alert tone="info">{status}</Alert> : null}
      {reused ? (
        <Button variant="secondary" onClick={another}>
          Start again
        </Button>
      ) : null}
      {tried && !working && !problem && (!parsed.input || fileError) ? (
        <p className="text-sm text-slate-600">Check the fields marked above.</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" pending={working}>
          Record the GRA payment
        </Button>
        <CancelLink
          href={ownerId ? `/tax/rent?ownerId=${ownerId}` : '/tax/rent'}
          disabled={working}
        />
      </div>
    </form>
  );
}
