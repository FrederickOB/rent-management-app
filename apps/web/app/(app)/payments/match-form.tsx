'use client';

import type { PaymentDetail } from '@rent/contracts';
import { useState, type FormEvent } from 'react';
import { LeasePicker } from '@/components/lease-picker';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { keyedApi } from '@/lib/api';
import {
  moneyProblem,
  sendOnce,
  useIdempotencyKeeper,
  type IdempotencyKeeper,
} from '@/lib/idempotency';
import type { PickedLease } from '@/lib/lease-pick';

/**
 * Matches money that arrived before anyone knew its lease (P23): the suspense clears and the
 * money is allocated to the lease's oldest debt first. The request carries an Idempotency-Key, so
 * a retry after a dropped answer never matches it twice.
 */
export function MatchForm({
  paymentId,
  keeper: given,
  onMatched,
  onCancel,
}: {
  readonly paymentId: string;
  /** The page's keeper for this receipt, so reopening the form keeps the key. */
  readonly keeper?: IdempotencyKeeper;
  readonly onMatched: (payment: PaymentDetail, lease: PickedLease) => void;
  readonly onCancel?: () => void;
}) {
  const own = useIdempotencyKeeper();
  const keeper = given ?? own;
  const [lease, setLease] = useState<PickedLease | null>(null);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (!lease) return;
    setPending(true);
    try {
      const payment = await sendOnce(keeper, (key) =>
        keyedApi(key).payments.match({ paymentId, leaseId: lease.id }),
      );
      onMatched(payment, lease);
    } catch (failure) {
      setError(moneyProblem(failure));
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Match to a lease"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <LeasePicker
        label="The lease it pays for"
        value={lease}
        onChange={setLease}
        error={tried && !lease ? 'Choose the lease' : null}
        disabled={pending}
      />
      <p className="text-sm text-slate-700">
        It pays the lease’s oldest debt first; anything left over is held as the tenant’s credit.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Match it
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
