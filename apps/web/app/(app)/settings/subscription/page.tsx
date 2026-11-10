import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { SubscriptionView } from './subscription-view';

export const metadata: Metadata = { title: 'Subscription' };

/**
 * Settings, Subscription (M10 plan 4.8; AD-08, PB-02 to PB-05, PB-07, PB-08, PB-10, PB-11): the
 * plan, its invoices and receipts, paying, changing plan, cancelling, the export and support
 * access. What each person may do comes from the API's `actions`; the API checks every call again.
 */
export default async function SubscriptionPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Subscription',
    what: 'the subscription',
    needs: 'subscription.read',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Subscription"
        description="Your plan is billed monthly in arrears: each unit with a lease on any day of the month, at its band’s rate, and never below the plan’s minimum. Vacant units are free."
      />
      <SubscriptionView canGrantSupport={allowed(me, 'support.grant')} />
    </>
  );
}
