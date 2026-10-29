import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { homeFor } from '@/lib/routing';
import { getMe } from '@/lib/server/session';
import { Enrolment } from './enrolment';

export const metadata: Metadata = { title: 'Set up two-step sign-in' };

/** A password-only session can do nothing but this (AD-06, M1 plan 4.5). */
export default async function EnrolPage() {
  const me = await getMe();
  if (!me) redirect('/sign-in');
  if (me.state !== 'enrolment_required') redirect(homeFor(me));
  return <Enrolment name={me.name} />;
}
