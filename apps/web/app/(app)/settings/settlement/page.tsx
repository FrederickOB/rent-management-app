import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe, loadOwners } from '@/lib/server/session';
import { SettlementView } from './settlement-view';

export const metadata: Metadata = { title: 'Settlement accounts' };

/**
 * Where rent settles (D1, ADR-008; M4b plan 4.2): the bank accounts the payment provider pays
 * rent into, and, in an agency, each owner's choice between their own account and the agency's
 * client account (decision 6). Every change is a request a second person approves, and an
 * approved account takes rent only 24 hours later.
 */
export default async function SettlementPage() {
  const me = await getMe();
  if (!me || !(allowed(me, 'payments.view') || allowed(me, 'settlement_account.change'))) {
    return (
      <>
        <PageHeader title="Settlement accounts" />
        <NoAccess what="settlement accounts" />
      </>
    );
  }
  const canChange = allowed(me, 'settlement_account.change');
  const owners = canChange && allowed(me, 'owner.view') ? await loadOwners() : null;
  const companyKind =
    me.memberships.find((m) => m.companyId === me.activeCompanyId)?.companyKind ?? 'landlord';
  return (
    <>
      <PageHeader
        title="Settlement accounts"
        description="Rent paid by mobile money or card settles straight from the payment provider into these bank accounts; the platform never holds it. A new account needs a second person’s approval, and takes rent 24 hours after it is approved."
      />
      <SettlementView
        companyKind={companyKind}
        owners={
          owners?.ok
            ? owners.data
                .filter((o) => !o.archived)
                .map((o) => ({ id: o.id, label: `${o.displayName} (${o.reference})` }))
            : []
        }
        can={{
          change: canChange,
          reveal: allowed(me, 'settlement_account.reveal'),
          changeAgency: allowed(me, 'settlement_account.change_agency'),
          seeApprovals: allowed(me, 'approval.view'),
        }}
      />
    </>
  );
}
