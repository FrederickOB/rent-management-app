import type { Metadata } from 'next';
import Link from 'next/link';
import { primaryLink } from '@/components/link-styles';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { hasFeature } from '@/lib/plan';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { ExpensesView } from './expenses-view';

export const metadata: Metadata = { title: 'Expenses' };

/**
 * Expenses (AC-03; M8 decision 8), on every plan: what was spent on each property or unit, with
 * its receipt, posted by P15 and linked to repairs. Corrections are by reversal and a new
 * expense; there is no approval step (MI-05 is P2).
 */
export default async function ExpensesPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, company, query] = await Promise.all([getMe(), getCompany(), searchParams]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Expenses',
    what: 'expenses',
    needs: 'expense.read',
  });
  if (refused) return refused;
  const canRecord = allowed(me, 'expense.record');
  const jobId = typeof query.jobId === 'string' ? query.jobId : '';
  return (
    <>
      <PageHeader
        title="Expenses"
        description="Money spent on the properties: repairs, rates, insurance, utilities and the rest, each with its receipt. A repair’s cost is the sum of its expenses."
      />
      {canRecord ? (
        <div>
          <Link href="/expenses/new" className={primaryLink}>
            Record an expense
          </Link>
        </div>
      ) : null}
      <ExpensesView
        initialJobId={jobId}
        saved={query.saved === '1'}
        can={{
          record: canRecord,
          seeJobs:
            hasFeature(company, 'maintenance') &&
            (allowed(me, 'maintenance.view') || allowed(me, 'maintenance.read')),
          agency:
            me.memberships.find((m) => m.companyId === me.activeCompanyId)?.companyKind ===
            'agency',
        }}
      />
    </>
  );
}
