import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe, loadInvoice } from '@/lib/server/session';
import { InvoiceDetailView } from './invoice-detail';

type Params = Promise<{ readonly invoiceId: string }>;

const invoice = cache((invoiceId: string) => loadInvoice(invoiceId));

export async function generateMetadata({ params }: { readonly params: Params }): Promise<Metadata> {
  const me = await getMe();
  if (!me || !allowed(me, 'billing.view')) return { title: 'Invoice' };
  const loaded = await invoice((await params).invoiceId);
  return { title: loaded.ok ? `Invoice ${loaded.data.number}` : 'Invoice' };
}

/**
 * An invoice (BC-01, CT-04): its lines with VAT and levies under the line they are charged on,
 * what paid each line, the PDF, and corrections a second person approves (P24, P27).
 */
export default async function InvoicePage({ params }: { readonly params: Params }) {
  const [{ invoiceId }, me] = await Promise.all([params, getMe()]);
  if (!me) return null;
  if (!allowed(me, 'billing.view'))
    return (
      <>
        <PageHeader title="Invoice" />
        <NoAccess what="invoices" />
      </>
    );
  const loaded = await invoice(invoiceId);
  if (!loaded.ok) {
    if (loaded.status !== 403) notFound();
    return (
      <>
        <PageHeader title="Invoice" />
        <NoAccess what="this invoice" />
      </>
    );
  }
  return (
    <InvoiceDetailView
      initial={loaded.data}
      can={{
        correct: allowed(me, 'billing.manage'),
        seeApprovals: allowed(me, 'approval.view'),
        seeLease: allowed(me, 'lease.view'),
      }}
    />
  );
}
