'use client';

import { useCallback, useState } from 'react';
import { Empty, Loading, LoadFailed } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { api, keyedApi } from '@/lib/api';
import { isKeyReused, moneyProblem, sendOnce, type IdempotencyKeeper } from '@/lib/idempotency';
import { useHoldWhileSending } from '@/lib/in-flight';
import { formatMinor } from '@/lib/tenancy-format';
import { confirmMatchText, reasonsOf, type Suggestion } from '@/lib/unmatched-queue';
import { useLoad } from '@/lib/use-load';
import { MatchForm, type OwnerAccount } from '../match-form';

/**
 * The leases a payment may belong to (BC-12), ranked by the API, each with the reasons it is
 * suggested. A person confirms the match (P23); nothing is matched by a click alone. Another
 * lease can still be chosen by hand. One Idempotency-Key covers this receipt's match, whichever
 * lease is chosen, so a retry after a dropped answer never matches it twice.
 */
export function SuggestionsPanel({
  paymentId,
  amountMinor,
  owner,
  keeper,
  onMatched,
  onCancel,
}: {
  readonly paymentId: string;
  readonly amountMinor: number;
  /** The owner whose account holds the money; their leases only (P23). */
  readonly owner: OwnerAccount | null;
  readonly keeper: IdempotencyKeeper;
  readonly onMatched: (unitCode: string) => void;
  /** Closes the panel, where it was opened from a list. */
  readonly onCancel?: () => void;
}) {
  const load = useCallback(() => api().paymentsQueue.suggestions({ paymentId }), [paymentId]);
  const { state, reload } = useLoad(load);
  const [chosen, setChosen] = useState<Suggestion | null>(null);
  const [byHand, setByHand] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  useHoldWhileSending(pending);
  const amount = formatMinor(amountMinor);

  async function confirm(suggestion: Suggestion) {
    setPending(true);
    setError(null);
    setReused(false);
    try {
      await sendOnce(keeper, (key) =>
        keyedApi(key).payments.match({ paymentId, leaseId: suggestion.leaseId }),
      );
      onMatched(suggestion.unitCode);
    } catch (failure) {
      setError(moneyProblem(failure));
      setReused(isKeyReused(failure));
      setPending(false);
    }
  }

  function startAgain() {
    keeper.reset();
    setChosen(null);
    setError(null);
    setReused(false);
  }

  return (
    <div
      role="group"
      aria-label={`Find the lease for ${amount}`}
      data-testid="match-suggestions"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <p className="text-sm font-medium text-slate-900">Suggested leases, most likely first</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {state.status === 'loading' ? <Loading what="suggestions" /> : null}
      {state.status === 'error' ? (
        <LoadFailed message={state.problem.message} onRetry={reload} />
      ) : null}
      {state.status === 'ready' && state.data.length === 0 ? (
        <Empty>
          Nothing points to a lease: no open amount, phone, date or earlier payment matches. Choose
          the lease by hand, or ask to refund it to the payer.
        </Empty>
      ) : null}
      {state.status === 'ready' && state.data.length ? (
        <ol className="space-y-2">
          {state.data.map((suggestion, index) => (
            <li
              key={suggestion.leaseId}
              data-testid="match-suggestion"
              className="space-y-2 rounded-md border border-slate-200 bg-white p-3 text-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    <span className="text-slate-600">{index + 1}. </span>
                    <span className="font-mono">{suggestion.unitCode}</span> ·{' '}
                    {suggestion.tenantName}
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-700">
                    {reasonsOf(suggestion).map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </div>
                {chosen?.leaseId !== suggestion.leaseId ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    onClick={() => {
                      setByHand(false);
                      setChosen(suggestion);
                    }}
                  >
                    Match to {suggestion.unitCode}
                  </Button>
                ) : null}
              </div>
              {chosen?.leaseId === suggestion.leaseId ? (
                <div
                  role="group"
                  aria-label={`Confirm the match to ${suggestion.unitCode}`}
                  className="space-y-2 rounded-md border border-sky-200 bg-sky-50 p-3"
                >
                  <p className="text-sky-900">{confirmMatchText(amount, suggestion)}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" pending={pending} onClick={() => void confirm(suggestion)}>
                      Confirm the match
                    </Button>
                    {reused ? (
                      <Button size="sm" variant="secondary" onClick={startAgain}>
                        Start again
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => setChosen(null)}
                    >
                      Not this one
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {byHand ? (
        <MatchForm
          paymentId={paymentId}
          owner={owner}
          keeper={keeper}
          onMatched={(_payment, lease) => onMatched(lease.unitCode)}
          onCancel={() => setByHand(false)}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              setChosen(null);
              setByHand(true);
            }}
          >
            Choose another lease
          </Button>
          {onCancel ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
              Close
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
