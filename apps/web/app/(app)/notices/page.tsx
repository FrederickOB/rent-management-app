import type { Metadata } from 'next';
import Link from 'next/link';
import { primaryLink } from '@/components/link-styles';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { NoticesView } from './notices-view';

export const metadata: Metadata = { title: 'Notices' };

/**
 * The notices dashboard (LN-09): open notices by status and days outstanding, with filters by
 * type, property, outcome and "served too late". Growth only (decision 14).
 */
export default async function NoticesPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Notices',
    what: 'notices',
    needs: 'notices.read',
    feature: 'notices',
  });
  if (refused) return refused;
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Notices"
          description="Legal notices to tenants, from draft to closing. A notice never ends a tenancy by itself: possession needs a court or Rent Control order."
        />
        {allowed(me, 'notices.draft') ? (
          <Link href="/notices/new" className={primaryLink}>
            New notice
          </Link>
        ) : null}
      </div>
      <NoticesView />
    </>
  );
}
