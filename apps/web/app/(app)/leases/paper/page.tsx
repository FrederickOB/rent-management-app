import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { pickedTenantOf, pickedUnitOf } from '@/lib/record-picks';
import { getMe, loadTenant, loadUnit } from '@/lib/server/session';
import { PaperLeaseForm } from './paper-lease-form';

export const metadata: Metadata = { title: 'Record a paper lease' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idParam = (value: string | string[] | undefined) =>
  typeof value === 'string' && UUID.test(value) ? value : null;

/**
 * A lease already signed on paper (decision 7): the terms, who signed and when, and the scan. It
 * is recorded as signed on paper and claims no e-signature evidence.
 */
export default async function PaperLeasePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  if (!me || !allowed(me, 'lease.manage')) {
    return (
      <>
        <PageHeader title="Record a paper lease" />
        <NoAccess what="recording leases" />
      </>
    );
  }
  const unitId = idParam(query.unitId);
  const tenantId = idParam(query.tenantId);
  const [unit, tenant] = await Promise.all([
    unitId ? loadUnit(unitId) : null,
    tenantId ? loadTenant(tenantId) : null,
  ]);
  return (
    <>
      <PageHeader
        title="Record a paper lease"
        description="For a tenancy already signed on paper: enter its terms, who signed and when, and upload the signed copy. Nobody signs again."
      />
      <PaperLeaseForm
        initialUnit={unit?.ok ? pickedUnitOf(unit.data) : null}
        initialTenant={tenant?.ok ? pickedTenantOf(tenant.data) : null}
      />
    </>
  );
}
