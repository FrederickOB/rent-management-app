import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { homeFor } from '@/lib/routing';
import { getCompany, getMe } from '@/lib/server/session';

/** Every signed-in page passes through the session state from GET /me (AD-06). */
export default async function SignedInLayout({ children }: { readonly children: ReactNode }) {
  const me = await getMe();
  if (!me) redirect('/sign-in');
  // Enrolment, a company to choose, or a phone session with nothing here: elsewhere first.
  const home = homeFor(me);
  if (home !== '/') redirect(home);
  const company = me.activeCompanyId ? await getCompany() : null;
  return (
    <AppShell me={me} company={company}>
      {children}
    </AppShell>
  );
}
