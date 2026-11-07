import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { StatementsView } from './statements-view';

export const metadata: Metadata = { title: 'Owner statements' };

/**
 * Owner statements (AC-04; M9 decisions 5 to 7 and 15), by owner and month: drafted on the 1st
 * for last month, worked out again on request, and issued, which locks the month. Growth only
 * (decision 13). An owner and their adviser see their own only; the API decides.
 */
export default async function StatementsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [me, company, query] = await Promise.all([getMe(), getCompany(), searchParams]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Owner statements',
    what: 'owner statements',
    needs: 'statements.read',
    feature: 'owner_reporting',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Owner statements"
        description="A statement for each owner and calendar month, in the company’s time zone. Issuing one locks its month for that owner, so its figures never change."
      />
      <StatementsView
        initialOwnerId={typeof query.ownerId === 'string' ? query.ownerId : ''}
        canDraft={allowed(me, 'statements.issue')}
      />
    </>
  );
}
