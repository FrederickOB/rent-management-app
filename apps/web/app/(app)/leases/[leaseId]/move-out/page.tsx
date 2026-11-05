import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { hasFeature } from '@/lib/plan';
import { allowed } from '@/lib/policy';
import { getCompany, getMe, loadLease } from '@/lib/server/session';
import { MoveOutView } from './move-out-view';

export const metadata: Metadata = { title: 'Move-out' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The move-out of a lease (TL-11, MI-11; M8 decision 12 and plan 4.8), on every plan: plan it,
 * the inspection compared with the move-in report, deductions with their photos, agreed charges
 * for an early end, the final statement, one approval and the refund recorded as paid.
 */
export default async function MoveOutPage({
  params,
}: {
  readonly params: Promise<{ readonly leaseId: string }>;
}) {
  const [{ leaseId }, me, company] = await Promise.all([params, getMe(), getCompany()]);
  if (!me) return null;
  if (!UUID.test(leaseId)) notFound();
  const refused = pageRefusal(me, company, {
    title: 'Move-out',
    what: 'move-outs',
    needs: ['moveout.manage', 'moveout.settle'],
  });
  if (refused) return refused;
  const loaded = await loadLease(leaseId);
  if (!loaded.ok) {
    if (loaded.status !== 403) notFound();
    return (
      <>
        <PageHeader title="Move-out" />
        <NoAccess what="this lease" />
      </>
    );
  }
  if (loaded.data.access !== 'full')
    return (
      <>
        <PageHeader title="Move-out" />
        <NoAccess what="this lease’s move-out" />
      </>
    );
  return (
    <MoveOutView
      lease={loaded.data}
      can={{
        manage: allowed(me, 'moveout.manage'),
        seeMoney: allowed(me, 'billing.view'),
        seeApprovals: allowed(me, 'approval.view'),
        seeNotices: allowed(me, 'notices.read') && hasFeature(company, 'notices'),
        agency:
          me.memberships.find((m) => m.companyId === me.activeCompanyId)?.companyKind === 'agency',
      }}
    />
  );
}
