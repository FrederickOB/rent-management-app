'use client';

import { DEFAULT_TIME_ZONE } from '@rent/domain/dates';
import Link from 'next/link';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { ConfirmBox } from '@/components/confirm-box';
import { LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { isKeyReused, sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { billingStateText, subscriptionMessage } from '@/lib/subscription';
import { useLoad } from '@/lib/use-load';

type BillingState = Awaited<ReturnType<ReturnType<typeof api>['platformAdmin']['billing']>>;

/**
 * Subscription billing on or off (founder answer Q1; review WEB-16). Off until a platform admin
 * turns it on from a date; refused while a price list in force then is a placeholder. Every
 * trial that started before then runs from that day.
 */
export function BillingSwitch({ canTurnOn }: { readonly canTurnOn: boolean }) {
  const load = useCallback(() => api().platformAdmin.billing(), []);
  const { state, reload } = useLoad(load);

  if (state.status === 'loading') return <Loading what="whether billing is on" />;
  if (state.status === 'error')
    return <LoadFailed message={state.problem.message} onRetry={reload} />;
  const billing = state.data;
  const text = billingStateText(billing);

  return (
    <Card data-testid="billing-switch" data-on={billing.on ? 'true' : 'false'}>
      <CardHeader title={text.title} />
      <CardBody className="space-y-3">
        <p className="text-sm text-slate-700">{text.body}</p>
        {billing.on && billing.turnedOnAt ? (
          <p className="text-sm text-slate-600">
            Turned on {formatTime(billing.turnedOnAt, 'UTC')}
            {billing.turnedOnByName ? ` by ${billing.turnedOnByName}` : ''}.
          </p>
        ) : null}
        {!billing.on && canTurnOn ? <TurnOn billing={billing} onDone={reload} /> : null}
      </CardBody>
    </Card>
  );
}

function TurnOn({
  billing,
  onDone,
}: {
  readonly billing: BillingState;
  readonly onDone: () => void;
}) {
  const today = todayIn(DEFAULT_TIME_ZONE);
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);
  const [startsOn, setStartsOn] = useState(today);
  const [note, setNote] = useState('');
  const [dateError, setDateError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    const bad = !/^\d{4}-\d{2}-\d{2}$/.test(startsOn) || startsOn < today;
    setDateError(bad ? 'Choose today or a later date.' : null);
    if (!bad) setConfirming(true);
  }

  async function turnOn() {
    const input = { startsOn, ...(note.trim() ? { note: note.trim() } : {}) };
    const content = JSON.stringify(input);
    if (keyedFor.current !== content) {
      keeper.reset();
      keyedFor.current = content;
    }
    setPending(true);
    try {
      await sendOnce(keeper, (key) => keyedApi(key).platformAdmin.turnOnBilling(input));
      keyedFor.current = null;
      setConfirming(false);
      onDone();
    } catch (failure) {
      setConfirming(false);
      setProblem(subscriptionMessage(failure) ?? toProblem(failure).message);
      if (isKeyReused(failure)) {
        keeper.reset();
        keyedFor.current = null;
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form aria-label="Turn billing on" className="space-y-3" onSubmit={review}>
      {billing.placeholderTiers.length > 0 ? (
        <p className="text-sm">
          <Link href="/platform/billing?tab=prices" className="underline underline-offset-2">
            Add real prices
          </Link>{' '}
          first.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Billing starts on"
          type="date"
          min={today}
          value={startsOn}
          onChange={(event) => setStartsOn(event.target.value)}
          error={dateError}
        />
        <TextField
          label="Note (optional)"
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      {confirming ? (
        <ConfirmBox
          label="Confirm turning billing on"
          confirmText={`Yes, bill from ${formatBusinessDate(startsOn)}`}
          pending={pending}
          onConfirm={() => void turnOn()}
          onCancel={() => setConfirming(false)}
        >
          From {formatBusinessDate(startsOn)}, every company is billed by its plan, and every free
          trial that started earlier runs from that day. It cannot be turned off from here.
        </ConfirmBox>
      ) : (
        <Button type="submit">Turn billing on</Button>
      )}
      {problem ? <Alert tone="error">{problem}</Alert> : null}
    </form>
  );
}
