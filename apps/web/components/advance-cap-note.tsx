'use client';

import type { AdvanceRefusal } from '@/lib/advance-refusal';
import { amountInput } from '@/lib/lease-form';
import { formatMinor } from '@/lib/tenancy-format';
import { Button } from './ui/button';

/**
 * Beside the amount, after the API refused an advance over the limit (AR-05 under `block`): the
 * most this payment can be, and a button to record that instead. The reason is announced once,
 * at the top of the form.
 */
export function AdvanceCapNote({
  refusal,
  onUse,
}: {
  readonly refusal: AdvanceRefusal;
  /** Puts the most allowed in the amount box, as cedis text. */
  readonly onUse: (amount: string) => void;
}) {
  return (
    <div className="space-y-2 sm:col-span-2" data-testid="advance-cap">
      <p className="text-sm font-medium text-amber-900">
        {refusal.maxMinor > 0
          ? `Your company’s advance rent setting allows at most ${formatMinor(refusal.maxMinor)} for this lease now.`
          : 'Your company’s advance rent setting allows nothing more ahead for this lease now.'}
      </p>
      {refusal.maxMinor > 0 ? (
        <Button size="sm" variant="secondary" onClick={() => onUse(amountInput(refusal.maxMinor))}>
          Use {formatMinor(refusal.maxMinor)}
        </Button>
      ) : null}
    </div>
  );
}
