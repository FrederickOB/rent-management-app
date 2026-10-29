import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { homeFor } from '@/lib/routing';
import { getCompany, getMe } from '@/lib/server/session';

/** Every signed-in page passes through the session state from GET /me (AD-06). */
export default async function SignedInLayout({ children }: { readonly children: ReactNode }) {
  const me = await getMe();
  if (!me) redirect('/sign-in');
  if (me.state !== 'ready') redirect(homeFor(me));
  const company = me.activeCompanyId ? await getCompany() : null;
  return (
    <AppShell me={me} company={company}>
      {children}
    </AppShell>
  );
}
