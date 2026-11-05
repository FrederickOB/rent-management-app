import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pageRefusal } from '@/components/page-refusal';
import { hasFeature } from '@/lib/plan';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { RepairDetail } from './repair-detail';

export const metadata: Metadata = { title: 'Repair' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One job (MI-01 to MI-06, CM-04; M8 plan 4.11): the timeline, its files with players, the steps
 * the reader may take (the API's `actions`), its expenses and cost. Read-only for accountants, an
 * agency's client owners and advisers (decision 9).
 */
export default async function RepairPage({
  params,
}: {
  readonly params: Promise<{ readonly jobId: string }>;
}) {
  const [{ jobId }, me, company] = await Promise.all([params, getMe(), getCompany()]);
  if (!me) return null;
  if (!UUID.test(jobId)) notFound();
  const refused = pageRefusal(me, company, {
    title: 'Repair',
    what: 'repairs',
    needs: ['maintenance.view', 'maintenance.read'],
    feature: 'maintenance',
  });
  if (refused) return refused;
  return (
    <RepairDetail
      jobId={jobId}
      can={{
        openConversation: allowed(me, 'messaging.inbox.read') && hasFeature(company, 'inbox'),
        seeTenant: allowed(me, 'tenant.view'),
        seeUnit: allowed(me, 'register.view'),
        listStaff: allowed(me, 'maintenance.manage') && allowed(me, 'membership.view'),
        listArtisans: allowed(me, 'maintenance.manage'),
        seeExpenses: allowed(me, 'expense.read'),
      }}
    />
  );
}
