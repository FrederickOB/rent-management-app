import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { getCompany, getMe } from '@/lib/server/session';
import { PlansView } from './plans-view';

export const metadata: Metadata = { title: 'Company plans' };

/** Each company's interim plan (M6 decision 9). Subscriptions replace it in M10. */
export default async function CompanyPlansPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Company plans',
    what: 'company plans',
    needs: 'company.plan.manage',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Company plans"
        description="Starter has WhatsApp reminders and the assistant’s short menu. Growth adds the inbox, broadcasts, tenant groups and repairs. Each change is recorded in the company’s audit log."
      />
      <PlansView />
    </>
  );
}
