import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe, loadOwners } from '@/lib/server/session';
import { GraPaymentForm } from './gra-payment-form';

export const metadata: Metadata = { title: 'Record a GRA payment' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rent tax paid to GRA (TX-03, P18): the date, amount and GRA receipt, the account it came from,
 * and the tax items it settles, oldest first unless chosen otherwise. Accountants and admins
 * record it (tax.manage; plan decision 5).
 */
export default async function GraPaymentPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  if (!me || !allowed(me, 'tax.manage'))
    return (
      <>
        <PageHeader title="Record a GRA payment" />
        <NoAccess what="recording GRA payments" />
      </>
    );
  const owners = await loadOwners();
  const ownerId =
    typeof query.ownerId === 'string' && UUID.test(query.ownerId) ? query.ownerId : null;
  const membership = me.memberships.find((m) => m.companyId === me.activeCompanyId);
  return (
    <>
      <PageHeader
        title="Record a GRA payment"
        description="Rent tax paid to GRA, with GRA’s receipt. It settles the tax items you choose; the oldest are chosen first."
      />
      <GraPaymentForm
        owners={
          owners.ok
            ? owners.data
                .filter((o) => !o.archived && !(o.lettingBusiness ?? false))
                .map((o) => ({ id: o.id, label: `${o.displayName} (${o.reference})` }))
            : []
        }
        initialOwnerId={ownerId}
        agency={membership?.companyKind === 'agency'}
      />
    </>
  );
}
