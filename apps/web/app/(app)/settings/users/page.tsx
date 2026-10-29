import { DEFAULT_TIME_ZONE } from '@rent/domain/dates';
import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe, loadMemberships } from '@/lib/server/session';
import { UsersManager } from './users-manager';

export const metadata: Metadata = { title: 'Users and roles' };

export default async function UsersPage() {
  const [me, company, memberships] = await Promise.all([getMe(), getCompany(), loadMemberships()]);
  return (
    <>
      <PageHeader
        title="Users and roles"
        description="Who works in this company, what they do and what they can see."
      />
      {/* A refusal from the API hides the section; the server is the authority, not this page. */}
      {me && memberships.ok ? (
        <UsersManager
          initialRows={memberships.data}
          canManage={allowed(me, 'membership.manage')}
          canSearchAudit={allowed(me, 'audit.search')}
          selfPersonId={me.personId}
          timeZone={company?.timeZone ?? DEFAULT_TIME_ZONE}
        />
      ) : (
        <NoAccess what="users and roles" />
      )}
    </>
  );
}
