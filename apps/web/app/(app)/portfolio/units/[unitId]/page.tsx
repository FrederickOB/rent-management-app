import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { hasFeature } from '@/lib/plan';
import { allowed } from '@/lib/policy';
import { getCompany, getMe, loadUnit } from '@/lib/server/session';
import { UnitDetail } from './unit-detail';

type Params = Promise<{ readonly unitId: string }>;

const unit = cache((unitId: string) => loadUnit(unitId));

export async function generateMetadata({ params }: { readonly params: Params }): Promise<Metadata> {
  const loaded = await unit((await params).unitId);
  return { title: loaded.ok ? loaded.data.code : 'Unit' };
}

/** One unit: details, availability with its history, billing band and meters (PR-02 to PR-09). */
export default async function UnitPage({ params }: { readonly params: Params }) {
  const [{ unitId }, me, company] = await Promise.all([params, getMe(), getCompany()]);
  if (!me) return null;
  const loaded = await unit(unitId);
  if (!loaded.ok) {
    if (loaded.status !== 403) notFound();
    return (
      <>
        <PageHeader title="Unit" />
        <NoAccess what="this unit" />
      </>
    );
  }
  return (
    <UnitDetail
      initial={loaded.data}
      can={{
        manage: allowed(me, 'register.manage'),
        overrideBand: allowed(me, 'unit.band_override'),
        seeLeases: allowed(me, 'lease.view'),
        draftLease: allowed(me, 'lease.manage'),
        conversations: allowed(me, 'messaging.inbox.read') && hasFeature(company, 'inbox'),
      }}
    />
  );
}
