import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { getCompany, getMe } from '@/lib/server/session';
import { PlatformGate1 } from './platform-gate1';

export const metadata: Metadata = { title: 'Gate 1 metrics' };

/**
 * Gate 1 across companies (PRD section 19; M9 decision 13), for platform admins only, through a
 * system path: each company's measures and the total, by month.
 */
export default async function PlatformGate1Page() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Gate 1 metrics',
    what: 'the platform’s Gate 1 metrics',
    needs: 'metrics.platform.read',
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Gate 1 metrics"
        description="The pilot’s Gate 1 measures for every company, and in total. Each share shows the counts behind it."
      />
      <PlatformGate1 />
    </>
  );
}
