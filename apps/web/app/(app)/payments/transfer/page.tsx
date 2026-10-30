import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { pickedLeaseOf } from '@/lib/lease-pick';
import { allowed } from '@/lib/policy';
import { getMe, loadLease, loadOwners } from '@/lib/server/session';
import { TransferForm } from './transfer-form';

export const metadata: Metadata = { title: 'Record a transfer' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A transfer straight into the owner's or the agency's account (P28), recorded with proof. A
 * second person approves it before it posts. Without a lease it waits as unmatched (P23).
 */
export default async function TransferPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  if (!me || !allowed(me, 'payment.record_transfer')) {
    return (
      <>
        <PageHeader title="Record a transfer" />
        <NoAccess what="recording transfers" />
      </>
    );
  }
  const leaseId =
    typeof query.leaseId === 'string' && UUID.test(query.leaseId) ? query.leaseId : null;
  const [lease, owners] = await Promise.all([
    leaseId ? loadLease(leaseId) : null,
    allowed(me, 'owner.view') ? loadOwners() : null,
  ]);
  const membership = me.memberships.find((m) => m.companyId === me.activeCompanyId);
  return (
    <>
      <PageHeader
        title="Record a transfer"
        description="Money the tenant sent straight to a bank or mobile money account. Attach the proof; it posts once a second person approves it."
      />
      <TransferForm
        initialLease={lease?.ok ? pickedLeaseOf(lease.data) : null}
        owners={
          owners?.ok
            ? owners.data
                .filter((o) => !o.archived)
                .map((o) => ({ id: o.id, label: `${o.displayName} (${o.reference})` }))
            : []
        }
        agency={membership?.companyKind === 'agency'}
      />
    </>
  );
}
