import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { hasFeature } from '@/lib/plan';
import { allowed } from '@/lib/policy';
import { getCompany, getMe, loadTenant } from '@/lib/server/session';
import { TenantLimited, TenantProfile } from './tenant-profile';

type Params = Promise<{ readonly tenantId: string }>;

const tenant = cache((tenantId: string) => loadTenant(tenantId));

export async function generateMetadata({ params }: { readonly params: Params }): Promise<Metadata> {
  const loaded = await tenant((await params).tenantId);
  return { title: loaded.ok ? loaded.data.displayName : 'Tenant' };
}

/**
 * A tenant (TL-01 to TL-04): details, contacts and consent, the ID number masked with an audited
 * reveal, the ID check, tenancies and the timeline. A caretaker sees the name, phone and units.
 */
export default async function TenantPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ tenantId }, query, me, company] = await Promise.all([
    params,
    searchParams,
    getMe(),
    getCompany(),
  ]);
  if (!me) return null;
  const loaded = await tenant(tenantId);
  if (!loaded.ok) {
    // Outside this person's scope looks exactly like a tenant that does not exist (AD-02).
    if (loaded.status !== 403) notFound();
    return (
      <>
        <PageHeader title="Tenant" />
        <NoAccess what="this tenant" />
      </>
    );
  }
  if (loaded.data.access === 'limited') return <TenantLimited tenant={loaded.data} />;
  return (
    <TenantProfile
      initial={loaded.data}
      created={query.created === '1'}
      can={{
        manage: allowed(me, 'tenant.manage'),
        verify: allowed(me, 'tenant.id.verify'),
        reveal: allowed(me, 'tenant.id.reveal'),
        lease: allowed(me, 'lease.manage'),
        messages: allowed(me, 'messaging.inbox.read') && hasFeature(company, 'inbox'),
        write: allowed(me, 'messaging.reply') && hasFeature(company, 'inbox'),
      }}
    />
  );
}
