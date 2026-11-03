import type { Metadata } from 'next';
import Link from 'next/link';
import { primaryLink, secondaryLink } from '@/components/link-styles';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';
import { CashView } from './cash-view';

export const metadata: Metadata = { title: 'Cash on hand' };

/**
 * Cash and cheques collected and not yet banked, per collector and owner (BC-05, P07), and the
 * cash records behind them. A caretaker sees their own cash only, and nothing else of billing.
 */
export default async function CashPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, query] = await Promise.all([getMe(), searchParams]);
  if (!me || !(allowed(me, 'cash.view_own') || allowed(me, 'billing.view'))) {
    return (
      <>
        <PageHeader title="Cash on hand" />
        <NoAccess what="cash on hand" />
      </>
    );
  }
  const record = allowed(me, 'payment.record');
  const bank = allowed(me, 'cash.bank');
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Cash on hand"
          description="Cash and cheques count as held once a second person has approved them, and leave the collector’s hands once their banking is approved."
        />
        <div className="flex flex-wrap gap-2">
          {bank ? (
            <Link href="/cash/banking" className={secondaryLink}>
              Record banking
            </Link>
          ) : null}
          {record ? (
            <Link href="/cash/new" className={primaryLink}>
              Record cash or cheque
            </Link>
          ) : null}
        </div>
      </div>
      <CashView
        saved={typeof query.saved === 'string' ? query.saved : null}
        can={{
          bank,
          bankOthers: allowed(me, 'cash.bank_others'),
          seePayments: allowed(me, 'billing.view'),
        }}
      />
    </>
  );
}
