'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { FileField } from '@/components/file-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextAreaField } from '@/components/ui/field';
import { keyedApi } from '@/lib/api';
import { isKeyReused, moneyProblem, sendOnce, type IdempotencyKeeper } from '@/lib/idempotency';
import { useHoldWhileSending } from '@/lib/in-flight';
import { waitingNote } from '@/lib/money-requests';
import {
  fileAgainMessage,
  needsFileAgain,
  PAYMENT_PROOF_UPLOAD,
  uploadOnce,
} from '@/lib/payment-upload';
import { formatMinor } from '@/lib/tenancy-format';
import {
  REFUND_REASON,
  refundForm,
  refundsThroughProvider,
  type UnmatchedRow,
} from '@/lib/unmatched-queue';
import { fileProblem, StorageUploadError } from '@/lib/upload';

/**
 * Asks to refund money that belongs to no lease to the person who paid it (P31; plan 4.5). A
 * second person approves it. Money that came through the payment provider goes back through
 * the provider's refund; a transfer is sent back outside the platform and recorded here with
 * the proof. The request keeps one Idempotency-Key and one upload until it is answered.
 */
export function RefundForm({
  row,
  keeper,
  onAsked,
  onCancel,
}: {
  readonly row: UnmatchedRow;
  readonly keeper: IdempotencyKeeper;
  readonly onAsked: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const { timeZone } = useApp();
  const viaProvider = refundsThroughProvider(row.receivedInto);
  const [uploads] = useState(() => uploadOnce());
  const proof = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const working = status !== null;
  useHoldWhileSending(working);
  const amount = formatMinor(row.amountMinor);

  useEffect(() => {
    form.current?.querySelector<HTMLElement>('textarea')?.focus();
  }, []);

  const parsed = refundForm({ reason }, { needsProof: !viaProvider, hasProof: true });
  const reasonError = tried ? parsed.errors.reason : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    setReused(false);
    const file = proof.current?.files?.[0];
    const checked = refundForm({ reason }, { needsProof: !viaProvider, hasProof: Boolean(file) });
    const fileError =
      checked.errors.proof ?? (file ? fileProblem(file, PAYMENT_PROOF_UPLOAD) : null);
    setProofError(viaProvider ? null : fileError);
    const why = checked.reason;
    if (!why || (!viaProvider && fileError)) return;
    try {
      let proofUploadId: string | null = null;
      if (!viaProvider && file) {
        setStatus('Uploading the proof…');
        proofUploadId = await uploads.idFor(file, 'transfer_proof');
      }
      setStatus('Asking for the refund…');
      const { approval } = await sendOnce(keeper, (key) =>
        keyedApi(key).paymentsQueue.refund({
          paymentId: row.paymentId,
          reason: why,
          proofUploadId,
        }),
      );
      setStatus(null);
      onAsked(
        `Asked to refund ${amount} to the payer. ${waitingNote(approval, timeZone)} ${
          viaProvider
            ? 'Once approved, it goes back through the payment provider.'
            : 'Once approved, the refund is recorded and the money leaves the unmatched receipts.'
        }`,
      );
    } catch (failure) {
      setStatus(null);
      if (failure instanceof StorageUploadError) {
        setError(failure.message);
        return;
      }
      if (needsFileAgain(failure) && file) {
        uploads.forget(file);
        if (proof.current) proof.current.value = '';
        setProofError(fileAgainMessage('proof'));
        setError(fileAgainMessage('proof'));
        return;
      }
      setError(moneyProblem(failure));
      setReused(isKeyReused(failure));
    }
  }

  function startAgain() {
    keeper.reset();
    setReason('');
    setTried(false);
    setError(null);
    setProofError(null);
    setReused(false);
    if (proof.current) proof.current.value = '';
  }

  return (
    <form
      ref={form}
      onSubmit={submit}
      noValidate
      aria-label={`Refund ${amount} to the payer`}
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <p className="text-sm font-medium text-slate-900">Refund {amount} to the payer</p>
      <p className="text-sm text-slate-700">
        {viaProvider
          ? 'For money that belongs to no lease. Once a second person approves, it goes back to the payer through the payment provider.'
          : 'For money that belongs to no lease. Send it back from the account it arrived in, then record the refund here with the proof. It is recorded once a second person approves.'}
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <TextAreaField
        label="Why it is refunded"
        hint={`At least ${REFUND_REASON.min} characters. The second person reads it before deciding.`}
        rows={2}
        maxLength={REFUND_REASON.max}
        value={reason}
        error={reasonError}
        disabled={working}
        onChange={(event) => setReason(event.target.value)}
        className="[&_textarea]:font-sans"
      />
      {viaProvider ? null : (
        <FileField
          ref={proof}
          label="Proof the money was sent back"
          rule={PAYMENT_PROOF_UPLOAD}
          disabled={working}
          error={proofError}
        />
      )}
      {status ? (
        <p role="status" className="text-sm text-slate-700">
          {status}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={working}>
          Ask for the refund
        </Button>
        {reused ? (
          <Button variant="secondary" onClick={startAgain}>
            Start again
          </Button>
        ) : null}
        <Button variant="ghost" disabled={working} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
