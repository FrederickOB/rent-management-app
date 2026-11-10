import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { LandlordContact } from '../../_components/landlord-contact';
import { Recheck } from '../../_components/recheck';
import { clientFrom, isToken, openReceipt, type ReceiptPage } from '../../../lib/links-api';
import { cedis, day, when } from '../../../lib/pay';

export const metadata: Metadata = { title: 'Your receipt' };

/** While the PDF is being made, the page checks again this often (seconds), in place (Recheck). */
const PREPARING_RECHECK_SECONDS = 10;

/**
 * A receipt link (BC-06; M4b plan 4.6): the receipt's figures, and its PDF through a fresh
 * 5-minute link at each download, for 30 days. Rendered on the server for every request, with no
 * cookies and no script of its own; an unknown token is simply not found.
 */
export default async function ReceiptLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  if (!isToken(token)) notFound();
  const { download } = await searchParams;
  const opened = await openReceipt(token, clientFrom(await headers()));
  if (!opened.ok) {
    if (opened.status === 404) notFound();
    return (
      <>
        <h1>
          {opened.status === 429 ? 'Too many requests' : 'This page is not available just now'}
        </h1>
        <p>
          {opened.status === 429
            ? 'This link was opened many times in a short while. Wait a few minutes and try again.'
            : 'Something went wrong on our side. Try again in a few minutes.'}
        </p>
      </>
    );
  }
  const page = opened.value;
  if (page.screen === 'expired' || page.screen === 'revoked') return <ClosedReceipt page={page} />;
  const credit = page.kind === 'credit_receipt';
  const preparing = page.screen === 'preparing' || !page.downloadable;
  return (
    <>
      <h1>{credit ? 'Your credit receipt' : 'Your receipt'}</h1>
      {credit ? (
        <p className="panel notice">
          A credit receipt corrects an earlier receipt: this amount no longer counts as paid.
        </p>
      ) : null}
      <section className="panel" aria-labelledby="receipt">
        <h2 id="receipt" className="label">
          Receipt {page.receiptNumber}
        </h2>
        <p className="amount">{cedis(page.amountMinor)}</p>
        <dl className="facts">
          <div>
            <dt>{credit ? 'Recorded on' : 'Received on'}</dt>
            <dd>{day(page.receivedOn)}</dd>
          </div>
          <div>
            <dt>Paid to</dt>
            <dd>{page.landlord.name}</dd>
          </div>
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
          {page.paidUntil ? (
            <div>
              <dt>Paid until</dt>
              <dd>{day(page.paidUntil)}</dd>
            </div>
          ) : null}
        </dl>
      </section>
      {download === 'unavailable' ? (
        <p className="panel problem" role="alert">
          We could not get the PDF just now. Try again in a minute.
        </p>
      ) : null}
      {preparing ? (
        <>
          <p role="status">
            The PDF is being prepared.{' '}
            <Recheck href={`/r/${token}`} seconds={PREPARING_RECHECK_SECONDS} />
          </p>
          <p>
            <a className="button secondary" href={`/r/${token}`} data-recheck-link="">
              Check now
            </a>
          </p>
        </>
      ) : (
        <p>
          <a className="button" href={`/r/${token}/document`}>
            Download the receipt (PDF)
          </a>
        </p>
      )}
      <LandlordContact landlord={page.landlord} />
      <p className="small">
        This link works until {when(page.linkExpiresAt, page.timeZone)}. Your receipts are also in
        the tenant app.
      </p>
    </>
  );
}

function ClosedReceipt({ page }: { page: ReceiptPage }) {
  const replaced = page.screen === 'revoked';
  return (
    <>
      <h1>{replaced ? 'This link has been replaced' : 'This link has expired'}</h1>
      <p>
        {replaced
          ? 'A newer link to this receipt was sent to you, so this one no longer works. Use the newest message.'
          : 'Receipt links stop working after a while.'}{' '}
        Your receipts are also in the tenant app, or ask {page.landlord.name} for a copy of receipt{' '}
        {page.receiptNumber}.
      </p>
      <LandlordContact landlord={page.landlord} />
    </>
  );
}
