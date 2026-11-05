import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { getCompany, getMe } from '@/lib/server/session';
import { ArtisansView } from './artisans-view';

export const metadata: Metadata = { title: 'Artisans' };

/**
 * Artisans (MI-04; M8 decision 6): the people work is sent to, with the channels they agreed to be
 * contacted on. Archived, never deleted. Growth only (decision 1).
 */
export default async function ArtisansPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Artisans',
    what: 'artisans',
    needs: 'artisan.manage',
    feature: 'maintenance',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Artisans"
        description="Plumbers, electricians and others you send repairs to. A job sheet goes to them by WhatsApp or SMS, only on a channel they agreed to. No rates, ratings or bank details are kept."
      />
      <ArtisansView />
    </>
  );
}
