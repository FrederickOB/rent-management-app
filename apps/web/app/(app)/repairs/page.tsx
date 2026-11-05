import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { MaintenanceLaterNote } from '@/components/maintenance-later-note';
import { getCompany, getMe } from '@/lib/server/session';
import { RepairsView } from './repairs-view';

export const metadata: Metadata = { title: 'Reported repairs' };

/**
 * Repairs tenants reported to the WhatsApp assistant (CM-04 stub; M6 decision 12). Read-only:
 * the maintenance board, with triage, artisans and costs, arrives in M8 on the same records.
 */
export default async function RepairsPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Reported repairs',
    what: 'reported repairs',
    needs: 'maintenance.view',
    feature: 'maintenance',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Reported repairs"
        description="What tenants reported to the WhatsApp assistant, with the ticket number they were given and their photos, videos and voice notes."
      />
      <MaintenanceLaterNote />
      <RepairsView />
    </>
  );
}
