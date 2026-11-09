import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { getCompany, getMe } from '@/lib/server/session';
import { ConsoleInvoice } from './console-invoice';

export const metadata: Metadata = { title: 'Company invoice' };

/**
 * A company's subscription invoice in the console (PB-02, founder answer Q2; review WEB-11 and
 * WEB-17): its lines, credit notes and snapshot, and crediting it.
 */
export default async function PlatformInvoicePage({
  params,
}: {
  readonly params: Promise<{ readonly companyId: string; readonly invoiceId: string }>;
}) {
  const [{ companyId, invoiceId }, me, company] = await Promise.all([
    params,
    getMe(),
    getCompany(),
  ]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Company invoice',
    what: 'the platform’s companies',
    needs: 'company.manage',
  });
  if (refused) return refused;
  return <ConsoleInvoice companyId={companyId} invoiceId={invoiceId} />;
}
