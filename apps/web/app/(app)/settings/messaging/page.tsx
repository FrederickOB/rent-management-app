import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { MessagingSettingsForm } from './messaging-settings-form';

export const metadata: Metadata = { title: 'Messaging settings' };

/** The response target, the conversation tags and the company's WhatsApp number (CM-06). */
export default async function MessagingSettingsPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Messaging settings',
    what: 'messaging settings',
    // As the API's GET: anyone who sees the company may read these (review note).
    needs: 'company.view',
  });
  if (refused) return refused;
  const canEdit = allowed(me, 'company.update');
  return (
    <>
      <PageHeader
        title="Messaging settings"
        description={
          canEdit
            ? 'How quickly staff should answer tenants, the tags conversations can carry, and the number your WhatsApp messages come from.'
            : 'You can view these settings. Ask an administrator to change them.'
        }
      />
      <MessagingSettingsForm canEdit={canEdit} />
    </>
  );
}
