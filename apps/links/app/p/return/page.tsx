import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { clientFrom, payReturned } from '../../../lib/links-api';
import { Recheck } from '../../_components/recheck';
import {
  checksFrom,
  failureText,
  isChargeReference,
  isWaiting,
  recheckSeconds,
} from '../../../lib/pay';

export const metadata: Metadata = { title: 'Card payment' };

/**
 * The card return page (BC-04; M4b review 14). The provider's checkout sends the payer back to
 * `/p/return?reference=pi-…`: the charge's reference, which the provider shows the payer anyway,
 * and never the pay link's token. So this page shows only what the reference may reveal, the
 * payment's status and receipt number, and never the invoice, the tenancy or the landlord.
 * While the payment is being confirmed it checks again by itself and updates in place (Recheck),
 * as the pay page's waiting step does. The API limits it per address and per reference.
 */
export default async function CardReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = Object.fromEntries(
    Object.entries(await searchParams).map(([key, value]) => [
      key,
      Array.isArray(value) ? value[0] : value,
    ]),
  );
  const reference = query.reference;
  if (!isChargeReference(reference)) notFound();
  const result = await payReturned(reference, clientFrom(await headers()));
  if (!result.ok) {
    if (result.status === 404) notFound();
    const busy = result.status === 429;
    return (
      <>
        <h1>{busy ? 'Too many requests' : 'This page is not available just now'}</h1>
        <p>
          {busy
            ? 'This page was opened many times in a short while. Wait a few minutes and try again.'
            : 'Something went wrong on our side. Try again in a few minutes.'}{' '}
          Your receipt reaches you by SMS or email once the payment is confirmed.
        </p>
      </>
    );
  }
  const payment = result.value;
  if (isWaiting(payment.status)) {
    const checks = checksFrom(query.check);
    const seconds = recheckSeconds(checks);
    const again = `/p/return?${new URLSearchParams({ reference, check: String(checks + 1) }).toString()}`;
    return (
      <>
        <h1>We are confirming your payment</h1>
        <p>
          The payment provider is confirming your card payment. This usually takes a few seconds.
        </p>
        <p className="small" role="status">
          <Recheck href={again} seconds={seconds} />
        </p>
        <p>
          <a className="button secondary" href={again} data-recheck-link="">
            Check now
          </a>
        </p>
        <p className="small">
          You can close this page: your receipt reaches you by SMS or email once the payment is
          confirmed.
        </p>
      </>
    );
  }
  if (payment.status === 'confirmed') {
    return (
      <>
        <h1>Thank you: your payment is received</h1>
        <div className="panel done" role="status">
          <p className="receipt">
            {payment.receiptNumber
              ? `Receipt number ${payment.receiptNumber}. We are sending the receipt to you by SMS or email.`
              : 'Your receipt is on its way to you by SMS or email.'}
          </p>
        </div>
        <p>You can close this page.</p>
      </>
    );
  }
  const why = failureText(payment.failureCode, payment.message, null);
  return (
    <>
      <h1>Your card payment did not go through</h1>
      <p className="panel problem" role="alert">
        {why ?? 'The card payment was not completed.'} Nothing was taken.
      </p>
      <p>To try again, open the pay link in the message we sent you.</p>
    </>
  );
}
