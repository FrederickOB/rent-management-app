import type { Metadata } from 'next';
import { SetPasswordForm } from './set-password-form';

export const metadata: Metadata = { title: 'Set your password' };

/**
 * The invitation link (Better Auth's password reset, M1 plan 4.15) arrives here with
 * `?token=…`, or with `?error=INVALID_TOKEN` when the link has expired or been used.
 */
export default async function AcceptInvitePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const token = typeof query.token === 'string' ? query.token : null;
  const invalid = typeof query.error === 'string' || !token;
  return <SetPasswordForm token={invalid ? null : token} />;
}
