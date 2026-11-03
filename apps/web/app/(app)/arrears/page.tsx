import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { parseArrearsBy } from '@/lib/arrears-view';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';
import { ArrearsView } from './arrears-view';

export const metadata: Metadata = { title: 'Arrears' };

/**
 * Arrears ageing (BC-08; plan 4.12): overdue invoice lines in four buckets by days past their due
 * date, by tenant, property or owner, as of any date.
 */
export default async function ArrearsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  if (!me || !allowed(me, 'billing.view')) {
    return (
      <>
        <PageHeader title="Arrears" />
        <NoAccess what="arrears" />
      </>
    );
  }
  const asOf =
    typeof query.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.asOf) ? query.asOf : '';
  return (
    <>
      <PageHeader
        title="Arrears"
        description="Overdue invoices: what invoices asked for by a due date that has passed and is still unpaid, aged by days past the due date."
      />
      <ArrearsView
        initialBy={parseArrearsBy(typeof query.by === 'string' ? query.by : null)}
        initialAsOf={asOf}
        seeTenants={allowed(me, 'tenant.view')}
      />
    </>
  );
}
