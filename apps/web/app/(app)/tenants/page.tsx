import type { Metadata } from 'next';
import Link from 'next/link';
import { primaryLink } from '@/components/link-styles';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';
import { TenantsView } from './tenants-view';

export const metadata: Metadata = { title: 'Tenants' };

/** Tenants this person may see (TL-01): search by name, phone and unit, filter by lease and ID. */
export default async function TenantsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  if (!me || !allowed(me, 'tenant.view')) {
    return (
      <>
        <PageHeader title="Tenants" />
        <NoAccess what="tenants" />
      </>
    );
  }
  const search = typeof query.search === 'string' ? query.search : '';
  const details = allowed(me, 'tenant.view_details');
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Tenants"
          description={
            details
              ? 'People and companies who rent from you, with their contacts, consent and ID checks.'
              : 'The tenants on the properties you look after: their names, phones and units.'
          }
        />
        {allowed(me, 'tenant.manage') ? (
          <Link href="/tenants/new" className={primaryLink}>
            New tenant
          </Link>
        ) : null}
      </div>
      <TenantsView initialSearch={search} details={details} />
    </>
  );
}
