import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pageRefusal } from '@/components/page-refusal';
import { getCompany, getMe } from '@/lib/server/session';
import { GroupDetail } from './group-detail';

export const metadata: Metadata = { title: 'Tenant group' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One tenant group: its name, members, and archiving it (CM-08). */
export default async function TenantGroupPage({
  params,
}: {
  readonly params: Promise<{ readonly groupId: string }>;
}) {
  const [{ groupId }, me, company] = await Promise.all([params, getMe(), getCompany()]);
  if (!me) return null;
  if (!UUID.test(groupId)) notFound();
  const refused = pageRefusal(me, company, {
    title: 'Tenant group',
    what: 'tenant groups',
    needs: 'tenant_group.manage',
    feature: 'tenant_groups',
  });
  if (refused) return refused;
  return <GroupDetail groupId={groupId} />;
}
