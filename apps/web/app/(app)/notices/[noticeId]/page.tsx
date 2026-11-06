import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pageRefusal } from '@/components/page-refusal';
import { getCompany, getMe } from '@/lib/server/session';
import { NoticeTracker } from './notice-tracker';

export const metadata: Metadata = { title: 'Notice' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One notice (LN-02 to LN-05, LN-07): a draft with its preview and checks, or an issued notice
 * with each recipient's events, delivery per channel, the ladder, the service pack, physical
 * service, closing and correcting. Every control follows the API's `actions`.
 */
export default async function NoticePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly noticeId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ noticeId }, query, me, company] = await Promise.all([
    params,
    searchParams,
    getMe(),
    getCompany(),
  ]);
  if (!me) return null;
  if (!UUID.test(noticeId)) notFound();
  const refused = pageRefusal(me, company, {
    title: 'Notice',
    what: 'notices',
    needs: 'notices.read',
    feature: 'notices',
  });
  if (refused) return refused;
  return <NoticeTracker noticeId={noticeId} saved={query.saved === '1'} personId={me.personId} />;
}
