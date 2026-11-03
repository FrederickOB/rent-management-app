'use client';

import { RECEIVING_ACCOUNTS } from '@rent/contracts';
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { CancelLink } from '@/components/cancel-link';
import { FileField } from '@/components/file-field';
import { secondaryLink } from '@/components/link-styles';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { keyedApi } from '@/lib/api';
import { RECEIVING_ACCOUNT_LABELS, type ReceivingAccount } from '@/lib/billing-format';
import { todayIn } from '@/lib/business-dates';
import { isKeyReused, moneyProblem, sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { useHoldWhileSending } from '@/lib/in-flight';
import { fileAgainMessage, needsFileAgain } from '@/lib/payment-upload';
import { GRA_LIMITS, monthLabel, monthOf, previousMonth } from '@/lib/rent-tax';
import { formatMinor } from '@/lib/tenancy-format';
import { TAX_FILE_UPLOAD, taxUploadOnce } from '@/lib/tax-upload';
import { fileProblem, StorageUploadError } from '@/lib/upload';
import { emptyVatPayment, vatPaymentForm, type VatPaymentDraft } from '@/lib/vat-returns';

/**
 * A VAT payment to GRA (P33). GRA's receipt goes straight to storage; the submission keeps one
 * Idempotency-Key and one upload until it is answered, so it is never recorded twice.
 */
export function VatPaymentForm({
  owners,
  initialOwnerId,
  initialMonth,
  agency,
}: {
  readonly owners: readonly { readonly id: string; readonly label: string }[];
  readonly initialOwnerId: string | null;
  readonly initialMonth: string | null;
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
  const [draft, setDraft] = useState<VatPaymentDraft>(() =>
    emptyVatPayment(initialMonth ?? previousMonth(today), today, agency),
  );
  const [tried, setTried] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const parsed = vatPaymentForm(draft, ownerId || null, today);
  const errors = tried ? parsed.errors : {};
  const set = (patch: Partial<VatPaymentDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const working = status !== null;
  useHoldWhileSending(working);

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
        keyedApi(key).vat.recordPayment({ ...input, receiptUploadId }),
      );
      setStatus(null);
      const owner = owners.find((o) => o.id === input.ownerId)?.label ?? 'the owner';
      setDone(
        `Recorded ${formatMinor(input.amountMinor)} of VAT and levies paid to GRA for ${owner}, for ${monthLabel(draft.month)}.`,
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
    setDraft(emptyVatPayment(draft.month, today, agency));
    if (receipt.current) receipt.current.value = '';
  }

  if (done)
    return (
      <Card data-testid="vat-payment-recorded">
        <CardBody>
          <Alert tone="success" title="Recorded">
            {done}
          </Alert>
          <div className="flex flex-wrap gap-2">
            <Button onClick={another}>Record another VAT payment</Button>
            <Link
              href={`/tax/vat?ownerId=${ownerId}&month=${draft.month}`}
              className={secondaryLink}
            >
              Back to VAT returns
            </Link>
          </div>
        </CardBody>
      </Card>
    );

  return (
    <form onSubmit={submit} noValidate aria-label="Record a VAT payment" className="space-y-6">
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      <Card>
        <CardHeader title="The payment" />
        <CardBody className="grid gap-4 sm:grid-cols-2 sm:space-y-0">
          <SelectField
            label="Owner"
            value={ownerId}
            error={errors.owner}
            options={[
              {
                value: '',
                label: owners.length ? 'Choose the owner' : 'No owner is registered for VAT',
              },
              ...owners.map((o) => ({ value: o.id, label: o.label })),
            ]}
            disabled={working}
            onChange={(event) => setOwnerId(event.target.value)}
          />
          <TextField
            label="Month of the return"
            type="month"
            hint="Year and month, such as 2026-10."
            max={monthOf(today)}
            value={draft.month}
            error={errors.month}
            onChange={(event) => set({ month: event.target.value })}
          />
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
          Record the VAT payment
        </Button>
        <CancelLink href="/tax/vat" disabled={working} />
      </div>
    </form>
  );
}
