import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { getCompany, getMe } from '@/lib/server/session';
import { InvoiceView } from './invoice-view';

export const metadata: Metadata = { title: 'Subscription invoice' };

/** One subscription invoice: its lines, its PDF, and the snapshot it was made from (PB-02). */
export default async function SubscriptionInvoicePage({
  params,
}: {
  readonly params: Promise<{ invoiceId: string }>;
}) {
  const [{ invoiceId }, me, company] = await Promise.all([params, getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Subscription invoice',
    what: 'the subscription',
    needs: 'subscription.read',
  });
  if (refused) return refused;
  return <InvoiceView invoiceId={invoiceId} />;
}
