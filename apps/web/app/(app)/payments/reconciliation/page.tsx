import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';
import { ReconciliationView } from './reconciliation-view';

export const metadata: Metadata = { title: 'Reconciliation' };

/**
 * What the nightly reconciliation could not explain (CLAUDE.md section 8; M4b plan 4.8): the
 * provider's transactions against our payments, and each settlement against the payments it
 * paid out. A person looks into each one and records what they found.
 */
export default async function ReconciliationPage() {
  const me = await getMe();
  if (!me || !allowed(me, 'payments.view')) {
    return (
      <>
        <PageHeader title="Reconciliation" />
        <NoAccess what="reconciliation" />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Reconciliation"
        description="Each night the payment provider’s records are checked against ours, and each settlement against the payments it paid out. Anything that does not add up waits here for a person."
      />
      <ReconciliationView canResolve={allowed(me, 'payments.match')} />
    </>
  );
}
