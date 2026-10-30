import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { pickedLeaseOf } from '@/lib/lease-pick';
import { allowed } from '@/lib/policy';
import { getMe, loadLease, loadMemberships } from '@/lib/server/session';
import { CashForm } from './cash-form';

export const metadata: Metadata = { title: 'Record cash or cheque' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cash or a cheque received (BC-05): the lease, the payer, the date and a photo of the
 * receipt-book page or the cheque. Nothing posts until a second person approves it (P06).
 */
export default async function RecordCashPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  if (!me || !allowed(me, 'payment.record')) {
    return (
      <>
        <PageHeader title="Record cash or cheque" />
        <NoAccess what="recording cash" />
      </>
    );
  }
  const leaseId =
    typeof query.leaseId === 'string' && UUID.test(query.leaseId) ? query.leaseId : null;
  const [lease, people] = await Promise.all([
    leaseId ? loadLease(leaseId) : null,
    // Naming someone else as holding the money needs cash.bank_others (the API refuses it
    // otherwise), and the list of people needs membership.view.
    allowed(me, 'cash.bank_others') && allowed(me, 'membership.view') ? loadMemberships() : null,
  ]);
  const collectors = people?.ok
    ? people.data
        .filter((p) => p.status === 'active' && p.personId !== me.personId)
        .map((p) => ({ id: p.personId, name: p.name }))
    : [];
  return (
    <>
      <PageHeader
        title="Record cash or cheque"
        description="Record it the day it is received, with a photo of the receipt-book page or the cheque. It posts, and the receipt is issued, once a second person approves it."
      />
      <CashForm
        initialLease={lease?.ok ? pickedLeaseOf(lease.data) : null}
        collectors={collectors}
        seeLease={allowed(me, 'lease.view')}
      />
    </>
  );
}
