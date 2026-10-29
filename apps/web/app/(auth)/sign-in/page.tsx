import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { homeFor } from '@/lib/routing';
import { getMe } from '@/lib/server/session';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage() {
  const me = await getMe();
  if (me) redirect(homeFor(me));
  return <SignInForm />;
}
