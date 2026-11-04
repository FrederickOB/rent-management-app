import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { clientFrom, isToken, openUnsubscribe } from '../../../lib/links-api';
import { unsubscribeProblemText, unsubscribeView } from '../../../lib/unsubscribe';
import { AddressChangedScreen, ConfirmScreen, DoneScreen, ExpiredScreen, Trouble } from './screens';

export const metadata: Metadata = { title: 'Stop emails' };

/**
 * An email unsubscribe link (CM-09; M6 decision 7 and plan 4.8): the landlord, what stops by
 * email, one button, and how to stop the other channels. Rendered on the server for every
 * request, with no cookies and no script of its own; an unknown token is simply not found.
 * Opening changes nothing: only the button (or a mail client's one-click post) withdraws consent.
 */
export default async function UnsubscribeLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  if (!isToken(token)) notFound();
  const { error } = await searchParams;
  const view = unsubscribeView(await openUnsubscribe(token, clientFrom(await headers())));
  if (view.kind === 'not_found') notFound();
  switch (view.kind) {
    case 'trouble':
      return <Trouble busy={view.busy} />;
    case 'expired':
      return <ExpiredScreen landlordName={view.landlordName} />;
    case 'address_changed':
      return <AddressChangedScreen landlordName={view.landlordName} />;
    case 'done':
      return <DoneScreen landlordName={view.landlordName} emailMasked={view.emailMasked} />;
    case 'confirm':
      return (
        <ConfirmScreen
          token={token}
          landlordName={view.landlordName}
          emailMasked={view.emailMasked}
          problem={unsubscribeProblemText({ error: Array.isArray(error) ? error[0] : error })}
        />
      );
  }
}
