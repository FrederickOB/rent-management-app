import type { Metadata } from 'next';
import Link from 'next/link';
import { secondaryLink } from '@/components/link-styles';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';
import { UnmatchedView } from './unmatched-view';

export const metadata: Metadata = { title: 'Unmatched receipts' };

/**
 * The unmatched queue (BC-12, P23, P31; M4b plan 4.5): money that matched no pay link and no
 * exact payment reference, and transfers recorded without a lease. It waits in suspense in the
 * book of whoever received it. The API suggests leases, ranked; a person confirms each match,
 * or asks to refund money that belongs to no one, which a second person approves.
 */
export default async function UnmatchedPage() {
  const me = await getMe();
  if (!me || !(allowed(me, 'billing.view') || allowed(me, 'payments.view'))) {
    return (
      <>
        <PageHeader title="Unmatched receipts" />
        <NoAccess what="unmatched receipts" />
      </>
    );
  }
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Unmatched receipts"
          description="Money that arrived without a pay link or a payment reference we could read, and transfers recorded before anyone knew the lease. Suggestions are ranked by the amount, the payer’s phone, the date and earlier payments; a person confirms each match."
        />
        {allowed(me, 'payment.record_transfer') ? (
          <Link href="/payments/transfer" className={secondaryLink}>
            Record a transfer
          </Link>
        ) : null}
      </div>
      <UnmatchedView
        can={{
          match: allowed(me, 'payments.match'),
          refund: allowed(me, 'payment.refund_unmatched'),
          seeApprovals: allowed(me, 'approval.view'),
        }}
      />
    </>
  );
}
