import type { Metadata } from 'next';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe } from '@/lib/server/session';
import { OnboardingView } from './onboarding-view';

export const metadata: Metadata = { title: 'Onboarding' };

/**
 * Pilot onboarding (M11 decisions 2 and 3; P25): a landlord brought in from workbooks in three
 * steps, each previewed before it is written. For company admins and unscoped managers
 * (`onboarding.import`); the API refuses everyone else again.
 */
export default async function OnboardingPage() {
  const me = await getMe();
  if (!me) return null;
  if (!allowed(me, 'onboarding.import'))
    return (
      <>
        <PageHeader title="Onboarding" />
        <NoAccess what="onboarding" />
      </>
    );
  return (
    <>
      <PageHeader
        title="Onboarding"
        description="Bring the landlord’s records in from three workbooks, in order: the register, then tenants and leases, then opening balances on the cut-over date. Each is checked and previewed before anything is written, and an import never messages a tenant."
      />
      <OnboardingView />
    </>
  );
}
