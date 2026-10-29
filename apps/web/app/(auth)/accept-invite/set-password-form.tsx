'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { authClient } from '@/lib/auth-client';
import { authProblem } from '@/lib/errors';

const MIN_LENGTH = 12; // Better Auth's minPasswordLength on the API (M1 plan 4.5)
const MAX_LENGTH = 128;

/** Accept an invitation, or reset a password: both set a password from an emailed link. */
export function SetPasswordForm({ token }: { readonly token: string | null }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <Card>
        <CardHeader title={<span className="text-xl">This link has expired</span>} />
        <CardBody>
          <Alert tone="error">This link is not valid, has expired or has already been used.</Alert>
          <p className="text-sm text-slate-700">
            Ask the person who invited you to send a new invitation.
          </p>
        </CardBody>
      </Card>
    );
  }

  if (done) {
    return (
      <Card>
        <CardHeader title={<span className="text-xl">Your password is set</span>} />
        <CardBody>
          <Alert tone="success">
            Sign in with your email address and new password. You will then set up two-step sign-in.
          </Alert>
          <Link
            href="/sign-in"
            className="inline-block text-sm font-semibold underline underline-offset-2"
          >
            Go to sign in
          </Link>
        </CardBody>
      </Card>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < MIN_LENGTH) return setError(`Use at least ${MIN_LENGTH} characters.`);
    if (password !== repeat) return setError('The two passwords are not the same.');
    setPending(true);
    setError(null);
    try {
      const result = await authClient().resetPassword({
        newPassword: password,
        token: token ?? '',
      });
      if (result.error) {
        setError(authProblem(result.error).message);
        return;
      }
      setDone(true);
    } catch (failure) {
      setError(authProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={<span className="text-xl">Set your password</span>}
        description="Choose a password for your Rent Platform account. A long phrase is easier to remember and harder to guess."
      />
      <CardBody>
        <form onSubmit={submit} className="space-y-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            hint={`At least ${MIN_LENGTH} characters.`}
            minLength={MIN_LENGTH}
            maxLength={MAX_LENGTH}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <TextField
            label="Repeat the password"
            type="password"
            autoComplete="new-password"
            maxLength={MAX_LENGTH}
            required
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
          />
          <Button type="submit" pending={pending} className="w-full">
            Set password
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
