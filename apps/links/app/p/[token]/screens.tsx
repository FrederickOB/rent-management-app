import { MOMO_NETWORK_LABELS, MOMO_NETWORKS } from '@rent/contracts';
import { PAY_LINK_DAYS } from '@rent/domain/payments';
import { LandlordContact } from '../../_components/landlord-contact';
import type { PayIntent, PayPage } from '../../../lib/links-api';
import {
  amountFieldValue,
  cedis,
  checkoutHref,
  day,
  isMethodValue,
  payProblemText,
  when,
  type MethodValue,
} from '../../../lib/pay';

// The pay page's screens (BC-04; M4b plan 4.3). Plain HTML forms and links: every step works
// without JavaScript, and the waiting step checks again with a plain page refresh.

type Query = Readonly<Record<string, string | undefined>>;

function paidUntilText(page: PayPage): string {
  const until = page.paidUntil ? day(page.paidUntil) : 'Nothing paid yet';
  return page.partial
    ? `${until}, and ${cedis(page.partial.amountMinor)} towards the month from ${day(page.partial.monthStart)}`
    : until;
}

/** What is due now, and what identifies the tenancy, for any screen that names the money. */
function Figures({ page, token }: { page: PayPage; token: string }) {
  return (
    <section className="panel" aria-labelledby="due">
      <h2 id="due" className="label">
        Due now
      </h2>
      <p className="amount">{cedis(page.dueNowMinor)}</p>
      <p className="small">
        {page.dueNowMinor > 0
          ? 'This invoice and anything older. A payment always pays the oldest amount first.'
          : 'Nothing is due now. Anything you pay is kept as credit for the months ahead.'}
      </p>
      <dl className="facts">
        <div>
          <dt>Tenant</dt>
          <dd>{page.tenantName}</dd>
        </div>
        <div>
          <dt>Unit</dt>
          <dd>
            {page.unitCode}, {page.propertyName}
          </dd>
        </div>
        <div>
          <dt>Invoice</dt>
          <dd>
            <a href={`/p/${token}/invoice`}>{page.invoiceNumber} (PDF)</a>
          </dd>
        </div>
        <div>
          <dt>Payment reference</dt>
          <dd>{page.paymentReference}</dd>
        </div>
        <div>
          <dt>Paid until</dt>
          <dd>{paidUntilText(page)}</dd>
        </div>
      </dl>
    </section>
  );
}

/** A payment that went through: the amount and its receipt. */
function Received({ intent }: { intent: PayIntent }) {
  return (
    <div className="panel done" role="status">
      <p>
        <strong>Thank you. We have received {cedis(intent.amountMinor)}.</strong>
      </p>
      <p className="receipt">
        {intent.receiptNumber
          ? `Receipt number ${intent.receiptNumber}. We are sending the receipt to you by SMS or email.`
          : 'Your receipt is on its way to you by SMS or email.'}
      </p>
    </div>
  );
}

/** What became of the payment the tenant just made, when it is no longer waiting. */
function Outcome({ intent, fresh }: { intent: PayIntent | null; fresh: boolean }) {
  if (!intent) return null;
  if (intent.status === 'confirmed') {
    return fresh ? (
      <Received intent={intent} />
    ) : (
      <p className="small">
        Last payment through this link: {cedis(intent.amountMinor)}
        {intent.receiptNumber ? ` (receipt ${intent.receiptNumber})` : ''}.
      </p>
    );
  }
  // An old failure says nothing useful on a later visit.
  if (!fresh || (intent.status !== 'failed' && intent.status !== 'abandoned')) return null;
  return (
    <p className="panel problem" role="alert">
      {intent.status === 'failed'
        ? `Your payment of ${cedis(intent.amountMinor)} did not go through.`
        : `Your payment of ${cedis(intent.amountMinor)} was not completed.`}
      {intent.message ? ` ${intent.message}` : ''} Nothing was taken. You can try again.
    </p>
  );
}

function LinkFooter({ page }: { page: PayPage }) {
  return (
    <p className="small">
      This link works until {when(page.linkExpiresAt, page.timeZone)}, or until this invoice is
      paid.
    </p>
  );
}

/**
 * The pay page: what is due, pre-filled, and any amount from the minimum up to the rent left to
 * the end of the term (decision 7). MoMo prompts the number given; card continues on the
 * provider's checkout.
 */
export function PayScreen({
  token,
  page,
  intent,
  fresh,
  stillWaiting,
  query,
  submissionId,
}: {
  token: string;
  page: PayPage;
  intent: PayIntent | null;
  /** The tenant has just made this payment (it is in the page's address). */
  fresh: boolean;
  /** An earlier payment is still waiting, and the tenant chose to start again. */
  stillWaiting: PayIntent | null;
  query: Query;
  submissionId: string;
}) {
  const problem = payProblemText(query.error, page.amounts);
  const momo = page.methods.includes('momo');
  const card = page.methods.includes('card');
  const typedAmount = Number(query.amount);
  const amount =
    Number.isSafeInteger(typedAmount) && typedAmount > 0 ? typedAmount : page.amounts.prefillMinor;
  const chosen: MethodValue | null = isMethodValue(query.method) ? query.method : null;
  const base = `/p/${token}`;
  return (
    <>
      <h1>Pay rent to {page.landlord.name}</h1>
      <Outcome intent={intent} fresh={fresh} />
      {stillWaiting ? (
        <p className="panel notice">
          Your earlier payment of {cedis(stillWaiting.amountMinor)} has not finished yet. If you
          approve it as well, you pay twice; anything extra is kept as credit.
        </p>
      ) : null}
      {problem ? (
        <p className="panel problem" role="alert">
          {problem}
        </p>
      ) : null}
      {query.invoice === 'unavailable' ? (
        <p className="panel problem" role="alert">
          We could not get the invoice PDF just now. Try again in a minute.
        </p>
      ) : null}
      <Figures page={page} token={token} />

      <section aria-labelledby="pay">
        <h2 id="pay">Pay</h2>
        <form method="post" action={`${base}/pay`}>
          <input type="hidden" name="submissionId" value={submissionId} />
          <label htmlFor="amount">Amount to pay (GH₵)</label>
          <input
            id="amount"
            name="amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            required
            defaultValue={amountFieldValue(amount)}
            aria-describedby="amount-hint"
          />
          <p id="amount-hint" className="small hint">
            Pay all of it or part of it: any amount from {cedis(page.amounts.minMinor)} to{' '}
            {cedis(page.amounts.maxMinor)}, the rent left to the end of your lease. More than is due
            now is kept as credit for the months ahead.
          </p>
          <fieldset>
            <legend>How do you want to pay?</legend>
            {momo
              ? MOMO_NETWORKS.map((network) => (
                  <label className="check" key={network}>
                    <input
                      type="radio"
                      name="method"
                      value={`momo-${network}`}
                      required
                      defaultChecked={chosen === `momo-${network}`}
                    />
                    <span>{MOMO_NETWORK_LABELS[network]}</span>
                  </label>
                ))
              : null}
            {card ? (
              <label className="check">
                <input
                  type="radio"
                  name="method"
                  value="card"
                  required
                  defaultChecked={chosen === 'card'}
                />
                <span>Card</span>
              </label>
            ) : null}
          </fieldset>
          {momo ? (
            <>
              <label htmlFor="momoPhone">MoMo number to charge</label>
              <input
                id="momoPhone"
                name="momoPhone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={24}
                aria-describedby="phone-hint"
              />
              <p id="phone-hint" className="small hint">
                For MoMo only. The payment request goes to this number; approve it there with your
                MoMo PIN. Never share your PIN with anyone.
              </p>
            </>
          ) : null}
          <button type="submit">Pay</button>
        </form>
      </section>
      <LandlordContact landlord={page.landlord} />
      <LinkFooter page={page} />
    </>
  );
}

/**
 * A payment the provider has not finished with. MoMo: approve on the phone. Card: continue to the
 * checkout, or wait while the payment is checked after it. The page checks again by refreshing
 * itself, less often as time goes on (lib/pay.ts), and "Check now" does the same at once.
 */
export function WaitingScreen({
  token,
  page,
  intent,
  returnedFromCheckout,
  checks,
  nextCheckSeconds,
}: {
  token: string;
  page: PayPage;
  intent: PayIntent;
  returnedFromCheckout: boolean;
  checks: number;
  nextCheckSeconds: number;
}) {
  const base = `/p/${token}`;
  const checkout = returnedFromCheckout ? null : checkoutHref(intent.checkoutUrl);
  const again = (
    <p className="small">
      <a href={`${base}?step=again`}>Pay another way</a>
    </p>
  );
  if (checkout) {
    return (
      <>
        <h1>Continue to the card payment page</h1>
        <p>
          You are paying {cedis(intent.amountMinor)} to {page.landlord.name}. Our payment provider
          runs the card payment page: enter your card details there, and never in a message or on a
          call.
        </p>
        <p>
          <a className="button" href={checkout}>
            Continue to pay {cedis(intent.amountMinor)}
          </a>
        </p>
        {again}
        <LandlordContact landlord={page.landlord} />
      </>
    );
  }
  const params = new URLSearchParams({ intent: intent.intentId, check: String(checks + 1) });
  if (returnedFromCheckout) params.set('returned', '1');
  const recheck = `${base}?${params.toString()}`;
  const momo = intent.checkoutUrl === null;
  const heading = momo ? 'Approve the payment on your phone' : 'Checking your card payment';
  return (
    <>
      <meta httpEquiv="refresh" content={`${nextCheckSeconds};url=${recheck}`} />
      <h1>{heading}</h1>
      {momo ? (
        <p>
          We have asked for {cedis(intent.amountMinor)}. When the prompt appears on your phone,
          enter your MoMo PIN to approve it. If no prompt appears, look in your MoMo menu for a
          payment waiting for your approval.
        </p>
      ) : (
        <p>
          We are confirming your payment of {cedis(intent.amountMinor)} with the payment provider.
          This usually takes a few seconds.
        </p>
      )}
      {intent.message && intent.message !== heading ? (
        <p className="panel notice">{intent.message}</p>
      ) : null}
      <p className="small" role="status">
        This page checks again every {nextCheckSeconds} seconds.
      </p>
      <p>
        <a className="button secondary" href={recheck}>
          Check now
        </a>
      </p>
      {momo ? (
        <p className="small">
          No prompt after a minute? Check the number and the network, then{' '}
          <a href={`${base}?step=again`}>start again</a>.
        </p>
      ) : (
        again
      )}
      <LandlordContact landlord={page.landlord} />
    </>
  );
}

/** Just after a payment that settled the invoice: thanks, the receipt and the figures now. */
export function PaidScreen({
  token,
  page,
  intent,
}: {
  token: string;
  page: PayPage;
  intent: PayIntent | null;
}) {
  return (
    <>
      <h1>Thank you: your payment is received</h1>
      {intent?.status === 'confirmed' ? <Received intent={intent} /> : null}
      <Figures page={page} token={token} />
      <LandlordContact landlord={page.landlord} />
    </>
  );
}

/** Nothing is due on the invoice, so the link takes no more payments. */
export function SettledScreen({
  page,
  intent,
  fresh,
}: {
  page: PayPage;
  intent: PayIntent | null;
  fresh: boolean;
}) {
  return (
    <>
      <h1>This invoice is paid</h1>
      {fresh && intent?.status === 'confirmed' ? <Received intent={intent} /> : null}
      <p>
        Nothing more is due on invoice {page.invoiceNumber}, so this link no longer takes payments.
        {page.paidUntil ? ` Your rent is paid until ${day(page.paidUntil)}.` : ''}
      </p>
      <p>If you want to pay ahead, contact {page.landlord.name}.</p>
      <LandlordContact landlord={page.landlord} />
    </>
  );
}

/** An expired or replaced link: what happened, and who to ask for a new one. */
export function ClosedScreen({ page }: { page: PayPage }) {
  const replaced = page.screen === 'revoked';
  return (
    <>
      <h1>{replaced ? 'This link has been replaced' : 'This link has expired'}</h1>
      <p>
        {replaced
          ? `A newer link was sent to you, so this one no longer works. Use the newest message, or ask ${page.landlord.name} to send you a new link.`
          : `Pay links work for ${PAY_LINK_DAYS} days, or until the invoice is paid. Ask ${page.landlord.name} to send you a new link.`}
      </p>
      <p>Nothing can be paid through this link.</p>
      <LandlordContact landlord={page.landlord} />
    </>
  );
}

/**
 * The landlord cannot take payments online now (no usable settlement account, or every provider
 * is down): their own instructions, and what to quote with the payment.
 */
export function UnavailableScreen({ token, page }: { token: string; page: PayPage }) {
  return (
    <>
      <h1>Online payment is not available just now</h1>
      <p>{page.landlord.name} cannot take payments through this link at the moment.</p>
      {page.landlord.manualInstructions ? (
        <section className="panel notice" aria-labelledby="instead">
          <h2 id="instead">How to pay instead</h2>
          <p className="instructions">{page.landlord.manualInstructions}</p>
          <p className="small">Quote your payment reference, {page.paymentReference}.</p>
        </section>
      ) : (
        <p>Contact them to pay another way, and quote your payment reference.</p>
      )}
      <Figures page={page} token={token} />
      <LandlordContact landlord={page.landlord} />
    </>
  );
}

/** The API could not be reached, or asked us to slow down. */
export function Trouble({ busy }: { busy: boolean }) {
  return (
    <>
      <h1>{busy ? 'Too many requests' : 'This page is not available just now'}</h1>
      <p>
        {busy
          ? 'This link was opened many times in a short while. Wait a few minutes and try again.'
          : 'Something went wrong on our side. Nothing has been charged. Try again in a few minutes.'}
      </p>
    </>
  );
}
