import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe, loadMemberships } from '@/lib/server/session';
import { AuditSearch, type AuditFilters } from './audit-search';

export const metadata: Metadata = { title: 'Audit log' };

const one = (value: string | string[] | undefined): string =>
  typeof value === 'string' ? value : '';

export default async function AuditPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  // The person filter lists names when this session may see the people; otherwise it takes an ID.
  const people = me && allowed(me, 'membership.view') ? await loadMemberships() : null;
  const initial: AuditFilters = {
    actorPersonId: one(query.person),
    recordType: one(query.recordType),
    recordId: one(query.recordId),
    action: one(query.action),
    from: one(query.from),
    to: one(query.to),
  };
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Who did what, and when, newest first. Entries cannot be changed or deleted."
      />
      <AuditSearch
        initial={initial}
        people={
          people?.ok ? people.data.map((m) => ({ personId: m.personId, name: m.name })) : null
        }
      />
    </>
  );
}
