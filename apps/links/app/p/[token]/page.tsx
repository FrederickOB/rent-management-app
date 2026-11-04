import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import {
  clientFrom,
  isToken,
  openPay,
  payStatus,
  type PayIntent,
  type PayPage,
} from '../../../lib/links-api';
import {
  checksFrom,
  chooseView,
  isIntentId,
  isWaiting,
  justPaid,
  newSubmissionId,
  recheckSeconds,
  returnedFromCheckout,
} from '../../../lib/pay';
import {
  ClosedScreen,
  PaidScreen,
  PayScreen,
  SettledScreen,
  Trouble,
  UnavailableScreen,
  WaitingScreen,
} from './screens';

export const metadata: Metadata = { title: 'Pay rent' };

/** The latest payment as the page summary carries it, in the intent's shape. */
const asIntent = (latest: NonNullable<PayPage['latest']>): PayIntent => ({
  ...latest,
  checkoutUrl: null,
});

/**
 * A pay link (BC-04; M4b plan 4.3; CLAUDE.md section 9): what is due, pre-filled, and a payment
 * by MoMo or card. Rendered on the server for every request, with no cookies and no script of
 * its own; the token is never shown, logged or put in a Referer. An unknown token is simply not
 * found.
 *
 * The page follows one payment: the one just started (`?intent=`, from the form's redirect), or
 * else the link's latest. While it waits on the provider, the API checks with the provider each
 * time the page asks.
 */
export default async function PayLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  if (!isToken(token)) notFound();
  const query = Object.fromEntries(
    Object.entries(await searchParams).map(([key, value]) => [
      key,
      Array.isArray(value) ? value[0] : value,
    ]),
  );
  const client = clientFrom(await headers());
  const opened = await openPay(token, client);
  if (!opened.ok) {
    if (opened.status === 404) notFound();
    return <Trouble busy={opened.status === 429} />;
  }
  let page = opened.value;
  if (page.screen === 'expired' || page.screen === 'revoked') return <ClosedScreen page={page} />;

  // A payment the tenant has just made: in the address, or back from the card checkout.
  const fresh = justPaid(query);
  let intent: PayIntent | null = page.latest ? asIntent(page.latest) : null;
  const followed = isIntentId(query.intent) ? query.intent : page.latest?.intentId;
  if (followed && (fresh || isWaiting(page.latest?.status))) {
    const checked = await payStatus(token, client, followed);
    if (checked.ok) {
      const before = intent?.intentId === followed ? intent.status : null;
      intent = checked.value;
      // It went through during this request: the figures above were read before it posted.
      if (intent.status === 'confirmed' && before !== 'confirmed') {
        const again = await openPay(token, client);
        if (again.ok) page = again.value;
      }
    } else if (checked.status === 429) {
      return <Trouble busy />;
    }
  }

  const view = chooseView({
    screen: page.screen,
    methods: page.methods,
    intentStatus: intent?.status ?? null,
    startAgain: query.step === 'again',
    dueNowMinor: page.dueNowMinor,
  });
  switch (view) {
    case 'closed':
      return <ClosedScreen page={page} />;
    case 'settled':
      return <SettledScreen page={page} intent={intent} fresh={fresh} />;
    case 'paid':
      return <PaidScreen token={token} page={page} intent={intent} />;
    case 'unavailable':
      return <UnavailableScreen token={token} page={page} />;
    case 'waiting': {
      const checks = checksFrom(query.check);
      return (
        <WaitingScreen
          token={token}
          page={page}
          intent={intent!}
          returnedFromCheckout={returnedFromCheckout(query)}
          checks={checks}
          nextCheckSeconds={recheckSeconds(checks)}
        />
      );
    }
    default:
      break;
  }
  return (
    <PayScreen
      token={token}
      page={page}
      intent={intent}
      fresh={fresh}
      stillWaiting={intent && isWaiting(intent.status) ? intent : null}
      query={query}
      submissionId={newSubmissionId()}
    />
  );
}
