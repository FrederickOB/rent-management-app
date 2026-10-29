import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { homeFor } from '@/lib/routing';
import { getMe } from '@/lib/server/session';
import { PhoneSignInForm } from './phone-sign-in-form';

export const metadata: Metadata = { title: 'Sign in with your phone' };

/** Caretakers sign in to the web with a code sent to their phone (AD-06; architecture 11). */
export default async function PhoneSignInPage() {
  const me = await getMe();
  if (me) redirect(homeFor(me));
  return <PhoneSignInForm />;
}
