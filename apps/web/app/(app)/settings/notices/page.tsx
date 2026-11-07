import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { NoticeSettingsForm } from './notice-settings-form';
import { QuitAcknowledgementCard } from './quit-acknowledgement';

export const metadata: Metadata = { title: 'Notice settings' };

/**
 * Notice settings (M7 plan 4.9 and 4.10): the OQ-16 acknowledgement that turns notices to quit on
 * (decision 9), the reminder ladder per notice type (LN-05), the sending window (decision 11) and
 * how long links last for types without a notice period (LN-02). Product settings, not law.
 */
export default async function NoticeSettingsPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Notice settings',
    what: 'notice settings',
    needs: ['company.view'],
    feature: 'notices',
  });
  if (refused || !company) return refused;
  return (
    <>
      <PageHeader
        title="Notice settings"
        description="Notices to quit, the reminders after a notice is issued, the hours tenants may be messaged, and how long links last."
      />
      <QuitAcknowledgementCard />
      <NoticeSettingsForm company={company} canEdit={allowed(me, 'company.update')} />
    </>
  );
}
