import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { getCompany, getMe } from '@/lib/server/session';
import { TemplatesView } from './templates-view';

export const metadata: Metadata = { title: 'Message templates' };

/** Each WhatsApp template's text and its approval per number (CM-07). */
export default async function TemplatesPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Message templates',
    what: 'message templates',
    needs: 'messaging.templates.read',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Message templates"
        description="Outside the 24 hours after a tenant’s last WhatsApp message, WhatsApp takes only templates Meta has approved. Without an approved one, the message goes by the next channel the tenant agreed to."
      />
      <TemplatesView />
    </>
  );
}
