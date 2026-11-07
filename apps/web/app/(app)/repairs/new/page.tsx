import type { Metadata } from 'next';
import Link from 'next/link';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { getCompany, getMe } from '@/lib/server/session';
import { ReportRepairForm } from './report-form';

export const metadata: Metadata = { title: 'Log a repair' };

/**
 * Staff and caretakers log a repair for a unit or a common area (CM-04, M8 plan 4.3), with its
 * photos, videos and voice notes. An emergency alerts the property's managers and caretakers at
 * once (decision 5). Growth only, with the board (decision 1).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const param = (value: string | string[] | undefined): string =>
  typeof value === 'string' && UUID.test(value) ? value : '';

export default async function NewRepairPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, company, query] = await Promise.all([getMe(), getCompany(), searchParams]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Log a repair',
    what: 'logging repairs',
    needs: 'maintenance.report',
    feature: 'maintenance',
  });
  if (refused) return refused;
  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/repairs" className="underline underline-offset-2">
          Maintenance board
        </Link>{' '}
        <span aria-hidden="true">›</span> <span>Log a repair</span>
      </nav>
      <PageHeader
        title="Log a repair"
        description="For a repair someone told you about, or one you found. A repair from SMS or email is logged from its conversation in the inbox."
      />
      <ReportRepairForm
        initial={{
          propertyId: param(query.propertyId),
          unitId: param(query.unitId),
          conversationId: param(query.conversationId),
        }}
      />
    </>
  );
}
