'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { FileField } from '@/components/file-field';
import { LeasePicker } from '@/components/lease-picker';
import { secondaryLink, textLink } from '@/components/link-styles';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { keyedApi } from '@/lib/api';
import { todayIn } from '@/lib/business-dates';
import {
  isKeyReused,
  moneyProblem,
  outcomeOf,
  sendOnce,
  useIdempotencyKeeper,
} from '@/lib/idempotency';
import type { PickedLease } from '@/lib/lease-pick';
import { waitingNote } from '@/lib/money-requests';
import { cashForm, emptyCash, type CashDraft } from '@/lib/payment-form';
import { CASH_PHOTO_UPLOAD, uploadOnce } from '@/lib/payment-upload';
import { formatMinor } from '@/lib/tenancy-format';
import { fileProblem, StorageUploadError } from '@/lib/upload';

interface Done {
  readonly text: string;
  readonly leaseId: string;
}

/**
 * The cash and cheque form (BC-05). The photo comes from the phone's camera and goes straight to
 * storage. One submission keeps one Idempotency-Key and one upload until the API answers, so
 * tapping "Record" again on a slow connection never records the money twice.
 */
export function CashForm({
  initialLease,
  collectors,
  seeLease,
}: {
  readonly initialLease: PickedLease | null;
  /** Other people who may hold the money; empty when this person may not list them. */
  readonly collectors: readonly { readonly id: string; readonly name: string }[];
  readonly seeLease: boolean;
}) {
  const { me, timeZone } = useApp();
  const today = todayIn(timeZone);
  const keeper = useIdempotencyKeeper();
  const [uploads] = useState(() => uploadOnce());
  const photo = useRef<HTMLInputElement>(null);
  const [lease, setLease] = useState<PickedLease | null>(initialLease);
  const [draft, setDraft] = useState<CashDraft>(() => ({
    ...emptyCash(today, initialLease?.id ?? null),
    payerName: initialLease?.tenantName ?? '',
  }));
  const [tried, setTried] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The first attempt was recorded with other details: offer a fresh form, never a silent retry.
  const [reused, setReused] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const parsed = cashForm({ ...draft, leaseId: lease?.id ?? null }, today);
  const errors = tried ? parsed.errors : {};
  const cheque = draft.method === 'cheque';
  const set = (patch: Partial<CashDraft>) => setDraft((d) => ({ ...d, ...patch }));

  function pickLease(next: PickedLease | null) {
    setLease(next);
    // The payer is usually the tenant: fill it in until someone types another name.
    setDraft((d) =>
      !d.payerName.trim() || d.payerName === lease?.tenantName
        ? { ...d, payerName: next?.tenantName ?? '' }
        : d,
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setProblem(null);
    setReused(false);
    const file = photo.current?.files?.[0];
    const fileError = file
      ? fileProblem(file, CASH_PHOTO_UPLOAD)
      : `Take a photo of the ${cheque ? 'cheque' : 'receipt-book page'}.`;
    setPhotoError(fileError);
    const input = parsed.input;
    if (!input || fileError || !file || !lease) return;
    try {
      setStatus('Uploading the photo…');
      const photoUploadId = await uploads.idFor(file, 'cash_photo');
      setStatus('Recording it…');
      const { approval } = await sendOnce(keeper, (key) =>
        keyedApi(key).payments.recordCash({ ...input, photoUploadId }),
      );
      setStatus(null);
      setDone({
        text: `${formatMinor(input.amountMinor)} ${cheque ? 'by cheque' : 'in cash'} for ${lease.unitCode}, from ${input.payerName}. Nothing posts, and no receipt is issued, until it is confirmed. ${waitingNote(approval, timeZone)}`,
        leaseId: lease.id,
      });
    } catch (failure) {
      setStatus(null);
      if (failure instanceof StorageUploadError) {
        setProblem(failure.message);
        return;
      }
      // A refused attempt recorded nothing: the photo goes again with the corrected details.
      if (outcomeOf(failure) === 'refused') uploads.forget(file);
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
    setLease(null);
    setDraft(emptyCash(today));
    if (photo.current) photo.current.value = '';
  }

  if (done)
    return (
      <Card data-testid="cash-recorded">
        <CardBody>
          <Alert tone="success" title="Recorded, waiting for confirmation">
            {done.text}
          </Alert>
          <div className="flex flex-wrap gap-2">
            <Button onClick={another}>Record more cash</Button>
            <Link href="/cash" className={secondaryLink}>
              Cash on hand
            </Link>
            {seeLease ? (
              <Link href={`/leases/${done.leaseId}`} className={secondaryLink}>
                Back to the lease
              </Link>
            ) : null}
          </div>
        </CardBody>
      </Card>
    );

  const working = status !== null;
  return (
    <form onSubmit={submit} noValidate aria-label="Record cash or cheque" className="space-y-6">
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      <Card>
        <CardHeader title="What it pays for" />
        <CardBody>
          <LeasePicker
            value={lease}
            onChange={pickLease}
            error={errors.leaseId}
            disabled={working}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="The money" />
        <CardBody className="grid gap-4 sm:grid-cols-2 sm:space-y-0">
          <SelectField
            label="Cash or cheque"
            value={draft.method}
            options={[
              { value: 'cash', label: 'Cash' },
              { value: 'cheque', label: 'Cheque' },
            ]}
            onChange={(event) =>
              set({ method: event.target.value === 'cheque' ? 'cheque' : 'cash' })
            }
          />
          <TextField
            label="Amount (GH₵)"
            inputMode="decimal"
            autoComplete="off"
            value={draft.amount}
            error={errors.amount}
            onChange={(event) => set({ amount: event.target.value })}
          />
          <TextField
            label="Date received"
            type="date"
            max={today}
            value={draft.receivedOn}
            error={errors.receivedOn}
            onChange={(event) => set({ receivedOn: event.target.value })}
          />
          <TextField
            label="Paid by"
            hint="The name of the person who handed it over."
            autoComplete="off"
            value={draft.payerName}
            error={errors.payerName}
            onChange={(event) => set({ payerName: event.target.value })}
          />
          {cheque ? (
            <>
              <TextField
                label="Cheque number"
                autoComplete="off"
                inputMode="numeric"
                value={draft.chequeNumber}
                error={errors.chequeNumber}
                onChange={(event) => set({ chequeNumber: event.target.value })}
              />
              <TextField
                label="Bank"
                hint="The bank the cheque is drawn on."
                autoComplete="off"
                value={draft.chequeBank}
                error={errors.chequeBank}
                onChange={(event) => set({ chequeBank: event.target.value })}
              />
            </>
          ) : null}
          {collectors.length ? (
            <SelectField
              label="Who holds it now"
              hint="It counts as their cash on hand until it is banked."
              value={draft.collectorPersonId}
              options={[
                { value: '', label: `Me (${me.name})` },
                ...collectors.map((c) => ({ value: c.id, label: c.name })),
              ]}
              onChange={(event) => set({ collectorPersonId: event.target.value })}
            />
          ) : (
            <p className="text-sm text-slate-700">
              It counts as your cash on hand until you bank it.
            </p>
          )}
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
              ref={photo}
              label={cheque ? 'Photo of the cheque' : 'Photo of the receipt-book page'}
              rule={CASH_PHOTO_UPLOAD}
              capture="environment"
              disabled={working}
              error={photoError}
              note={
                cheque
                  ? 'The front of the cheque, with the amount and the date readable.'
                  : 'The page you wrote the receipt on, with the amount and the date readable.'
              }
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
        <Button variant="secondary" onClick={another}>
          Start a new record
        </Button>
      ) : null}
      {tried && !working && !problem && (!parsed.input || photoError) ? (
        <p className="text-sm text-slate-600">Check the fields marked above.</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" pending={working}>
          {cheque ? 'Record the cheque' : 'Record the cash'}
        </Button>
        <Link href="/cash" className={textLink}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
