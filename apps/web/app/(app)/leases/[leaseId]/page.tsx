import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe, loadLease } from '@/lib/server/session';
import { LeaseDetail, LeaseLimited } from './lease-detail';

type Params = Promise<{ readonly leaseId: string }>;

const lease = cache((leaseId: string) => loadLease(leaseId));

export async function generateMetadata({ params }: { readonly params: Params }): Promise<Metadata> {
  const loaded = await lease((await params).leaseId);
  return { title: loaded.ok ? `Lease ${loaded.data.unit.code}` : 'Lease' };
}

/**
 * A lease (TL-06, TL-09, TX-05, PB-09): status, terms and schedule, parties and documents, the
 * trackers, and what can be done next. A caretaker sees the unit and the dates.
 */
export default async function LeasePage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ leaseId }, query, me] = await Promise.all([params, searchParams, getMe()]);
  if (!me) return null;
  const loaded = await lease(leaseId);
  if (!loaded.ok) {
    if (loaded.status !== 403) notFound();
    return (
      <>
        <PageHeader title="Lease" />
        <NoAccess what="this lease" />
      </>
    );
  }
  if (loaded.data.access === 'limited') return <LeaseLimited lease={loaded.data} />;
  const saved = typeof query.saved === 'string' ? query.saved : null;
  return (
    <LeaseDetail
      initial={loaded.data}
      saved={saved}
      can={{
        manage: allowed(me, 'lease.manage'),
        cancelSigned: allowed(me, 'lease.cancel_signed'),
        seeApprovals: allowed(me, 'approval.view'),
        seeTenant: allowed(me, 'tenant.view'),
      }}
    />
  );
}
