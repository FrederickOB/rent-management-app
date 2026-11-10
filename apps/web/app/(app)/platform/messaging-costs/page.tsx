import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { getCompany, getMe } from '@/lib/server/session';
import { SMS_COST_NOTE, WHATSAPP_COST_NOTE } from '@/lib/subscription';
import { MessagingCostsView } from './messaging-costs-view';

export const metadata: Metadata = { title: 'Messaging costs' };

/** Usage and messaging costs per company and month (AD-10; M10 decision 15). */
export default async function PlatformMessagingCostsPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Messaging costs',
    what: 'usage and messaging costs',
    needs: 'usage.read',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Messaging costs"
        description={`Units, billing and messages for each company in a month. ${SMS_COST_NOTE} ${WHATSAPP_COST_NOTE}`}
      />
      <MessagingCostsView />
    </>
  );
}
