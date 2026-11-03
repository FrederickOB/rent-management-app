'use client';

import { RECEIVING_ACCOUNTS } from '@rent/contracts';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { CancelLink } from '@/components/cancel-link';
import { FileField } from '@/components/file-field';
import { LeasePicker } from '@/components/lease-picker';
import { secondaryLink } from '@/components/link-styles';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { RECEIVING_ACCOUNT_LABELS, type ReceivingAccount } from '@/lib/billing-format';
import { todayIn } from '@/lib/business-dates';
import { isKeyReused, moneyProblem, sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { useHoldWhileSending } from '@/lib/in-flight';
import type { PickedLease } from '@/lib/lease-pick';
import { waitingNote } from '@/lib/money-requests';
import {
  emptyTransfer,
  referenceCheck,
  transferForm,
  type TransferDraft,
} from '@/lib/payment-form';
import {
  fileAgainMessage,
  needsFileAgain,
  PAYMENT_PROOF_UPLOAD,
  uploadOnce,
} from '@/lib/payment-upload';
import { formatMinor } from '@/lib/tenancy-format';
import { fileProblem, StorageUploadError } from '@/lib/upload';

interface Done {
  readonly text: string;
  readonly leaseId: string | null;
}

/**
 * The transfer form (P28, P23). The proof goes straight to storage; the record then waits for a
 * second person. The submission keeps one Idempotency-Key and one upload until it is answered,
 * so sending it again after a dropped connection never records the money twice.
 */
export function TransferForm({
  initialLease,
  owners,
  agency,
}: {
  readonly initialLease: PickedLease | null;
  readonly owners: readonly { readonly id: string; readonly label: string }[];
  /** An agency's money can go to its own account too; a landlord's goes to their own. */
  readonly agency: boolean;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const keeper = useIdempotencyKeeper();
  const [uploads] = useState(() => uploadOnce());
  const proof = useRef<HTMLInputElement>(null);
  const [lease, setLease] = useState<PickedLease | null>(initialLease);
  const [draft, setDraft] = useState<TransferDraft>(() =>
    emptyTransfer(today, { leaseId: initialLease?.id ?? null, agency }),
  );
  const [leaseReference, setLeaseReference] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The first attempt was recorded with other details: offer a fresh form, never a silent retry.
  const [reused, setReused] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  // The chosen lease's payment reference, to check the one on the transfer against it (BC-03).
  useEffect(() => {
    let current = true;
    setLeaseReference(null);
    if (lease)
      void api()
        .invoices.leaseBilling({ leaseId: lease.id })
        .then(
          (billing) => {
            if (current) setLeaseReference(billing.paymentReference);
          },
          () => undefined,
        );
    return () => {
      current = false;
    };
  }, [lease]);

  const parsed = transferForm({ ...draft, leaseId: lease?.id ?? null }, today);
  const errors = tried ? parsed.errors : {};
  const check = referenceCheck(draft.senderReference, leaseReference);
  const set = (patch: Partial<TransferDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const working = status !== null;
  useHoldWhileSending(working);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setProblem(null);
    setReused(false);
    const file = proof.current?.files?.[0];
    const fileError = file
      ? fileProblem(file, PAYMENT_PROOF_UPLOAD)
      : 'Attach the proof of the transfer.';
    setProofError(fileError);
    const input = parsed.input;
    if (!input || fileError || !file) return;
    try {
      setStatus('Uploading the proof…');
      const proofUploadId = await uploads.idFor(file, 'transfer_proof');
      setStatus('Recording the transfer…');
      const { approval } = await sendOnce(keeper, (key) =>
        keyedApi(key).payments.recordTransfer({ ...input, proofUploadId }),
      );
      setStatus(null);
      setDone({
        text: lease
          ? `Recorded ${formatMinor(input.amountMinor)} for ${lease.unitCode}. ${waitingNote(approval, timeZone)}`
          : `Recorded ${formatMinor(input.amountMinor)} with no lease yet. ${waitingNote(approval, timeZone)} Then it waits in Unmatched receipts until someone matches it to a lease.`,
        leaseId: lease?.id ?? null,
      });
    } catch (failure) {
      setStatus(null);
      if (failure instanceof StorageUploadError) {
        setProblem(failure.message);
        return;
      }
      // The upload itself was refused (expired or missing): the proof must be chosen again. For
      // anything else the same upload is sent again, which the API accepts.
      if (needsFileAgain(failure)) {
        uploads.forget(file);
        if (proof.current) proof.current.value = '';
        setProofError(fileAgainMessage('proof'));
        setProblem(fileAgainMessage('proof'));
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
    setProofError(null);
    setLease(null);
    setDraft(emptyTransfer(today, { agency }));
    if (proof.current) proof.current.value = '';
  }

  if (done)
    return (
      <Card data-testid="transfer-recorded">
        <CardBody>
          <Alert tone="success" title="Recorded, waiting for confirmation">
            {done.text}
          </Alert>
          <div className="flex flex-wrap gap-2">
            <Button onClick={another}>Record another transfer</Button>
            {done.leaseId ? (
              <Link href={`/leases/${done.leaseId}`} className={secondaryLink}>
                Back to the lease
              </Link>
            ) : (
              <Link href="/payments/unmatched" className={secondaryLink}>
                Unmatched receipts
              </Link>
            )}
          </div>
        </CardBody>
      </Card>
    );

  const needsOwner = !lease && draft.receivedInto === 'owner_account';
  return (
    <form onSubmit={submit} noValidate aria-label="Record a transfer" className="space-y-6">
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      <Card>
        <CardHeader
          title="What it pays for"
          description="Choose the lease if you know it. If you do not, it waits as an unmatched receipt for someone to match later."
        />
        <CardBody>
          <LeasePicker
            value={lease}
            onChange={setLease}
            optional="I do not know the lease yet"
            disabled={working}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="The transfer" />
        <CardBody className="grid gap-4 sm:grid-cols-2 sm:space-y-0">
          {agency ? (
            <SelectField
              label="Which account it went into"
              value={draft.receivedInto}
              error={errors.receivedInto}
              options={[
                { value: '', label: 'Choose the account' },
                ...RECEIVING_ACCOUNTS.map((a) => ({
                  value: a,
                  label: RECEIVING_ACCOUNT_LABELS[a],
                })),
              ]}
              onChange={(event) =>
                set({
                  receivedInto:
                    RECEIVING_ACCOUNTS.find(
                      (a): a is ReceivingAccount => a === event.target.value,
                    ) ?? '',
                })
              }
            />
          ) : (
            <p className="text-sm text-slate-700">
              Into your own account. Rent settles straight to you; the platform never holds it.
            </p>
          )}
          {needsOwner ? (
            <SelectField
              label="Whose account"
              value={draft.ownerId}
              error={errors.ownerId}
              options={[
                {
                  value: '',
                  label: owners.length ? 'Choose the owner' : 'No owners to choose from',
                },
                ...owners.map((o) => ({ value: o.id, label: o.label })),
              ]}
              onChange={(event) => set({ ownerId: event.target.value })}
            />
          ) : null}
          <TextField
            label="Amount (GH₵)"
            inputMode="decimal"
            autoComplete="off"
            value={draft.amount}
            error={errors.amount}
            onChange={(event) => set({ amount: event.target.value })}
          />
          <TextField
            label="Date it arrived"
            type="date"
            max={today}
            value={draft.receivedOn}
            error={errors.receivedOn}
            onChange={(event) => set({ receivedOn: event.target.value })}
          />
          <div className="space-y-2 sm:col-span-2">
            <TextField
              label="Sender’s reference (optional)"
              hint="As it appears on the statement or the mobile money message."
              autoComplete="off"
              spellCheck={false}
              value={draft.senderReference}
              error={errors.senderReference}
              onChange={(event) => set({ senderReference: event.target.value })}
            />
            {check.kind === 'matches' ? (
              <p className="text-sm text-emerald-900" data-testid="reference-check">
                This is the payment reference of the lease chosen.
              </p>
            ) : null}
            {check.kind === 'other_lease' ? (
              <Alert tone="warning">
                The reference {check.reference} is not this lease’s payment reference
                {leaseReference ? ` (${leaseReference})` : ''}. Check the lease before recording it.
              </Alert>
            ) : null}
          </div>
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
              ref={proof}
              label="Proof of the transfer"
              rule={PAYMENT_PROOF_UPLOAD}
              disabled={working}
              error={proofError}
              note="A screenshot of the confirmation, a photo of the slip, or the statement line."
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
          Start again
        </Button>
      ) : null}
      {tried && !working && !problem && (!parsed.input || proofError) ? (
        <p className="text-sm text-slate-600">Check the fields marked above.</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" pending={working}>
          Record the transfer
        </Button>
        <CancelLink href={lease ? `/leases/${lease.id}` : '/payments'} disabled={working} />
      </div>
    </form>
  );
}
