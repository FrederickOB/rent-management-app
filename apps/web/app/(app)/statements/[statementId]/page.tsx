import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pageRefusal } from '@/components/page-refusal';
import { getCompany, getMe } from '@/lib/server/session';
import { StatementDetailView } from './statement-detail';

export const metadata: Metadata = { title: 'Owner statement' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One owner statement (AC-04): its pages, the agent's side, its checks, issue and its PDF. */
export default async function StatementPage({
  params,
}: {
  readonly params: Promise<{ readonly statementId: string }>;
}) {
  const [{ statementId }, me, company] = await Promise.all([params, getMe(), getCompany()]);
  if (!me) return null;
  if (!UUID.test(statementId)) notFound();
  const refused = pageRefusal(me, company, {
    title: 'Owner statement',
    what: 'owner statements',
    needs: 'statements.read',
    feature: 'owner_reporting',
  });
  if (refused) return refused;
  return <StatementDetailView statementId={statementId} />;
}
