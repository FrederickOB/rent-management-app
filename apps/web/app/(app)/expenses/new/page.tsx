import type { Metadata } from 'next';
import Link from 'next/link';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { hasFeature } from '@/lib/plan';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { ExpenseForm } from './expense-form';

export const metadata: Metadata = { title: 'Record an expense' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const param = (value: string | string[] | undefined): string =>
  typeof value === 'string' && UUID.test(value) ? value : '';

/** An expense with its receipt (AC-03; M8 decision 8), optionally for a repair (`?jobId=`). */
export default async function NewExpensePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, company, query] = await Promise.all([getMe(), getCompany(), searchParams]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Record an expense',
    what: 'recording expenses',
    needs: 'expense.record',
  });
  if (refused) return refused;
  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/expenses" className="underline underline-offset-2">
          Expenses
        </Link>{' '}
        <span aria-hidden="true">›</span> <span>Record an expense</span>
      </nav>
      <PageHeader
        title="Record an expense"
        description="It is posted to the owner’s books: owed to the supplier until it is paid, or paid by the owner or the agency."
      />
      <ExpenseForm
        initial={{
          jobId: param(query.jobId),
          propertyId: param(query.propertyId),
          unitId: param(query.unitId),
        }}
        can={{
          linkJobs:
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
