import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { hasFeature } from '@/lib/plan';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { OwnerReporting } from './owner-reporting';

export const metadata: Metadata = { title: 'Owner' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An owner's fee terms and money (AC-02, AC-05; M9 plan 4.7): the terms in force, those approved
 * for later and any waiting for a second person, the change form, and links to the owner's
 * statements and remittances. Fees and statements are Growth only, and an agency's alone.
 */
export default async function OwnerPage({
  params,
}: {
  readonly params: Promise<{ readonly ownerId: string }>;
}) {
  const [{ ownerId }, me, company] = await Promise.all([params, getMe(), getCompany()]);
  if (!me) return null;
  if (!UUID.test(ownerId)) notFound();
  if (!allowed(me, 'owner.view'))
    return (
      <>
        <PageHeader title="Owner" />
        <NoAccess what="owners" />
      </>
    );
  const agency =
    (me.memberships.find((m) => m.companyId === me.activeCompanyId)?.companyKind ??
      company?.kind) === 'agency';
  return (
    <OwnerReporting
      ownerId={ownerId}
      can={{
        onPlan: hasFeature(company, 'owner_reporting'),
        reporting: hasFeature(company, 'owner_reporting') && allowed(me, 'statements.read'),
        fees: agency && hasFeature(company, 'owner_reporting'),
        changeFees: agency && hasFeature(company, 'owner_reporting') && allowed(me, 'fees.manage'),
        seeApprovals: allowed(me, 'approval.view'),
      }}
    />
  );
}
