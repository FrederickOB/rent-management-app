import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pageRefusal } from '@/components/page-refusal';
import { getCompany, getMe } from '@/lib/server/session';
import { BroadcastDetailView } from './broadcast-detail';

export const metadata: Metadata = { title: 'Broadcast' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One broadcast: its text, audience and delivery per channel and per tenant (CM-08). */
export default async function BroadcastPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly broadcastId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ broadcastId }, query, me, company] = await Promise.all([
    params,
    searchParams,
    getMe(),
    getCompany(),
  ]);
  if (!me) return null;
  if (!UUID.test(broadcastId)) notFound();
  const refused = pageRefusal(me, company, {
    title: 'Broadcast',
    what: 'broadcasts',
    needs: 'messaging.broadcast',
    feature: 'broadcasts',
  });
  if (refused) return refused;
  return <BroadcastDetailView broadcastId={broadcastId} justSent={query.sent === '1'} />;
}
