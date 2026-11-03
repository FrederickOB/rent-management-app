import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe, loadOwners } from '@/lib/server/session';
import { VatView } from './vat-view';

export const metadata: Metadata = { title: 'VAT returns' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * VAT returns (P32, P33; M5 plan 5.6): per VAT-registered owner and month, the VAT, NHIL and
 * GETFund charged at their tax points, by invoice, and VAT paid to GRA. Filing itself and E-VAT
 * invoicing are not built (OQ-20).
 */
export default async function VatPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  if (!me || !allowed(me, 'billing.view'))
    return (
      <>
        <PageHeader title="VAT returns" />
        <NoAccess what="VAT returns" />
      </>
    );
  const owners = await loadOwners();
  const ownerId =
    typeof query.ownerId === 'string' && UUID.test(query.ownerId) ? query.ownerId : null;
  const month = typeof query.month === 'string' && MONTH.test(query.month) ? query.month : null;
  return (
    <>
      <PageHeader
        title="VAT returns"
        description="VAT, NHIL and GETFund on commercial rent for owners registered for VAT, by the month of their tax point: the invoice or the payment, whichever came first."
      />
      <VatView
        owners={
          owners.ok
            ? owners.data
                .filter((o) => !o.archived && (o.vatRegistered ?? false))
                .map((o) => ({ id: o.id, label: `${o.displayName} (${o.reference})` }))
            : []
        }
        initialOwnerId={ownerId}
        initialMonth={month}
        canPay={allowed(me, 'tax.manage')}
      />
    </>
  );
}
