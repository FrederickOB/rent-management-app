import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe, loadMemberships } from '@/lib/server/session';
import { ApprovalsView } from './approvals-view';

export const metadata: Metadata = { title: 'Approvals' };

/**
 * Requests that need a second person (AD-05; M3 decision 6), such as cancelling a signed lease
 * before it starts. Whoever asked can never approve their own request.
 */
export default async function ApprovalsPage() {
  const me = await getMe();
  if (!me || !allowed(me, 'approval.view')) {
    return (
      <>
        <PageHeader title="Approvals" />
        <NoAccess what="approvals" />
      </>
    );
  }
  // Names for "who asked" and "who decided", when this session may list people.
  const people = allowed(me, 'membership.view') ? await loadMemberships() : null;
  const names: [string, string][] = people?.ok ? people.data.map((p) => [p.personId, p.name]) : [];
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Requests that need a second person before they take effect. Whoever asked cannot approve their own request."
      />
      <ApprovalsView names={names} />
    </>
  );
}
