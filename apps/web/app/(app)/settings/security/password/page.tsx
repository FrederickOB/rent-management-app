import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Card, CardBody } from '@/components/ui/card';
import { getMe } from '@/lib/server/session';
import { ChangePasswordForm } from './change-password-form';

export const metadata: Metadata = { title: 'Change your password' };

/**
 * Changing the password (M11 security review). Staff who sign in with a password and TOTP change
 * it here; this session stays signed in and every other one is signed out. Caretakers sign in by
 * phone and have no password.
 */
export default async function ChangePasswordPage() {
  const me = await getMe();
  if (!me) return null;
  return (
    <>
      <p className="text-sm">
        <Link href="/settings/security" className="underline underline-offset-2">
          My security
        </Link>
      </p>
      <PageHeader
        title="Change your password"
        description="You stay signed in here; every other device you are signed in on is signed out."
      />
      {me.authMethod === 'password_totp' ? (
        <ChangePasswordForm />
      ) : (
        <Card>
          <CardBody>
            <p className="text-sm text-slate-700">
              You sign in with a code sent to your phone, so there is no password to change.
            </p>
          </CardBody>
        </Card>
      )}
    </>
  );
}
