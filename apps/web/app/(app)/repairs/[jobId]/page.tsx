import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pageRefusal } from '@/components/page-refusal';
import { hasFeature } from '@/lib/plan';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { RepairDetail } from './repair-detail';

export const metadata: Metadata = { title: 'Reported repair' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One reported repair (CM-04 stub): read-only until the maintenance board (M8). */
export default async function RepairPage({
  params,
}: {
  readonly params: Promise<{ readonly jobId: string }>;
}) {
  const [{ jobId }, me, company] = await Promise.all([params, getMe(), getCompany()]);
  if (!me) return null;
  if (!UUID.test(jobId)) notFound();
  const refused = pageRefusal(me, company, {
    title: 'Reported repair',
    what: 'reported repairs',
    needs: 'maintenance.view',
    feature: 'maintenance',
  });
  if (refused) return refused;
  return (
    <RepairDetail
      jobId={jobId}
      canOpenConversation={allowed(me, 'messaging.inbox.read') && hasFeature(company, 'inbox')}
    />
  );
}
