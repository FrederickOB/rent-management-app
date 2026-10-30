import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SignOutButton } from '@/components/sign-out-button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { homeFor, PHONE_NO_ACCESS_PATH } from '@/lib/routing';
import { getMe } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Nothing to sign in to' };

/**
 * A phone sign-in that carries no company (AD-06). Phone codes open caretaker access only, so a
 * tenant, or someone whose roles all need a password, lands here rather than on an empty app.
 */
export default async function PhoneNoAccessPage() {
  const me = await getMe();
  if (!me) redirect('/sign-in/phone');
  const home = homeFor(me);
  if (home !== PHONE_NO_ACCESS_PATH) redirect(home);
  return (
    <Card>
      <CardHeader
        title={<span className="text-xl">There is nothing for this phone sign-in here</span>}
        description="A code sent to a phone signs caretakers in. This number has no caretaker access in any company."
      />
      <CardBody>
        <ul className="list-disc space-y-2 pl-5 text-sm text-slate-700">
          <li>
            If you sign in with an email address and password, sign out, then choose{' '}
            <strong>Sign in with email</strong>.
          </li>
          <li>If you are a tenant, use the tenant app.</li>
          <li>If you look after a property, ask the agency to add you as a caretaker.</li>
        </ul>
        <SignOutButton variant="primary" size="md" className="w-full" />
      </CardBody>
    </Card>
  );
}
