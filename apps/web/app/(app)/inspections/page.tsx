import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { hasFeature } from '@/lib/plan';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { InspectionsView } from './inspections-view';

export const metadata: Metadata = { title: 'Inspections' };

/**
 * Inspections (MI-10; M8 decision 10): move-in and move-out on every plan, routine ones on Growth
 * (decision 1). Move-in and move-out inspections start from the lease; routine ones here.
 */
export default async function InspectionsPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Inspections',
    what: 'inspections',
    needs: 'inspection.read',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Inspections"
        description="Room by room, each item with its condition, a note and photos stamped with the server’s time. A move-in inspection becomes the move-in report both parties sign; a move-out one is compared with it."
      />
      <InspectionsView
        canStartRoutine={allowed(me, 'inspection.perform') && hasFeature(company, 'maintenance')}
      />
    </>
  );
}
