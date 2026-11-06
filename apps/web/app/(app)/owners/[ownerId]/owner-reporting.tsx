'use client';

import type { FeeTermsView, OwnerRow } from '@rent/contracts';
import { FEE_KINDS, GRA_PAYERS } from '@rent/domain/ledger';
import Link from 'next/link';
import { useCallback, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { secondaryLink } from '@/components/link-styles';
import { LoadFailed, Loading } from '@/components/load-state';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { todayIn } from '@/lib/business-dates';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { toProblem } from '@/lib/errors';
import {
  draftOfTerms,
  FEE_KIND_LABELS,
  feeKindOf,
  feeTermsInput,
  feeTermsMessage,
  GRA_PAYER_LABELS,
  graPayerOf,
  termsFrom,
  termsText,
  type FeeTermsDraft,
} from '@/lib/fee-terms';
import { useLoad } from '@/lib/use-load';

export interface OwnerReportingPermissions {
  readonly reporting: boolean;
  readonly fees: boolean;
  readonly changeFees: boolean;
  readonly seeApprovals: boolean;
}

export function OwnerReporting({
  ownerId,
  can,
}: {
  readonly ownerId: string;
  readonly can: OwnerReportingPermissions;
}) {
  const load = useCallback(() => api().owners.get({ ownerId }), [ownerId]);
  const { state, reload } = useLoad(load);
  const owner: OwnerRow | null = state.status === 'ready' ? state.data : null;
  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/owners" className="underline underline-offset-2">
          Owners
        </Link>{' '}
        <span aria-hidden="true">›</span> <span>{owner?.displayName ?? 'Owner'}</span>
      </nav>
      <PageHeader
        title={owner ? `${owner.displayName} (${owner.reference})` : 'Owner'}
        description={
          owner ? `Times on this owner’s statements are in ${owner.timeZone}.` : undefined
        }
      />
      {state.status === 'loading' ? <Loading what="the owner" /> : null}
      {state.status === 'error' ? (
        state.problem.status === 404 ? (
          <Alert tone="info">This owner does not exist, or is not one you can see.</Alert>
        ) : (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        )
      ) : null}
      {owner && can.reporting ? (
        <div className="flex flex-wrap gap-2">
          <Link href={`/statements?ownerId=${owner.id}`} className={secondaryLink}>
            Statements
          </Link>
          <Link href={`/owner-money?ownerId=${owner.id}`} className={secondaryLink}>
            Remittances
          </Link>
        </div>
      ) : null}
      {owner && can.fees ? <FeeTermsCard ownerId={owner.id} can={can} /> : null}
      {owner && !can.fees ? (
        <p className="text-sm text-slate-600">
          Management fees apply only to owners whose properties an agency manages.
        </p>
      ) : null}
    </>
  );
}

/** The fee terms (AC-02): in force, approved for later, waiting, and the change form. */
function FeeTermsCard({
  ownerId,
  can,
}: {
  readonly ownerId: string;
  readonly can: OwnerReportingPermissions;
}) {
  const load = useCallback(() => api().feeTerms.get({ ownerId }), [ownerId]);
  const { state, reload } = useLoad(load);
  const [changing, setChanging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <Card data-testid="fee-terms">
      <CardHeader
        title="Management fee and rent tax"
        description="Each change is a new version from a date, approved by a second person. Receipts before it keep the terms then in force."
      />
      <CardBody>
        {notice ? (
          <Alert tone="success">
            {notice}{' '}
            {can.seeApprovals ? (
              <Link href="/approvals" className="font-medium underline underline-offset-2">
                Open Approvals
              </Link>
            ) : null}
          </Alert>
        ) : null}
        {state.status === 'loading' ? <Loading what="the fee terms" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' ? (
          <>
            <dl className="space-y-2 text-sm">
              <div data-testid="fee-terms-current">
                <dt className="text-slate-600">In force</dt>
                <dd className="font-medium">
                  {state.data.current
                    ? `${termsText(state.data.current)}, ${termsFrom(state.data.current)}`
                    : 'None set: no management fee, and the owner pays GRA'}
                </dd>
              </div>
              {state.data.upcoming.map((t) => (
                <div key={t.effectiveFrom} data-testid="fee-terms-upcoming">
                  <dt className="text-slate-600">Approved, taking effect later</dt>
                  <dd>
                    {termsText(t)}, {termsFrom(t)}
                  </dd>
                </div>
              ))}
              {state.data.pending ? (
                <div data-testid="fee-terms-pending">
                  <dt className="flex items-center gap-2 text-slate-600">
                    <Badge tone="blue">Waiting for a second person</Badge>
                  </dt>
                  <dd>
                    {termsText(state.data.pending.terms)}, {termsFrom(state.data.pending.terms)}
                  </dd>
                </div>
              ) : null}
            </dl>
            {can.changeFees && !state.data.pending && !changing ? (
              <Button variant="secondary" onClick={() => setChanging(true)}>
                Change the terms
              </Button>
            ) : null}
            {changing ? (
              <FeeTermsForm
                ownerId={ownerId}
                current={state.data.current}
                onDone={(text) => {
                  setChanging(false);
                  setNotice(text);
                  reload();
                }}
                onCancel={() => setChanging(false)}
              />
            ) : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

function FeeTermsForm({
  ownerId,
  current,
  onDone,
  onCancel,
}: {
  readonly ownerId: string;
  readonly current: FeeTermsView | null;
  readonly onDone: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const tomorrow = toIsoDate(addDays(parseBusinessDate(today), 1));
  const [draft, setDraft] = useState<FeeTermsDraft>(() => draftOfTerms(current, tomorrow));
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = feeTermsInput(draft, today);
  const errors = tried ? parsed.errors : {};

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    const input = parsed.input;
    if (!input) return;
    setPending(true);
    try {
      await api().feeTerms.request({ ownerId, ...input });
      onDone(
        'Asked to change the terms. A second person must approve it; you cannot approve your own request.',
      );
    } catch (failure) {
      setError(feeTermsMessage(failure) ?? toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Change the fee terms"
      className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <SelectField
        label="Fee"
        value={draft.kind}
        error={errors.kind}
        options={[
          { value: '', label: 'Choose the kind of fee' },
          ...FEE_KINDS.map((k) => ({ value: k, label: FEE_KIND_LABELS[k] })),
        ]}
        onChange={(event) => setDraft((d) => ({ ...d, kind: feeKindOf(event.target.value) ?? '' }))}
      />
      {draft.kind === 'percentage' ? (
        <TextField
          label="Rate (%)"
          inputMode="decimal"
          autoComplete="off"
          value={draft.percent}
          error={errors.percent}
          hint="Of rent and service charge settled, advances and tax withheld included, deposits not. Stored in basis points: 8% is 800."
          onChange={(event) => setDraft((d) => ({ ...d, percent: event.target.value }))}
          className="max-w-xs"
        />
      ) : null}
      {draft.kind === 'fixed_per_unit' ? (
        <TextField
          label="Per billable unit per month (GH₵)"
          inputMode="decimal"
          autoComplete="off"
          value={draft.fixed}
          error={errors.fixed}
          hint="A unit is billable in a month if it had an active lease on any day of it."
          onChange={(event) => setDraft((d) => ({ ...d, fixed: event.target.value }))}
          className="max-w-xs"
        />
      ) : null}
      <SelectField
        label="Who pays the owner’s rent tax to GRA"
        value={draft.graPaidBy}
        error={errors.graPaidBy}
        options={[
          { value: '', label: 'Choose' },
          ...GRA_PAYERS.map((p) => ({ value: p, label: GRA_PAYER_LABELS[p] })),
        ]}
        onChange={(event) =>
          setDraft((d) => ({ ...d, graPaidBy: graPayerOf(event.target.value) ?? '' }))
        }
      />
      <TextField
        label={`Takes effect on (${timeZone})`}
        type="date"
        min={today}
        value={draft.effectiveFrom}
        error={errors.effectiveFrom}
        onChange={(event) => setDraft((d) => ({ ...d, effectiveFrom: event.target.value }))}
        className="max-w-xs"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Ask for approval
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
