import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { pickedTenantOf, pickedUnitOf } from '@/lib/record-picks';
import { getMe, loadTemplates, loadTenant, loadUnit } from '@/lib/server/session';
import { LeaseBuilder } from '../lease-builder';

export const metadata: Metadata = { title: 'New lease' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idParam = (value: string | string[] | undefined) =>
  typeof value === 'string' && UUID.test(value) ? value : null;

/** The lease builder (TL-05, TL-06): a new draft, from a unit or a tenant page or from scratch. */
export default async function NewLeasePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  if (!me || !allowed(me, 'lease.manage')) {
    return (
      <>
        <PageHeader title="New lease" />
        <NoAccess what="drafting leases" />
      </>
    );
  }
  const unitId = idParam(query.unitId);
  const tenantId = idParam(query.tenantId);
  const [unit, tenant, templates] = await Promise.all([
    unitId ? loadUnit(unitId) : null,
    tenantId ? loadTenant(tenantId) : null,
    loadTemplates(),
  ]);
  return (
    <>
      <PageHeader
        title="New lease"
        description="Choose the unit, the tenant and a template, set the terms, and save a draft. You can add the signers and check the document before it is issued."
      />
      <LeaseBuilder
        initialUnit={unit?.ok ? pickedUnitOf(unit.data) : null}
        initialTenant={tenant?.ok ? pickedTenantOf(tenant.data) : null}
        templates={templates.ok ? templates.data : []}
      />
    </>
  );
}
