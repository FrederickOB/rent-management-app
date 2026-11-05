import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { getCompany, getMe } from '@/lib/server/session';
import { GroupsView } from './groups-view';

export const metadata: Metadata = { title: 'Tenant groups' };

/** Named groups of tenants to broadcast to (CM-08). */
export default async function TenantGroupsPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Tenant groups',
    what: 'tenant groups',
    needs: 'tenant_group.manage',
    feature: 'tenant_groups',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Tenant groups"
        description="Groups of tenants you send broadcasts to, such as the shop tenants or a residents’ committee. A broadcast reaches only the members who are current tenants."
      />
      <GroupsView />
    </>
  );
}
