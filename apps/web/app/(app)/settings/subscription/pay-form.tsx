'use client';

import type { SubscriptionView } from '@rent/contracts';
import { tryNormalisePhone } from '@rent/domain/phone';
import type {
  SubscriptionPaymentChannel,
  SubscriptionPaymentPurpose,
} from '@rent/domain/subscription';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { isKeyReused, moneyProblem, sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import {
  ANNUAL_NOTE,
  annualOfferText,
  checkoutLink,
  chosenPurpose,
  MOMO_PROVIDER_LABELS,
  type MomoProvider,
  PAYMENT_POLL_MS,
  PAYMENT_POLL_TRIES,
  PAYMENT_STATUS_LABELS,
  paymentNext,
  subscriptionMessage,
} from '@/lib/subscription';
import { formatMinor } from '@/lib/tenancy-format';

type Payment = Awaited<ReturnType<ReturnType<typeof api>['subscription']['pay']>>;

/**
 * Paying the subscription (PB-07, decision 9): every open invoice, or 12 months up front, by card
 * (the provider's checkout page, in a new tab) or MoMo (a prompt on the phone). The platform's
 * own Paystack account takes it, never a landlord's: `SUB-` references are never rent.
 */
export function PayForm({
  canPayInvoices,
  canPayAnnual,
  openMinor,
  pastDueMinor,
  annualPrice,
  onPaid,
}: {
  readonly canPayInvoices: boolean;
  readonly canPayAnnual: boolean;
  /** What every open invoice still owes: what paying the invoices charges (review WEB-4). */
  readonly openMinor: number;
  /** Of that, what is past due. */
  readonly pastDueMinor: number | null;
  /** What a year ahead costs, when it may be paid. */
  readonly annualPrice: SubscriptionView['annualPrice'];
  readonly onPaid: (text: string) => void;
}) {
  const keeper = useIdempotencyKeeper();
  const keyedFor = useRef<string | null>(null);
  const [picked, setPicked] = useState<SubscriptionPaymentPurpose | null>(null);
  // Review WEB-5: the purpose is one the API offers now, never one it stopped offering.
  const purpose = chosenPurpose(picked, { invoices: canPayInvoices, annual: canPayAnnual });
  const [channel, setChannel] = useState<SubscriptionPaymentChannel>('card');
  const [phone, setPhone] = useState('');
  const [provider, setProvider] = useState<MomoProvider>('mtn');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  // Review N8: while a payment waits for the provider, another one is not started.
  const waiting = payment !== null && paymentNext(payment.status) === 'wait';
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function watch(started: Payment) {
    let current = started;
    for (
      let tries = 0;
      paymentNext(current.status) === 'wait' && tries < PAYMENT_POLL_TRIES;
      tries += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, PAYMENT_POLL_MS));
      if (!mounted.current) return;
      current = await api().subscription.payment({ paymentId: current.id });
      if (!mounted.current) return;
      setPayment(current);
    }
    const next = paymentNext(current.status);
    if (next === 'paid') {
      setPayment(null);
      onPaid(
        `Paid ${formatMinor(current.amountMinor)} (${current.reference}). The receipt is in the list below.`,
      );
    } else if (next === 'failed') {
      setPayment(null);
      setProblem(
        current.message ??
          'The payment did not go through, and nothing was taken. Try again, or pay another way.',
      );
    } else {
      setProblem(
        'The payment has not been confirmed yet. If you approved it, check again in a moment: it shows here and in the list below once the provider confirms it.',
      );
    }
  }

  /** After the polls run out, the payment is asked about again on request. */
  async function checkAgain() {
    if (!payment) return;
    setChecking(true);
    setProblem(null);
    try {
      await watch(payment);
    } catch (failure) {
      if (mounted.current) setProblem(subscriptionMessage(failure) ?? moneyProblem(failure));
    } finally {
      if (mounted.current) setChecking(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (waiting || purpose === null) return;
    setProblem(null);
    let momoPhone: string | undefined;
    if (channel === 'momo') {
      const normalised = tryNormalisePhone(phone);
      if (!normalised) {
        setPhoneError('Enter the MoMo number, for example 024 412 3456.');
        return;
      }
      momoPhone = normalised;
    }
    setPhoneError(null);
    const input = {
      purpose,
      channel,
      ...(momoPhone ? { momoPhone, momoProvider: provider } : {}),
    };
    const content = JSON.stringify(input);
    if (keyedFor.current !== content) {
      keeper.reset();
      keyedFor.current = content;
    }
    setPending(true);
    try {
      const started = await sendOnce(keeper, (key) => keyedApi(key).subscription.pay(input));
      keeper.reset();
      keyedFor.current = null;
      setPayment(started);
      await watch(started);
    } catch (failure) {
      if (!mounted.current) return;
      setProblem(subscriptionMessage(failure) ?? moneyProblem(failure));
      if (isKeyReused(failure)) {
        keeper.reset();
        keyedFor.current = null;
      }
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  const checkout = payment ? checkoutLink(payment.checkoutUrl) : null;

  return (
    <Card data-testid="subscription-pay">
      <CardHeader
        title="Pay"
        description="Paid to the platform for your subscription, never mixed with rent."
      />
      <CardBody className="space-y-3">
        <form
          aria-label="Pay the subscription"
          className="space-y-3"
          onSubmit={(event) => void submit(event)}
        >
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">What to pay</legend>
            {canPayInvoices ? (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="purpose"
                  className="mt-1"
                  checked={purpose === 'invoices'}
                  onChange={() => setPicked('invoices')}
                />
                <span>
                  Every open invoice: {formatMinor(openMinor)}
                  {pastDueMinor ? ` (${formatMinor(pastDueMinor)} of it past due)` : ''}
                </span>
              </label>
            ) : null}
            {canPayAnnual ? (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="purpose"
                  className="mt-1"
                  checked={purpose === 'annual'}
                  onChange={() => setPicked('annual')}
                />
                <span>
                  Twelve months up front{annualPrice ? `: ${annualOfferText(annualPrice)}` : ''}
                  <span className="block text-slate-600">{ANNUAL_NOTE}</span>
                </span>
              </label>
            ) : null}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">How</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="channel"
                checked={channel === 'card'}
                onChange={() => setChannel('card')}
              />
              Card, on the payment provider’s page
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="channel"
                checked={channel === 'momo'}
                onChange={() => setChannel('momo')}
              />
              Mobile money, approved on the phone
            </label>
          </fieldset>
          {channel === 'momo' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="MoMo number"
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                error={phoneError}
              />
              <SelectField
                label="Network"
                value={provider}
                options={Object.entries(MOMO_PROVIDER_LABELS).map(([value, label]) => ({
                  value,
                  label,
                }))}
                onChange={(event) => setProvider(event.target.value as MomoProvider)}
              />
            </div>
          ) : null}
          <Button type="submit" pending={pending} disabled={waiting && !pending}>
            {channel === 'card' ? 'Pay by card' : 'Send the MoMo prompt'}
          </Button>
        </form>
        {payment ? (
          <div className="space-y-2 rounded-md border border-slate-200 p-3 text-sm" role="status">
            <p data-testid="subscription-payment-status">
              {PAYMENT_STATUS_LABELS[payment.status]}: {formatMinor(payment.amountMinor)}, reference{' '}
              {payment.reference}.
            </p>
            {checkout ? (
              <p>
                <a
                  href={checkout}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-slate-900 underline underline-offset-2"
                  data-testid="subscription-checkout"
                >
                  Continue to the card payment page
                </a>{' '}
                (it opens in a new tab). Enter your card details there, never in a message or on a
                call. This page updates once the payment is confirmed.
              </p>
            ) : payment.channel === 'momo' ? (
              <p>
                {payment.message ??
                  'Approve the prompt on your phone with your MoMo PIN. If no prompt appears, look in your MoMo menu for a payment waiting for approval.'}
              </p>
            ) : null}
            {waiting && !pending ? (
              <Button
                size="sm"
                variant="secondary"
                pending={checking}
                onClick={() => void checkAgain()}
              >
                Check the payment again
              </Button>
            ) : null}
          </div>
        ) : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
      </CardBody>
    </Card>
  );
}
