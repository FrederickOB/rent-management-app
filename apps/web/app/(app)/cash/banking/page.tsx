import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';
import { BankingForm } from './banking-form';

export const metadata: Metadata = { title: 'Record banking' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idParam = (value: string | string[] | undefined) =>
  typeof value === 'string' && UUID.test(value) ? value : null;

/**
 * A collector's cash banked into the owner's account or handed to the agency (P07), with the
 * slip. It leaves the collector's cash on hand once a second person approves it.
 */
export default async function BankingPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  if (!me || !allowed(me, 'cash.bank')) {
    return (
      <>
        <PageHeader title="Record banking" />
        <NoAccess what="recording banking" />
      </>
    );
  }
  const membership = me.memberships.find((m) => m.companyId === me.activeCompanyId);
  return (
    <>
      <PageHeader
        title="Record banking"
        description="Cash or cheques taken to the bank, or handed to the agency, with a photo of the slip. Never more than the collector holds."
      />
      <BankingForm
        initial={{ collectorPersonId: idParam(query.collector), ownerId: idParam(query.owner) }}
        bankOthers={allowed(me, 'cash.bank_others')}
        agency={membership?.companyKind === 'agency'}
      />
    </>
  );
}
