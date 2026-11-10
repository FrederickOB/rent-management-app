import type { Metadata } from 'next';
import { pageRefusal } from '@/components/page-refusal';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getCompany, getMe } from '@/lib/server/session';
import { AccountRecovery } from './account-recovery';

export const metadata: Metadata = { title: 'Account recovery' };

/**
 * Account recovery in the console (M11 founder D4): find a person by their email, then reset a
 * lost two-factor or sign them out everywhere, each with a reason that records the identity
 * check made. The runbook is docs/runbooks/lost-authenticator.md.
 */
export default async function PlatformPeoplePage() {
  const [me, company] = await Promise.all([getMe(), getCompany()]);
  if (!me) return null;
  const refused = pageRefusal(me, company, {
    title: 'Account recovery',
    what: 'account recovery',
    needs: ['person.two_factor.reset', 'person.sessions.revoke'],
  });
  if (refused) return refused;
  return (
    <>
      <PageHeader
        title="Account recovery"
        description="For someone who lost their authenticator, or whose sessions must end at once. Check who they are first, as the lost-authenticator runbook (docs/runbooks/lost-authenticator.md) says, and record that check in the reason."
      />
      <AccountRecovery
        can={{
          reset: allowed(me, 'person.two_factor.reset'),
          revoke: allowed(me, 'person.sessions.revoke'),
        }}
      />
    </>
  );
}
