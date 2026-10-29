'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { authClient } from '@/lib/auth-client';
import { authProblem } from '@/lib/errors';

/** Email and password (AD-06). Staff with TOTP continue to the code step; the rest go home. */
export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await authClient().signIn.email({ email: email.trim(), password });
      if (result.error) {
        setError(authProblem(result.error).message);
        setPending(false);
        return;
      }
      if (result.data && 'twoFactorRedirect' in result.data && result.data.twoFactorRedirect) {
        router.push('/sign-in/verify');
        return;
      }
      // A password-only session; the server sends it on to TOTP enrolment.
      window.location.assign('/');
    } catch (failure) {
      setError(authProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={<span className="text-xl">Sign in</span>}
        description="With your email address and password: for landlords, owners, agency staff and advisers."
      />
      <CardBody>
        <form onSubmit={submit} className="space-y-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <TextField
            label="Email"
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <TextField
            label="Password"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button type="submit" pending={pending} className="w-full">
            Sign in
          </Button>
        </form>
        <p className="text-sm text-slate-700">
          <Link href="/sign-in/phone" className="font-medium underline underline-offset-2">
            Caretaker? Sign in with your phone
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
