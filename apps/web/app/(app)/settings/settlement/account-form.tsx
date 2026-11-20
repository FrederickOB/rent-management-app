'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { Loading, LoadFailed } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SelectField, TextField } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { isKeyReused, moneyProblem, sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { useHoldWhileSending } from '@/lib/in-flight';
import { waitingNote } from '@/lib/money-requests';
import {
  emptySettlementDraft,
  forOneOwner,
  nameCheck,
  SETTLEMENT_LIMITS,
  settlementForm,
  type AccountHolder,
  type SettlementDraft,
} from '@/lib/settlement';
import { useLoad } from '@/lib/use-load';

/**
 * Asks to add a bank account rent settles into (ADR-008). Nothing changes until a second person
 * approves it; it takes rent 24 hours after that, and the owner is told by SMS and email. The
 * provider checks the name on the account where it can, and the approver sees what it said. The
 * request carries an Idempotency-Key, so sending it again after a dropped answer asks once.
 */
export function AccountRequestForm({
  companyKind,
  canChangeAgency,
  owners,
  onDone,
  onCancel,
}: {
  readonly companyKind: 'landlord' | 'agency' | 'platform';
  /** The agency's own client account needs `settlement_account.change_agency` (M11). */
  readonly canChangeAgency: boolean;
  readonly owners: readonly { readonly id: string; readonly label: string }[];
  readonly onDone: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const { timeZone } = useApp();
  const agency = companyKind === 'agency';
  const keeper = useIdempotencyKeeper();
  const loadBanks = useCallback(() => api().settlement.banks(), []);
  const banks = useLoad(loadBanks);
  // A landlord's rent goes to their own account: with one owner record, it is chosen already.
  const [draft, setDraft] = useState<SettlementDraft>(() => ({
    ...emptySettlementDraft(agency ? '' : 'owner'),
    ownerId: !agency && owners.length === 1 ? (owners[0]?.id ?? '') : '',
  }));
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const parsed = settlementForm(draft, { agency });
  const errors = tried ? parsed.errors : {};
  const set = (patch: Partial<SettlementDraft>) => setDraft((d) => ({ ...d, ...patch }));
  useHoldWhileSending(pending);

  useEffect(() => {
    form.current?.querySelector<HTMLElement>('select, input')?.focus();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    setReused(false);
    const input = parsed.input;
    if (!input) return;
    setPending(true);
    try {
      const { account, approval } = await sendOnce(keeper, (key) =>
        keyedApi(key).settlement.request(input),
      );
      const check = nameCheck(account);
      onDone(
        [
          `Asked to add ${account.bankName} ${account.numberMasked}.`,
          waitingNote(approval, timeZone),
          'Once approved it takes rent 24 hours later, and the owner is told by SMS and email.',
          check.kind === 'matches' ? '' : check.text,
        ]
          .filter(Boolean)
          .join(' '),
      );
    } catch (failure) {
      setError(moneyProblem(failure));
      setReused(isKeyReused(failure));
      setPending(false);
    }
  }

  function startAgain() {
    keeper.reset();
    setDraft(emptySettlementDraft(agency ? '' : 'owner'));
    setTried(false);
    setError(null);
    setReused(false);
  }

  const holderOptions: { value: AccountHolder | ''; label: string }[] = agency
    ? [
        { value: '', label: 'Choose whose account' },
        { value: 'owner', label: 'An owner’s own account' },
        ...(canChangeAgency
          ? [{ value: 'agency' as const, label: 'The agency’s client account' }]
          : []),
      ]
    : [{ value: 'owner', label: 'Your own account' }];

  return (
    <form
      ref={form}
      onSubmit={submit}
      noValidate
      aria-label="Add a bank account"
      className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <p className="text-sm text-slate-700">
        A second person must approve the account. It takes rent 24 hours after that, and the owner
        is told by SMS and email, so nobody can redirect rent quietly.
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {agency ? (
          <SelectField
            label="Whose account"
            value={draft.holder}
            error={errors.holder}
            disabled={pending}
            options={holderOptions}
            onChange={(event) => {
              const holder = holderOptions.find((o) => o.value === event.target.value)?.value;
              if (holder !== undefined)
                set({ holder, ownerId: forOneOwner(holder) ? draft.ownerId : '' });
            }}
          />
        ) : null}
        {forOneOwner(draft.holder) && (agency || owners.length !== 1) ? (
          <SelectField
            label="The owner"
            value={draft.ownerId}
            error={errors.ownerId}
            disabled={pending}
            options={[
              { value: '', label: owners.length ? 'Choose the owner' : 'No owners to choose from' },
              ...owners.map((o) => ({ value: o.id, label: o.label })),
            ]}
            onChange={(event) => set({ ownerId: event.target.value })}
          />
        ) : null}
        {banks.state.status === 'ready' ? (
          <SelectField
            label="Bank"
            value={draft.bankCode}
            error={errors.bankCode}
            disabled={pending}
            options={[
              { value: '', label: 'Choose the bank' },
              ...banks.state.data.map((b) => ({ value: b.code, label: b.name })),
            ]}
            onChange={(event) => set({ bankCode: event.target.value })}
          />
        ) : (
          <div className="space-y-1">
            {banks.state.status === 'loading' ? <Loading what="banks" /> : null}
            {banks.state.status === 'error' ? (
              <LoadFailed message={banks.state.problem.message} onRetry={banks.reload} />
            ) : null}
          </div>
        )}
        <TextField
          label="Branch (optional)"
          autoComplete="off"
          maxLength={SETTLEMENT_LIMITS.branchMax}
          value={draft.branch}
          error={errors.branch}
          disabled={pending}
          onChange={(event) => set({ branch: event.target.value })}
        />
        <TextField
          label="Account number"
          hint="Digits only. It is stored encrypted; afterwards only the last four digits are shown."
          inputMode="numeric"
          autoComplete="off"
          value={draft.accountNumber}
          error={errors.accountNumber}
          disabled={pending}
          onChange={(event) => set({ accountNumber: event.target.value })}
        />
        <TextField
          label="Name on the account"
          hint="As the bank has it. The payment provider checks it where it can."
          autoComplete="off"
          maxLength={SETTLEMENT_LIMITS.nameMax}
          value={draft.accountName}
          error={errors.accountName}
          disabled={pending}
          onChange={(event) => set({ accountName: event.target.value })}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Ask to add the account
        </Button>
        {reused ? (
          <Button variant="secondary" onClick={startAgain}>
            Start again
          </Button>
        ) : null}
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
