import type { Metadata } from 'next';
import Link from 'next/link';
import { primaryLink, secondaryLink } from '@/components/link-styles';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';
import { PaymentsView } from './payments-view';

export const metadata: Metadata = { title: 'Payments' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Money received (BC-05, BC-07, P28; plan 4.19), with the ways to record it. */
export default async function PaymentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  if (!me || !allowed(me, 'billing.view')) {
    return (
      <>
        <PageHeader title="Payments" />
        <NoAccess what="payments" />
      </>
    );
  }
  const leaseId =
    typeof query.leaseId === 'string' && UUID.test(query.leaseId) ? query.leaseId : null;
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Payments"
          description="Each payment pays the lease’s oldest debt first; what is left over is held as credit. Cash, cheques and transfers post once a second person approves them."
        />
        <div className="flex flex-wrap gap-2">
          <Link href="/payments/unmatched" className={secondaryLink}>
            Unmatched receipts
          </Link>
          {allowed(me, 'payment.record_transfer') ? (
            <Link href="/payments/transfer" className={secondaryLink}>
              Record a transfer
            </Link>
          ) : null}
          {allowed(me, 'payment.record') ? (
            <Link href="/cash/new" className={primaryLink}>
              Record cash or cheque
            </Link>
          ) : null}
        </div>
      </div>
      <PaymentsView leaseId={leaseId} />
    </>
  );
}
