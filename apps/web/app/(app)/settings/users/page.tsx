import { DEFAULT_TIME_ZONE } from '@rent/domain/dates';
import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import {
  getCompany,
  getMe,
  loadMemberships,
  loadOwners,
  loadPropertyList,
} from '@/lib/server/session';
import { UsersManager } from './users-manager';

export const metadata: Metadata = { title: 'Users and roles' };

export default async function UsersPage() {
  const [me, company, memberships] = await Promise.all([getMe(), getCompany(), loadMemberships()]);
  // The access pickers list owners and properties (AD-02), where this session may see them.
  const [owners, properties] = await Promise.all([
    me && allowed(me, 'owner.view') ? loadOwners(true) : null,
    me && allowed(me, 'register.view') ? loadPropertyList() : null,
  ]);
  const membership = me?.memberships.find((m) => m.companyId === me.activeCompanyId);
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
          companyKind={membership?.companyKind ?? company?.kind ?? 'landlord'}
          scopeOptions={{
            owners: owners?.ok
              ? owners.data.map((o) => ({
                  value: o.id,
                  label: o.displayName,
                  hint: o.archived ? `${o.reference}, archived` : o.reference,
                }))
              : null,
            properties: properties?.ok
              ? properties.data.rows.map((p) => ({ value: p.id, label: p.code, hint: p.name }))
              : null,
          }}
        />
      ) : (
        <NoAccess what="users and roles" />
      )}
    </>
  );
}
