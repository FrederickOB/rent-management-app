import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pageRefusal } from '@/components/page-refusal';
import { getCompany, getMe } from '@/lib/server/session';
import { InspectionForm } from './inspection-form';

export const metadata: Metadata = { title: 'Inspection' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One inspection (MI-10), filled in room by room on a phone's browser (decision 10): condition,
 * note and photos per item; a move-out one shows the move-in result beside each item. The API's
 * `actions` say whether it can still be edited, submitted or corrected.
 */
export default async function InspectionPage({
  params,
}: {
  readonly params: Promise<{ readonly inspectionId: string }>;
}) {
  const [{ inspectionId }, me, company] = await Promise.all([params, getMe(), getCompany()]);
  if (!me) return null;
  if (!UUID.test(inspectionId)) notFound();
  const refused = pageRefusal(me, company, {
    title: 'Inspection',
    what: 'inspections',
    needs: 'inspection.read',
  });
  if (refused) return refused;
  return <InspectionForm inspectionId={inspectionId} />;
}
