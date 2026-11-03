import type { Metadata } from 'next';
import Link from 'next/link';
import { primaryLink, secondaryLink } from '@/components/link-styles';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';
import { LeasesView } from './leases-view';

export const metadata: Metadata = { title: 'Leases' };

/** Every lease this person may see (TL-06), by status, with the ways to add one. */
export default async function LeasesPage() {
  const me = await getMe();
  if (!me || !allowed(me, 'lease.view')) {
    return (
      <>
        <PageHeader title="Leases" />
        <NoAccess what="leases" />
      </>
    );
  }
  const manage = allowed(me, 'lease.manage');
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Leases"
          description="Drafts, signed and current leases, and those that have ended."
        />
        <div className="flex flex-wrap gap-2">
          <Link href="/leases/expiring" className={secondaryLink}>
            Ending soon
          </Link>
          {manage ? (
            <>
              <Link href="/leases/paper" className={secondaryLink}>
                Record a paper lease
              </Link>
              <Link href="/leases/new" className={primaryLink}>
                New lease
              </Link>
            </>
          ) : null}
        </div>
      </div>
      <LeasesView detailed={allowed(me, 'lease.view_terms')} />
    </>
  );
}
