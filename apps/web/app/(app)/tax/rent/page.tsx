import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { parsePeriod } from '@/lib/rent-tax';
import { getMe, loadOwners } from '@/lib/server/session';
import { RentTaxView } from './rent-tax-view';

export const metadata: Metadata = { title: 'Rent tax' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rent tax (TX-01 to TX-03, TX-08; M5 plan 5.8): what is due to GRA with the 21- and 28-day
 * alerts, and the report by owner and period, receipt by receipt, with its PDF and CSV. Recording
 * a GRA payment needs tax.manage; the API checks every request again.
 */
export default async function RentTaxPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  if (!me || !allowed(me, 'billing.view'))
    return (
      <>
        <PageHeader title="Rent tax" />
        <NoAccess what="rent tax" />
      </>
    );
  const owners = await loadOwners();
  const one = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : null);
  const ownerId = one('ownerId');
  return (
    <>
      <PageHeader
        title="Rent tax"
        description="Rent tax is worked out on each receipt of rent, advances included, and is due to GRA 30 days after the rent was received."
      />
      <RentTaxView
        owners={
          owners.ok
            ? owners.data
                .filter((o) => !o.archived)
                .map((o) => ({
                  id: o.id,
                  label: `${o.displayName} (${o.reference})`,
                  lettingBusiness: o.lettingBusiness ?? false,
                }))
            : []
        }
        initialOwnerId={ownerId && UUID.test(ownerId) ? ownerId : null}
        initialPeriod={parsePeriod(one('from'), one('to'))}
        canPay={allowed(me, 'tax.manage')}
      />
    </>
  );
}
