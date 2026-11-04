import type { Metadata } from 'next';
import Link from 'next/link';
import { primaryLink } from '@/components/link-styles';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { getCompany, getMe } from '@/lib/server/session';
import { BroadcastsView } from './broadcasts-view';

export const metadata: Metadata = { title: 'Broadcasts' };

/** Broadcasts sent, newest first, with their delivery (CM-08). */
export default async function BroadcastsPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Broadcasts',
    what: 'broadcasts',
    needs: 'messaging.broadcast',
    feature: 'broadcasts',
  });
  if (refused) return refused;
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Broadcasts"
          description="One message to every current tenant of a property, some of its blocks, or a group. Each goes on the first channel the tenant agreed to."
        />
        <Link href="/broadcasts/new" className={primaryLink}>
          New broadcast
        </Link>
      </div>
      <BroadcastsView />
    </>
  );
}
