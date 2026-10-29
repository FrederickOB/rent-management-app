import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';
import { NewTenantForm } from './new-tenant-form';

export const metadata: Metadata = { title: 'New tenant' };

/** A new tenant, a person or a company, with contacts and consent per channel (TL-01 to TL-04). */
export default async function NewTenantPage() {
  const me = await getMe();
  if (!me || !allowed(me, 'tenant.manage')) {
    return (
      <>
        <PageHeader title="New tenant" />
        <NoAccess what="adding tenants" />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="New tenant"
        description="Add the person or company who rents, how to reach them, and what messages they agreed to."
      />
      <NewTenantForm />
    </>
  );
}
