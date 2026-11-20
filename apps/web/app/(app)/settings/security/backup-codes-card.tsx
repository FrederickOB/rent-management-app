'use client';

import { useState, type FormEvent } from 'react';
import { BackupCodeList } from '@/components/backup-codes';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, TextField } from '@/components/ui/field';
import { authClient } from '@/lib/auth-client';
import { authProblem } from '@/lib/errors';

/** New backup codes replace the old ones at once; they are shown here a single time. */
export function BackupCodesCard() {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      // M11 security review: making new codes needs the current authenticator code too. The
      // server reads `code`; Better Auth's own client type does not list it.
      const input = { password, code: code.trim() } as { password: string };
      const result = await authClient().twoFactor.generateBackupCodes(input);
      if (result.error || !result.data) {
        setError(authProblem(result.error).message);
        return;
      }
      setCodes(result.data.backupCodes);
      setSaved(false);
      setPassword('');
      setCode('');
    } catch (failure) {
      setError(authProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Backup codes"
        description="If you lose your phone, a backup code signs you in once. Making new codes cancels all of your old ones."
      />
      <CardBody>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {codes ? (
          <div className="space-y-4">
            <Alert tone="warning">Save these codes now. You will not see them again.</Alert>
            <BackupCodeList codes={codes} />
            <CheckboxField
              label="I have saved these backup codes"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
            />
            <Button variant="secondary" disabled={!saved} onClick={() => setCodes(null)}>
              Done
            </Button>
          </div>
        ) : (
          <form onSubmit={generate} className="space-y-4">
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              hint="Confirm your password and a code to make new codes."
              required
              className="max-w-sm"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <TextField
              label="6-digit code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              hint="The current code from your authenticator app. Each code works once: if you just used it, wait for the next one."
              required
              className="max-w-48"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            />
            <Button type="submit" variant="secondary" pending={pending}>
              Make new backup codes
            </Button>
          </form>
        )}
      </CardBody>
    </Card>
  );
}
