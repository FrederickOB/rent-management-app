import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { NotOnPlan } from '@/components/not-on-plan';
import { PageHeader } from '@/components/page-header';
import { isInboxView } from '@/lib/inbox';
import { hasFeature } from '@/lib/plan';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { InboxView } from './inbox-view';

export const metadata: Metadata = { title: 'Inbox' };

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * The unified inbox (CM-05, CM-06; M6 plan 4.6 and 4.11): one conversation per tenant across
 * WhatsApp, SMS, email and the app, with views, search and live updates.
 */
export default async function InboxPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, company, query] = await Promise.all([getMe(), getCompany(), searchParams]);
  if (!me) return null;
  if (!allowed(me, 'messaging.inbox.read')) {
    return (
      <>
        <PageHeader title="Inbox" />
        <NoAccess what="the inbox" />
      </>
    );
  }
  if (!hasFeature(company, 'inbox')) {
    return (
      <>
        <PageHeader title="Inbox" />
        <NotOnPlan
          feature="inbox"
          plan={company?.plan}
          canSeePlan={allowed(me, 'subscription.read')}
        />
      </>
    );
  }
  const view = first(query.view);
  return (
    <>
      <PageHeader
        title="Inbox"
        description="Every conversation with your tenants, on WhatsApp, SMS, email and the app. Messages are kept as they were sent: none can be edited or deleted."
      />
      <InboxView
        initial={{
          view: isInboxView(view) ? view : 'all',
          tag: first(query.tag) ?? '',
          propertyId: first(query.propertyId) ?? '',
          q: first(query.q) ?? '',
        }}
      />
    </>
  );
}
