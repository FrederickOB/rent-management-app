import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe, loadOwners } from '@/lib/server/session';
import { VatPaymentForm } from './vat-payment-form';

export const metadata: Metadata = { title: 'Record a VAT payment' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** VAT and levies paid to GRA with a month's return (P33), with GRA's receipt (tax.manage). */
export default async function VatPaymentPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  if (!me || !allowed(me, 'tax.manage'))
    return (
      <>
        <PageHeader title="Record a VAT payment" />
        <NoAccess what="recording VAT payments" />
      </>
    );
  const owners = await loadOwners();
  const membership = me.memberships.find((m) => m.companyId === me.activeCompanyId);
  return (
    <>
      <PageHeader
        title="Record a VAT payment"
        description="VAT, NHIL and GETFund paid to GRA with a month’s return, and GRA’s receipt for it."
      />
      <VatPaymentForm
        owners={
          owners.ok
            ? owners.data
                .filter((o) => !o.archived && (o.vatRegistered ?? false))
                .map((o) => ({ id: o.id, label: `${o.displayName} (${o.reference})` }))
            : []
        }
        initialOwnerId={
          typeof query.ownerId === 'string' && UUID.test(query.ownerId) ? query.ownerId : null
        }
        initialMonth={
          typeof query.month === 'string' && MONTH.test(query.month) ? query.month : null
        }
        agency={membership?.companyKind === 'agency'}
      />
    </>
  );
}
