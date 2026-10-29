import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getMe } from '@/lib/server/session';
import { CompanyPicker } from './company-picker';

export const metadata: Metadata = { title: 'Choose a company' };

/** People who work in more than one company choose one per session (M1 plan 4.5). */
export default async function ChooseCompanyPage() {
  const me = await getMe();
  if (!me) redirect('/sign-in');
  if (me.state === 'enrolment_required') redirect('/enrol');
  return <CompanyPicker memberships={me.memberships} activeCompanyId={me.activeCompanyId} />;
}
