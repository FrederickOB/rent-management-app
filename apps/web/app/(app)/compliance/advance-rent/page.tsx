import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';
import { AdvanceReportView } from './advance-report-view';

export const metadata: Metadata = { title: 'Advance rent report' };

/**
 * The advance rent report (AR-05; M5 plan 5.5): under `advance_rent_policy` `warn` or `block`,
 * each lease paid further ahead than the limit for its term, with the rule version it was judged
 * by. It never calls an advance compliant.
 */
export default async function AdvanceRentReportPage() {
  const me = await getMe();
  if (!me || !allowed(me, 'billing.view'))
    return (
      <>
        <PageHeader title="Advance rent report" />
        <NoAccess what="the advance rent report" />
      </>
    );
  return (
    <>
      <PageHeader
        title="Advance rent report"
        description="Leases paid further ahead than the limit the Rent Act sets for their term (Act 220 s.25(5)), when your company checks advances. Each row names the rule it was judged by, and whether counsel has verified it."
      />
      <AdvanceReportView seeSettings={allowed(me, 'company.update')} />
    </>
  );
}
