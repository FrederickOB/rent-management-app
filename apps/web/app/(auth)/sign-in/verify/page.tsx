import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { homeFor } from '@/lib/routing';
import { getMe } from '@/lib/server/session';
import { TotpChallenge } from './totp-challenge';

export const metadata: Metadata = { title: 'Enter your code' };

export default async function VerifyPage() {
  const me = await getMe();
  if (me) redirect(homeFor(me));
  return <TotpChallenge />;
}
