import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { getCompany, getMe } from '@/lib/server/session';
import { RetentionView } from './retention-view';

export const metadata: Metadata = { title: 'Retention review' };

/**
 * The nightly retention review (M11 decision 5; NFR-DP): for each category of personal records,
 * its rule, whether the rule is verified, and the records past a verified period. Counts only:
 * nothing is deleted on a timer.
 */
export default async function PlatformRetentionPage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Retention review',
    what: 'the retention review',
    needs: 'health.read',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Retention review"
        description="Records kept past their retention period, by category, from the nightly review. Only a verified rule is counted; nothing is deleted on a timer, and an unverified rule keeps everything."
      />
      <RetentionView />
    </>
  );
}
