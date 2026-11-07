import { tryNormalisePhone } from '@rent/domain/phone';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { authClient } from '../src/auth-client';
import { clearDroppedRepairs, droppedRepairs } from '../src/repair-dropped';
import { useSession } from '../src/session';
import { Body, Button, ErrorText, Field, Notice, Screen } from '../src/ui';

type Step = { kind: 'phone' } | { kind: 'code'; phone: string };

/** Tenant sign-in by phone one-time code (AD-06). */
export default function SignIn() {
  const router = useRouter();
  const { refresh, ended, finishSignOut } = useSession();
  const [step, setStep] = useState<Step>({ kind: 'phone' });
  const [phoneInput, setPhoneInput] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Requests a session's end removed from the phone (M8 review LT 9): said here, once signed in
  // no more.
  const dropped = droppedRepairs();

  async function sendCode() {
    setError(null);
    const phone = tryNormalisePhone(phoneInput);
    if (!phone) {
      setError('Enter your phone number, for example 024 412 3456.');
      return;
    }
    setBusy(true);
    // A sign-out made offline on this phone is finished first (src/session.tsx).
    await finishSignOut?.().catch(() => undefined);
    const result = await authClient.phoneNumber.sendOtp({ phoneNumber: phone });
    setBusy(false);
    if (result.error) {
      setError(
        result.error.status === 429
          ? 'Too many codes requested. Try again in a few minutes.'
          : 'We could not send a code. Try again.',
      );
      return;
    }
    setCode('');
    setStep({ kind: 'code', phone });
  }

  async function verifyCode() {
    if (step.kind !== 'code') return;
    setError(null);
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from the SMS.');
      return;
    }
    setBusy(true);
    const result = await authClient.phoneNumber.verify({ phoneNumber: step.phone, code });
    if (result.error) {
      setBusy(false);
      setError(
        result.error.status === 403
          ? 'Too many attempts. Request a new code.'
          : 'That code is not right, or it has expired.',
      );
      return;
    }
    await refresh();
    clearDroppedRepairs();
    setBusy(false);
    router.replace('/home');
  }

  if (step.kind === 'phone') {
    return (
      <Screen title="Sign in">
        {ended ? (
          <Notice testID="session-ended">Your session has ended. Sign in again to continue.</Notice>
        ) : null}
        {dropped > 0 ? (
          <Notice testID="repairs-dropped">
            {dropped === 1
              ? 'The repair request you had not sent yet was removed from this phone when your session ended. Write it again after you sign in.'
              : `The ${dropped} repair requests you had not sent yet were removed from this phone when your session ended. Write them again after you sign in.`}
          </Notice>
        ) : null}
        <Body>
          Enter the phone number your landlord has on record. We will text you a 6-digit code.
        </Body>
        <Field
          label="Phone number"
          testID="phone-input"
          value={phoneInput}
          onChangeText={setPhoneInput}
          keyboardType="phone-pad"
          autoComplete="tel"
          textContentType="telephoneNumber"
          placeholder="024 412 3456"
        />
        {error ? <ErrorText>{error}</ErrorText> : null}
        <Button label="Send code" testID="send-code" busy={busy} onPress={() => void sendCode()} />
      </Screen>
    );
  }

  return (
    <Screen title="Enter your code">
      <Body>If this number is on record, a code is on its way. It expires in 10 minutes.</Body>
      <Field
        label="6-digit code"
        testID="code-input"
        value={code}
        onChangeText={(text) => setCode(text.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        autoComplete="sms-otp"
        textContentType="oneTimeCode"
        maxLength={6}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button label="Sign in" testID="verify-code" busy={busy} onPress={() => void verifyCode()} />
      <Button
        label="Use a different number"
        variant="quiet"
        testID="change-number"
        onPress={() => setStep({ kind: 'phone' })}
      />
    </Screen>
  );
}
