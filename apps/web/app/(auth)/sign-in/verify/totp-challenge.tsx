'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { authClient } from '@/lib/auth-client';
import { authProblem } from '@/lib/errors';

// After these, the pending sign-in is gone and only starting again helps.
const RESTART = new Set(['INVALID_TWO_FACTOR_COOKIE', 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE']);

/** The second step of staff sign-in (AD-06): a TOTP code, or one backup code. */
export function TotpChallenge() {
  const [mode, setMode] = useState<'totp' | 'backup'>('totp');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; restart: boolean } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const value = code.replace(/\s+/g, '');
      const result =
        mode === 'totp'
          ? await authClient().twoFactor.verifyTotp({ code: value })
          : await authClient().twoFactor.verifyBackupCode({ code: value });
      if (result.error) {
        const problem = authProblem(result.error);
        setError({
          message: problem.message,
          restart: problem.code ? RESTART.has(problem.code) : false,
        });
        setPending(false);
        return;
      }
      window.location.assign('/');
    } catch (failure) {
      setError({ message: authProblem(failure).message, restart: false });
      setPending(false);
    }
  }

  function switchMode() {
    setMode(mode === 'totp' ? 'backup' : 'totp');
    setCode('');
    setError(null);
  }

  return (
    <Card>
      <CardHeader
        title={<span className="text-xl">Two-step sign-in</span>}
        description={
          mode === 'totp'
            ? 'Open your authenticator app and enter the 6-digit code for Rent Platform.'
            : 'Enter one of the backup codes you saved when you set up two-step sign-in. Each code works once.'
        }
      />
      <CardBody>
        <form onSubmit={submit} className="space-y-4">
          {error ? (
            <Alert tone="error">
              {error.message}{' '}
              {error.restart ? (
                <Link href="/sign-in" className="font-semibold underline underline-offset-2">
                  Sign in again
                </Link>
              ) : null}
            </Alert>
          ) : null}
          {mode === 'totp' ? (
            <TextField
              key="totp"
              label="6-digit code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              required
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          ) : (
            <TextField
              key="backup"
              label="Backup code"
              name="backup-code"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          )}
          <Button type="submit" pending={pending} className="w-full">
            Verify
          </Button>
        </form>
        <div className="flex flex-wrap justify-between gap-2 text-sm">
          <button
            type="button"
            onClick={switchMode}
            className="font-medium text-slate-700 underline underline-offset-2"
          >
            {mode === 'totp' ? 'Use a backup code instead' : 'Use my authenticator app instead'}
          </button>
          <Link href="/sign-in" className="font-medium text-slate-700 underline underline-offset-2">
            Start again
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}
