import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { usersByOwner } from '@/lib/owner-users';
import { allowed } from '@/lib/policy';
import { getCompany, getMe, loadMemberships, loadOwners } from '@/lib/server/session';
import { OwnersManager } from './owners-manager';

export const metadata: Metadata = { title: 'Owners' };

/** Owner records (AD-02): an agency's clients, or the landlord in their own company. */
export default async function OwnersPage() {
  const me = await getMe();
  if (!me || !allowed(me, 'owner.view')) {
    return (
      <>
        <PageHeader title="Owners" />
        <NoAccess what="owners" />
      </>
    );
  }
  // The people linked to each owner show only to those who may list people (membership.view);
  // the list call must succeed too, as the API decides in the end.
  const [owners, people, company] = await Promise.all([
    loadOwners(true),
    allowed(me, 'membership.view') ? loadMemberships() : null,
    getCompany(),
  ]);
  const companyKind =
    me.memberships.find((m) => m.companyId === me.activeCompanyId)?.companyKind ??
    company?.kind ??
    'landlord';
  const linkedUsers = people?.ok ? usersByOwner(people.data, companyKind) : null;
  return (
    <>
      <PageHeader
        title="Owners"
        description="Who owns each property, and how to reach them. Owners are archived, never deleted."
      />
      {owners.ok ? (
        <OwnersManager
          initialRows={owners.data}
          canManage={allowed(me, 'owner.manage')}
          linkedUsers={linkedUsers}
        />
      ) : (
        <NoAccess what="owners" />
      )}
    </>
  );
}
