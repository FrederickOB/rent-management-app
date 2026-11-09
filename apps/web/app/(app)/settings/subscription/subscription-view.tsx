'use client';

import type { SubscriptionView as Subscription } from '@rent/contracts';
import type { SubscriptionTier } from '@rent/domain/settings';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { ConfirmBox } from '@/components/confirm-box';
import { LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { SubscriptionStatusBadge } from '@/components/subscription-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextAreaField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { startDownload } from '@/lib/browser-files';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { bpsText } from '@/lib/reporting';
import { monthLabel } from '@/lib/rent-tax';
import {
  bandRows,
  cancelConfirmText,
  cancellationText,
  COMING_SOON,
  ESTIMATE_NOTE,
  firstOfNextMonth,
  lastDayOfMonth,
  minimumText,
  PLACEHOLDER_PRICE_TEXT,
  rateText,
  READ_ONLY_TEXT,
  subscriptionMessage,
  tierChangeText,
  tierLabel,
  TIERS,
  totalUnits,
  trialText,
} from '@/lib/subscription';
import { formatMinor } from '@/lib/tenancy-format';
import { useLoad } from '@/lib/use-load';
import { BillingHistory } from './billing-history';
import { PayForm } from './pay-form';
import { SupportAccess } from './support-access';

const problemText = (failure: unknown): string =>
  subscriptionMessage(failure) ?? toProblem(failure).message;

export function SubscriptionView({ canGrantSupport }: { readonly canGrantSupport: boolean }) {
  const { timeZone } = useApp();
  const load = useCallback(() => api().subscription.get(), []);
  const { state, reload } = useLoad(load);
  const [history, setHistory] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const changed = useCallback(
    (text: string) => {
      setNotice(text);
      reload();
      setHistory((v) => v + 1);
    },
    [reload],
  );

  if (state.status === 'loading') return <Loading what="the subscription" />;
  if (state.status === 'error')
    return <LoadFailed message={state.problem.message} onRetry={reload} />;
  const view = state.data;
  const today = todayIn(timeZone);

  return (
    <>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Overview view={view} today={today} />
      <Estimate view={view} />
      {view.actions.pay || view.actions.payAnnual ? (
        <PayForm
          canPayInvoices={view.actions.pay}
          canPayAnnual={view.actions.payAnnual}
          owedMinor={view.arrears?.pastDueMinor ?? null}
          onPaid={(text) => changed(text)}
        />
      ) : null}
      <BillingHistory version={history} />
      <PlanCard view={view} today={today} onChanged={changed} />
      {canGrantSupport ? <SupportAccess /> : null}
      <EndCard view={view} today={today} onChanged={changed} />
    </>
  );
}

function Overview({ view, today }: { readonly view: Subscription; readonly today: string }) {
  return (
    <Card data-testid="subscription-overview">
      <CardHeader title="Your plan" />
      <CardBody className="space-y-3">
        <p className="flex flex-wrap items-center gap-2 text-sm text-slate-800">
          <span className="text-lg font-semibold text-slate-900" data-testid="subscription-tier">
            {tierLabel(view.tier)}
          </span>
          <span data-testid="subscription-status">
            <SubscriptionStatusBadge status={view.status} />
          </span>
        </p>
        {view.access === 'read_only' ? (
          <Alert tone="error" title="Read-only for staff">
            {READ_ONLY_TEXT}
          </Alert>
        ) : null}
        {view.status === 'trialing' && view.trialEndsOn ? (
          <p className="text-sm text-slate-700" data-testid="subscription-trial">
            {trialText(view.trialEndsOn, today)}
          </p>
        ) : null}
        {view.arrears ? (
          <p className="text-sm font-medium text-amber-900" data-testid="subscription-arrears">
            Past due: {formatMinor(view.arrears.pastDueMinor)}, the oldest due on{' '}
            {formatBusinessDate(view.arrears.oldestDueOn)}.
            {view.readOnlyFrom && view.access !== 'read_only'
              ? ` Staff can only read records from ${formatBusinessDate(view.readOnlyFrom)} if it stays unpaid. Tenants are never affected.`
              : ''}
          </p>
        ) : null}
        {view.pendingTier ? (
          <p className="text-sm text-slate-700" data-testid="subscription-pending-tier">
            Moves to {tierLabel(view.pendingTier.tier)} on{' '}
            {formatBusinessDate(view.pendingTier.from)}. You keep {tierLabel(view.tier)}’s features
            until then.
          </p>
        ) : null}
        {view.cancelsOn ? (
          <p className="text-sm text-slate-700" data-testid="subscription-cancels">
            {view.readOnlyUntil
              ? cancellationText({ endsOn: view.cancelsOn, readAccessUntil: view.readOnlyUntil })
              : cancelConfirmText(view.cancelsOn)}
          </p>
        ) : null}
        {view.status === 'cancelled' && view.readOnlyUntil ? (
          <p className="text-sm text-slate-700">
            The subscription has ended. Staff can read records and download documents until{' '}
            {formatBusinessDate(view.readOnlyUntil)}.
          </p>
        ) : null}
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {view.annual ? (
            <div data-testid="subscription-annual">
              <dt className="text-slate-600">Paid a year ahead</dt>
              <dd className="text-slate-900">
                {formatBusinessDate(view.annual.startsOn)} to{' '}
                {formatBusinessDate(view.annual.endsOn)}, at {bpsText(view.annual.discountBps)} off;{' '}
                {formatMinor(view.annual.creditMinor)} of credit left
              </dd>
            </div>
          ) : null}
          {view.creditMinor > 0 ? (
            <div>
              <dt className="text-slate-600">Prepaid credit</dt>
              <dd className="text-slate-900">{formatMinor(view.creditMinor)}</dd>
            </div>
          ) : null}
          {view.discount ? (
            <div data-testid="subscription-discount">
              <dt className="text-slate-600">Discount code {view.discount.code}</dt>
              <dd className="text-slate-900">
                {view.discount.description}; {view.discount.monthsLeft}{' '}
                {view.discount.monthsLeft === 1 ? 'month' : 'months'} left
              </dd>
            </div>
          ) : null}
        </dl>
      </CardBody>
    </Card>
  );
}

function Estimate({ view }: { readonly view: Subscription }) {
  const { estimate } = view;
  return (
    <Card data-testid="subscription-estimate">
      <CardHeader title={`This month so far: ${monthLabel(estimate.month)}`} />
      <CardBody className="space-y-3">
        <p className="text-sm text-slate-700">{ESTIMATE_NOTE}</p>
        <Table caption="Billable units this month by band">
          <thead>
            <tr>
              <Th>Band</Th>
              <Th className="text-right">Units with a lease</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {bandRows(estimate.billableUnits).map((row) => (
              <tr key={row.band}>
                <Td>{row.label}</Td>
                <Td className="text-right tabular-nums">{row.value}</Td>
              </tr>
            ))}
            <tr>
              <Td className="font-medium">Every band</Td>
              <Td className="text-right font-medium tabular-nums">
                {totalUnits(estimate.billableUnits)}
              </Td>
            </tr>
          </tbody>
        </Table>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-slate-600">Units at their rates</dt>
            <dd className="tabular-nums">{formatMinor(estimate.unitsMinor)}</dd>
          </div>
          <div>
            <dt className="text-slate-600">The plan’s minimum</dt>
            <dd className="tabular-nums">{formatMinor(estimate.minimumMinor)}</dd>
          </div>
          <div>
            <dt className="text-slate-600">Estimate for the month</dt>
            <dd className="font-semibold tabular-nums" data-testid="subscription-estimate-total">
              {formatMinor(estimate.totalMinor)}
            </dd>
          </div>
        </dl>
      </CardBody>
    </Card>
  );
}

function PlanCard({
  view,
  today,
  onChanged,
}: {
  readonly view: Subscription;
  readonly today: string;
  readonly onChanged: (text: string) => void;
}) {
  return (
    <Card data-testid="subscription-plan">
      <CardHeader
        title="What your plan includes"
        description="A feature your plan leaves out names the plan that includes it."
      />
      <CardBody className="space-y-4">
        <ul className="divide-y divide-slate-100 text-sm">
          {view.features.map((f) => (
            <li
              key={f.feature}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid="plan-feature"
            >
              <span className="text-slate-900">{f.name}</span>
              {f.comingSoon ? (
                <Badge tone="neutral">{`${COMING_SOON} on ${tierLabel(f.unlockTier)}`}</Badge>
              ) : f.included ? (
                <Badge tone="green">Included</Badge>
              ) : (
                <Badge tone="amber">{`${tierLabel(f.unlockTier)} includes it`}</Badge>
              )}
            </li>
          ))}
        </ul>
        {view.actions.changeTier ? (
          <ChangeTier view={view} today={today} onChanged={onChanged} />
        ) : null}
        {view.actions.applyCode ? <ApplyCode onChanged={onChanged} /> : null}
      </CardBody>
    </Card>
  );
}

function ChangeTier({
  view,
  today,
  onChanged,
}: {
  readonly view: Subscription;
  readonly today: string;
  readonly onChanged: (text: string) => void;
}) {
  const [chosen, setChosen] = useState<SubscriptionTier | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const tiers = [...view.tiers].sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));

  async function confirm() {
    if (!chosen) return;
    setPending(true);
    setProblem(null);
    try {
      await api().subscription.changeTier({ tier: chosen });
      setChosen(null);
      onChanged(
        tierChangeText({ from: view.tier, to: chosen, downgradeOn: firstOfNextMonth(today) }),
      );
    } catch (failure) {
      setProblem(problemText(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <fieldset className="space-y-3" data-testid="change-tier">
      <legend className="text-base font-semibold text-slate-900">Change plan</legend>
      <p className="text-sm text-slate-700">
        A move up takes effect at once, and this month’s invoice charges each plan for its days. A
        move down takes effect on {formatBusinessDate(firstOfNextMonth(today))}.
      </p>
      <ul className="grid gap-3 md:grid-cols-3">
        {tiers.map((t) => {
          const current = t.tier === view.tier;
          return (
            <li
              key={t.tier}
              className="space-y-2 rounded-md border border-slate-200 p-3 text-sm"
              data-testid="tier-option"
            >
              <p className="flex flex-wrap items-center gap-2 font-semibold text-slate-900">
                {tierLabel(t.tier)}
                {current ? <Badge tone="green">Your plan</Badge> : null}
              </p>
              <ul className="space-y-1 text-slate-700">
                {bandRows(t.ratesMinor).map((row) => (
                  <li key={row.band}>
                    {row.label}: {rateText(row.value)}
                  </li>
                ))}
                <li>{minimumText(t.minimumMinor)}</li>
              </ul>
              {t.placeholder ? (
                <p className="text-xs font-medium text-amber-900">{PLACEHOLDER_PRICE_TEXT}</p>
              ) : null}
              {current ? null : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setChosen(t.tier);
                    setProblem(null);
                  }}
                >
                  Move to {tierLabel(t.tier)}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {chosen ? (
        <ConfirmBox
          label={`Confirm the move to ${tierLabel(chosen)}`}
          confirmText={`Move to ${tierLabel(chosen)}`}
          pending={pending}
          onConfirm={() => void confirm()}
          onCancel={() => setChosen(null)}
        >
          {tierChangeText({ from: view.tier, to: chosen, downgradeOn: firstOfNextMonth(today) })}
        </ConfirmBox>
      ) : null}
      {problem ? <Alert tone="error">{problem}</Alert> : null}
    </fieldset>
  );
}

function ApplyCode({ onChanged }: { readonly onChanged: (text: string) => void }) {
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length < 2) {
      setProblem('Enter the discount code.');
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const next = await api().subscription.applyCode({ code: trimmed });
      setCode('');
      onChanged(
        next.discount
          ? `Applied ${next.discount.code}: ${next.discount.description}.`
          : `Applied ${trimmed}.`,
      );
    } catch (failure) {
      setProblem(problemText(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      aria-label="Apply a discount code"
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => void submit(event)}
    >
      <TextField
        label="Discount code"
        value={code}
        maxLength={40}
        autoCapitalize="characters"
        onChange={(event) => setCode(event.target.value)}
        error={problem}
        className="min-w-48"
      />
      <Button type="submit" variant="secondary" pending={pending}>
        Apply the code
      </Button>
    </form>
  );
}

const EXPORT_POLL_MS = 3_000;
const EXPORT_POLL_TRIES = 40;

/** Cancelling, withdrawing it, and the data export (decision 12; PB-10). */
function EndCard({
  view,
  today,
  onChanged,
}: {
  readonly view: Subscription;
  readonly today: string;
  readonly onChanged: (text: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<'cancel' | 'withdraw' | 'export' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!view.actions.cancel && !view.actions.withdrawCancel && !view.actions.export) return null;

  async function cancel() {
    setPending('cancel');
    setProblem(null);
    try {
      const next = await api().subscription.cancel(reason.trim() ? { reason: reason.trim() } : {});
      setConfirming(false);
      setReason('');
      onChanged(
        next.cancelsOn
          ? `The subscription will end on ${formatBusinessDate(next.cancelsOn)}.`
          : 'The subscription is set to end.',
      );
    } catch (failure) {
      setProblem(problemText(failure));
    } finally {
      setPending(null);
    }
  }

  async function withdraw() {
    setPending('withdraw');
    setProblem(null);
    try {
      await api().subscription.withdrawCancel();
      onChanged('The cancellation is withdrawn: the subscription carries on.');
    } catch (failure) {
      setProblem(problemText(failure));
    } finally {
      setPending(null);
    }
  }

  async function exportData() {
    setPending('export');
    setProblem(null);
    try {
      let exported = await api().subscription.exportCreate();
      for (
        let tries = 0;
        exported.status === 'preparing' && tries < EXPORT_POLL_TRIES;
        tries += 1
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, EXPORT_POLL_MS));
        if (!mounted.current) return;
        exported = await api().subscription.exportGet({ exportId: exported.id });
      }
      if (!mounted.current) return;
      if (exported.status === 'failed') throw new Error('export failed');
      if (exported.status !== 'ready' || !exported.url) throw new Error('export slow');
      startDownload(exported.url);
    } catch (failure) {
      if (!mounted.current) return;
      setProblem(
        failure instanceof Error && failure.message === 'export failed'
          ? 'The export failed. Try again.'
          : failure instanceof Error && failure.message === 'export slow'
            ? 'The export is taking a while. Try again in a few minutes.'
            : failure instanceof Error && failure.message === 'unexpected link'
              ? 'The export link could not be opened. Try again.'
              : problemText(failure),
      );
    } finally {
      if (mounted.current) setPending(null);
    }
  }

  return (
    <Card data-testid="subscription-end">
      <CardHeader
        title="Your data and cancelling"
        description="The export is an Excel workbook of properties, units, tenants (without ID numbers), leases, invoices, payments and receipts. Documents stay downloadable from their pages."
      />
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {view.actions.export ? (
            <Button
              variant="secondary"
              pending={pending === 'export'}
              onClick={() => void exportData()}
            >
              Export your data
            </Button>
          ) : null}
          {view.actions.withdrawCancel ? (
            <Button pending={pending === 'withdraw'} onClick={() => void withdraw()}>
              Keep the subscription
            </Button>
          ) : null}
          {view.actions.cancel && !confirming ? (
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Cancel the subscription
            </Button>
          ) : null}
        </div>
        {confirming ? (
          <div className="space-y-3">
            <TextAreaField
              label="Why are you leaving? (optional)"
              value={reason}
              maxLength={500}
              rows={2}
              onChange={(event) => setReason(event.target.value)}
            />
            <ConfirmBox
              label="Confirm cancelling the subscription"
              confirmText="Cancel at the end of this month"
              pending={pending === 'cancel'}
              onConfirm={() => void cancel()}
              onCancel={() => setConfirming(false)}
            >
              {cancelConfirmText(lastDayOfMonth(today))}
            </ConfirmBox>
          </div>
        ) : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
      </CardBody>
    </Card>
  );
}
