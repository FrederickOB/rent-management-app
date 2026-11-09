import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { BillingView } from './billing-view';

export const metadata: Metadata = { title: 'Plans and billing' };

/**
 * Plans and billing (AD-10; M10 decisions 3, 8, 10 and 15): price lists, the subscription terms,
 * discount codes and the WhatsApp rate table. Every change is a new version from a date; nothing
 * is edited.
 */
export default async function PlatformBillingPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Plans and billing',
    what: 'the platform’s prices and terms',
    needs: ['pricing.manage', 'discount.manage'],
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Plans and billing"
        description="Prices, terms and rates change by adding a new version from a date; past versions stay as they were, so past invoices never change."
      />
      <BillingView
        can={{ pricing: allowed(me, 'pricing.manage'), discounts: allowed(me, 'discount.manage') }}
      />
    </>
  );
}
