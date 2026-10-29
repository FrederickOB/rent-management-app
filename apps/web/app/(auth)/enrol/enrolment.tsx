'use client';

import { toDataURL } from 'qrcode';
import { useState, type FormEvent } from 'react';
import { BackupCodeList } from '@/components/backup-codes';
import { SignOutButton } from '@/components/sign-out-button';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CheckboxField, TextField } from '@/components/ui/field';
import { authClient } from '@/lib/auth-client';
import { authProblem } from '@/lib/errors';

interface Setup {
  readonly qr: string;
  readonly secret: string;
  readonly backupCodes: readonly string[];
}

type Step = 'password' | 'scan' | 'backup' | 'confirm';

/** The key inside an otpauth:// link, for people who type it instead of scanning. */
function secretOf(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
}

const grouped = (secret: string) => secret.match(/.{1,4}/g)?.join(' ') ?? secret;

/**
 * TOTP enrolment (AD-06): confirm the password, add the key to an authenticator app, save the
 * backup codes, then prove it works with a code. Only then does the session become a staff session.
 */
export function Enrolment({ name }: { readonly name: string }) {
  const [step, setStep] = useState<Step>('password');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await authClient().twoFactor.enable({ password });
      if (result.error || !result.data || !('totpURI' in result.data) || !result.data.totpURI) {
        setError(authProblem(result.error).message);
        return;
      }
      const qr = await toDataURL(result.data.totpURI, {
        margin: 1,
        width: 240,
        errorCorrectionLevel: 'M',
      });
      setSetup({
        qr,
        secret: secretOf(result.data.totpURI),
        backupCodes: result.data.backupCodes ?? [],
      });
      setPassword('');
      setStep('scan');
    } catch (failure) {
      setError(authProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  async function copySecret() {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await authClient().twoFactor.verifyTotp({ code: code.replace(/\s+/g, '') });
      if (result.error) {
        setError(authProblem(result.error).message);
        setPending(false);
        return;
      }
      // The server swapped this session for a full staff session; start the app afresh.
      window.location.assign('/');
    } catch (failure) {
      setError(authProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={<span className="text-xl">Set up two-step sign-in</span>}
        description={`${name}, staff accounts need an authenticator app as well as a password. It takes about two minutes.`}
      />
      <CardBody>
        {error ? <Alert tone="error">{error}</Alert> : null}

        {step === 'password' ? (
          <form onSubmit={start} className="space-y-4">
            <p className="text-sm text-slate-700">
              You will need an authenticator app on your phone, such as Google Authenticator,
              Microsoft Authenticator or 1Password.
            </p>
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              hint="Confirm your password to begin."
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button type="submit" pending={pending} className="w-full">
              Continue
            </Button>
          </form>
        ) : null}

        {step === 'scan' && setup ? (
          <div className="space-y-4">
            <h2 className="text-base font-semibold">
              1. Add Rent Platform to your authenticator app
            </h2>
            <p className="text-sm text-slate-700">Scan this QR code with the app.</p>
            <img
              src={setup.qr}
              alt="QR code for your authenticator app"
              width={240}
              height={240}
              className="mx-auto rounded-md border border-slate-200"
            />
            <div className="space-y-2">
              <p className="text-sm text-slate-700">
                If you cannot scan it, enter this key in the app instead:
              </p>
              <p
                data-testid="totp-secret"
                className="rounded-md bg-slate-100 px-3 py-2 font-mono text-base tracking-wider break-all"
              >
                {grouped(setup.secret)}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={copySecret}>
                  Copy key
                </Button>
                {copied ? (
                  <span role="status" className="text-sm text-emerald-800">
                    Copied
                  </span>
                ) : null}
              </div>
            </div>
            <Button onClick={() => setStep('backup')} className="w-full">
              I have added it
            </Button>
          </div>
        ) : null}

        {step === 'backup' && setup ? (
          <div className="space-y-4">
            <h2 className="text-base font-semibold">2. Save your backup codes</h2>
            <p className="text-sm text-slate-700">
              If you lose your phone, each of these codes lets you sign in once. Keep them somewhere
              safe, such as a password manager. You will not see them again.
            </p>
            <BackupCodeList codes={setup.backupCodes} />
            <CheckboxField
              label="I have saved these backup codes"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
            />
            <Button onClick={() => setStep('confirm')} disabled={!saved} className="w-full">
              Continue
            </Button>
          </div>
        ) : null}

        {step === 'confirm' ? (
          <form onSubmit={confirm} className="space-y-4">
            <h2 className="text-base font-semibold">3. Check that it works</h2>
            <TextField
              label="6-digit code"
              hint="Enter the code your authenticator app shows for Rent Platform now."
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              required
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <Button type="submit" pending={pending} className="w-full">
              Confirm
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setStep('scan')}>
              Show the QR code again
            </Button>
          </form>
        ) : null}

        <div className="border-t border-slate-200 pt-4">
          <SignOutButton variant="ghost" />
        </div>
      </CardBody>
    </Card>
  );
}
