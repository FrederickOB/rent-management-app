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
 * Money received before anyone knew its lease (P23): it waits in suspense in the book of whoever
 * received it until a person matches it to a lease. M4b adds provider payments and suggestions.
 */
export default async function UnmatchedPage() {
  const me = await getMe();
  if (!me || !allowed(me, 'billing.view')) {
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
          description="Transfers recorded before anyone knew which lease they pay for. Matching one pays that lease’s oldest debt first."
        />
        {allowed(me, 'payment.record_transfer') ? (
          <Link href="/payments/transfer" className={secondaryLink}>
            Record a transfer
          </Link>
        ) : null}
      </div>
      <UnmatchedView canMatch={allowed(me, 'billing.manage')} />
    </>
  );
}
