'use client';

import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { authClient } from '@/lib/auth-client';
import { authProblem } from '@/lib/errors';
import { newPasswordProblem, PASSWORD_MAX, PASSWORD_MIN } from '@/lib/passwords';

export function ChangePasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDone(false);
    const problem = newPasswordProblem({ current, next, confirm });
    setError(problem);
    if (problem) return;
    setPending(true);
    try {
      const result = await authClient().changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (result.error) {
        setError(authProblem(result.error).message);
        return;
      }
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (failure) {
      setError(authProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardBody>
        <form
          aria-label="Change your password"
          onSubmit={(event) => void submit(event)}
          className="max-w-sm space-y-4"
        >
          {done ? (
            <Alert tone="success">
              Your password is changed. You are still signed in here, and signed out everywhere
              else.
            </Alert>
          ) : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
          <TextField
            label="Current password"
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            hint={`${PASSWORD_MIN} to ${PASSWORD_MAX} characters. A long phrase is easier to remember and harder to guess. A password found in a data breach is refused.`}
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            required
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
          <TextField
            label="Repeat the new password"
            type="password"
            autoComplete="new-password"
            maxLength={PASSWORD_MAX}
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
          <Button type="submit" pending={pending}>
            Change the password
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
