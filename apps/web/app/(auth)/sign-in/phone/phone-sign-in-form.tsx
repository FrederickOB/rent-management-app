'use client';

import { tryNormalisePhone } from '@rent/domain/phone';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { authClient } from '@/lib/auth-client';
import { authProblem } from '@/lib/errors';

type Step = { readonly kind: 'phone' } | { readonly kind: 'code'; readonly phone: string };

const linkClass = 'text-sm font-medium underline underline-offset-2';

/**
 * Phone sign-in (AD-06): the number on record gets a 6-digit code by SMS, valid for 10 minutes.
 * The number is normalised the way the tenant app does it, and nothing here logs it or the code.
 */
export function PhoneSignInForm() {
  const [step, setStep] = useState<Step>({ kind: 'phone' });
  const [phoneInput, setPhoneInput] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  async function send(phone: string): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      const result = await authClient().phoneNumber.sendOtp({ phoneNumber: phone });
      if (result.error) {
        setError(authProblem(result.error).message);
        return false;
      }
      return true;
    } catch (failure) {
      setError(authProblem(failure).message);
      return false;
    } finally {
      setPending(false);
    }
  }

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const phone = tryNormalisePhone(phoneInput);
    if (!phone) {
      setError('Enter your phone number, for example 024 412 3456.');
      return;
    }
    if (await send(phone)) {
      setCode('');
      setResent(false);
      setStep({ kind: 'code', phone });
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.kind !== 'code') return;
    setError(null);
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from the SMS.');
      return;
    }
    setPending(true);
    try {
      const result = await authClient().phoneNumber.verify({ phoneNumber: step.phone, code });
      if (result.error) {
        setError(authProblem(result.error).message);
        setPending(false);
        return;
      }
      // A full load, so the server reads the new session and sends the person where they belong.
      window.location.assign('/');
    } catch (failure) {
      setError(authProblem(failure).message);
      setPending(false);
    }
  }

  if (step.kind === 'phone') {
    return (
      <Card>
        <CardHeader
          title={<span className="text-xl">Sign in with your phone</span>}
          description="For caretakers. We text a 6-digit code to the phone number your agency has on record."
        />
        <CardBody>
          <form onSubmit={sendCode} noValidate className="space-y-4">
            {error ? <Alert tone="error">{error}</Alert> : null}
            <TextField
              label="Phone number"
              type="tel"
              name="phone"
              inputMode="tel"
              autoComplete="tel"
              placeholder="024 412 3456"
              required
              value={phoneInput}
              onChange={(event) => setPhoneInput(event.target.value)}
            />
            <Button type="submit" pending={pending} className="w-full">
              Send code
            </Button>
          </form>
          <p className="text-sm text-slate-700">
            Sign in with an email address and password?{' '}
            <Link href="/sign-in" className={linkClass}>
              Sign in with email
            </Link>
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={<span className="text-xl">Enter your code</span>}
        description="If this number is on record, a code is on its way by SMS. It expires in 10 minutes."
      />
      <CardBody>
        <form onSubmit={verify} noValidate className="space-y-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          {resent && !error ? <Alert tone="success">A new code is on its way.</Alert> : null}
          <TextField
            label="6-digit code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <Button type="submit" pending={pending} className="w-full">
            Sign in
          </Button>
        </form>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              void send(step.phone).then((sent) => setResent(sent));
            }}
          >
            Send a new code
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setError(null);
              setStep({ kind: 'phone' });
            }}
          >
            Use a different number
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
