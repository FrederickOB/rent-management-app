import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getMe } from '@/lib/server/session';
import { PendingInvitations } from '@/components/pending-invitations';
import { CompanyPicker } from './company-picker';

export const metadata: Metadata = { title: 'Choose a company' };

/** People who work in more than one company choose one per session (M1 plan 4.5). */
export default async function ChooseCompanyPage() {
  const me = await getMe();
  if (!me) redirect('/sign-in');
  if (me.state === 'enrolment_required') redirect('/enrol');
  return (
    <div className="space-y-4">
      {/* M11 founder D2: an invitation to another company waits here too. */}
      <PendingInvitations />
      <CompanyPicker memberships={me.memberships} activeCompanyId={me.activeCompanyId} />
    </div>
  );
}
