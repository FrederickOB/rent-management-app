import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { OwnerMoneyView } from './owner-money-view';

export const metadata: Metadata = { title: 'Remittances' };

/**
 * Money moved for owners (AC-05; M9 decision 8): remittances with proof (P16), fees taken on
 * their own, and money owners sent for their bills (P30). Records of transfers already made; a
 * mistake is corrected by a reversal. Growth only (decision 13). Owners read their own.
 */
export default async function OwnerMoneyPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, company, query] = await Promise.all([getMe(), getCompany(), searchParams]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Remittances',
    what: 'remittances',
    needs: 'statements.read',
    feature: 'owner_reporting',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Remittances"
        description="Money paid to owners, fees taken by the agency, and money owners sent for their bills, each with its proof."
      />
      <OwnerMoneyView
        initialOwnerId={typeof query.ownerId === 'string' ? query.ownerId : ''}
        canRecord={allowed(me, 'remittance.record')}
      />
    </>
  );
}
