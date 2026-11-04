import type { Metadata } from 'next';
import Link from 'next/link';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { getCompany, getMe } from '@/lib/server/session';
import { BroadcastComposer } from './broadcast-composer';

export const metadata: Metadata = { title: 'New broadcast' };

/** Writing a broadcast, previewing who it reaches, and sending it (CM-08). */
export default async function NewBroadcastPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'New broadcast',
    what: 'broadcasts',
    needs: 'messaging.broadcast',
    feature: 'broadcasts',
  });
  if (refused) return refused;
  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/broadcasts" className="underline underline-offset-2">
          Broadcasts
        </Link>{' '}
        <span aria-hidden="true">›</span> <span>New broadcast</span>
      </nav>
      <PageHeader
        title="New broadcast"
        description="Write the message, check who it reaches, then send. It goes to current tenants only, each on the first channel they agreed to."
      />
      <BroadcastComposer />
    </>
  );
}
