import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { NotOnPlan } from '@/components/not-on-plan';
import { PageHeader } from '@/components/page-header';
import { hasFeature } from '@/lib/plan';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { ThreadView } from './thread-view';

export const metadata: Metadata = { title: 'Conversation' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One conversation (CM-05): every message on every channel in order, with its delivery status,
 * the composer, and assigning, tagging and resolving (CM-06). `?since=` limits the thread to a
 * lease's term, as the unit page links it.
 */
export default async function ConversationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly conversationId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ conversationId }, query, me, company] = await Promise.all([
    params,
    searchParams,
    getMe(),
    getCompany(),
  ]);
  if (!me) return null;
  if (!UUID.test(conversationId)) notFound();
  if (!allowed(me, 'messaging.inbox.read')) {
    return (
      <>
        <PageHeader title="Conversation" />
        <NoAccess what="the inbox" />
      </>
    );
  }
  if (!hasFeature(company, 'inbox')) {
    return (
      <>
        <PageHeader title="Conversation" />
        <NotOnPlan feature="inbox" plan={company?.plan} />
      </>
    );
  }
  const since = typeof query.since === 'string' && ISO_DATE.test(query.since) ? query.since : null;
  return (
    <ThreadView
      conversationId={conversationId}
      since={since}
      canLogRepair={allowed(me, 'maintenance.report') && hasFeature(company, 'maintenance')}
    />
  );
}
