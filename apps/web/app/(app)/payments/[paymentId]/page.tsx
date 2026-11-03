import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe, loadPayment } from '@/lib/server/session';
import { PaymentDetailView } from './payment-detail';

type Params = Promise<{ readonly paymentId: string }>;

export const metadata: Metadata = { title: 'Payment' };

/**
 * A payment (BC-07, P21, P23): what it paid for, its receipts, and the requests a second person
 * approves: a reversal, or matching money that arrived before anyone knew its lease.
 */
export default async function PaymentPage({ params }: { readonly params: Params }) {
  const [{ paymentId }, me] = await Promise.all([params, getMe()]);
  if (!me) return null;
  if (!allowed(me, 'billing.view'))
    return (
      <>
        <PageHeader title="Payment" />
        <NoAccess what="payments" />
      </>
    );
  const loaded = await loadPayment(paymentId);
  if (!loaded.ok) {
    if (loaded.status !== 403) notFound();
    return (
      <>
        <PageHeader title="Payment" />
        <NoAccess what="this payment" />
      </>
    );
  }
  return (
    <PaymentDetailView
      initial={loaded.data}
      can={{
        manage: allowed(me, 'billing.manage'),
        match: allowed(me, 'payments.match'),
        seeApprovals: allowed(me, 'approval.view'),
        seeLease: allowed(me, 'lease.view'),
      }}
    />
  );
}
