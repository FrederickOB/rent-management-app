'use client';

import { useState, type FormEvent } from 'react';
import { ConfirmBox } from '@/components/confirm-box';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextAreaField, TextField } from '@/components/ui/field';
import {
  recoveryMessage,
  recoveryReasonProblem,
  recoveryResultText,
  RECOVERY_REASON_MAX,
  RUNBOOK_PATH,
} from '@/lib/account-recovery';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { roleLabel } from '@/lib/format';

type Person = NonNullable<
  Awaited<ReturnType<ReturnType<typeof api>['platformAdmin']['findPerson']>>
>;

const problemText = (failure: unknown): string =>
  recoveryMessage(failure) ?? toProblem(failure).message;

export function AccountRecovery({
  can,
}: {
  readonly can: { readonly reset: boolean; readonly revoke: boolean };
}) {
  const [email, setEmail] = useState('');
  const [person, setPerson] = useState<Person | null>(null);
  const [searched, setSearched] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    setNotice(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setProblem('Enter the person’s email address in full.');
      return;
    }
    setPending(true);
    try {
      // By POST, so the email never sits in a URL.
      setPerson(await api().platformAdmin.findPerson({ email: email.trim() }));
      setSearched(true);
    } catch (failure) {
      setProblem(problemText(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Find the person"
          description={`By their exact email address. Follow ${RUNBOOK_PATH} before doing anything.`}
        />
        <CardBody className="space-y-3">
          <form
            aria-label="Find a person"
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => void find(event)}
          >
            <TextField
              label="Email address"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="min-w-64"
            />
            <Button type="submit" variant="secondary" pending={pending}>
              Find
            </Button>
          </form>
          {problem ? <Alert tone="error">{problem}</Alert> : null}
          {searched && !person ? (
            <p className="text-sm text-slate-700">There is no one with that email address.</p>
          ) : null}
        </CardBody>
      </Card>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {person ? (
        <Card data-testid="recovery-person">
          <CardHeader title={person.name} />
          <CardBody className="space-y-3 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={person.twoFactorEnabled ? 'green' : 'amber'}>
                {person.twoFactorEnabled ? 'Two-factor set up' : 'No two-factor'}
              </Badge>
              <span data-testid="recovery-sessions">
                {person.sessions} {person.sessions === 1 ? 'session' : 'sessions'} signed in
              </span>
            </p>
            {person.companies.length > 0 ? (
              <ul className="list-disc pl-5 text-slate-800">
                {person.companies.map((c, index) => (
                  <li key={`${c.companyName}-${index}`}>
                    {c.companyName}, as {roleLabel(c.role)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-slate-600">Not a member of any company.</p>
            )}
            <div className="flex flex-wrap gap-2">
              {can.reset && person.twoFactorEnabled ? (
                <RecoveryAction
                  what="Reset two-factor"
                  confirmText="Yes, reset two-factor"
                  explain={`${person.name}’s authenticator stops working at once, and every session ends. They set up a new authenticator the next time they sign in.`}
                  run={async (reason) => {
                    const result = await api().platformAdmin.resetTwoFactor({
                      personId: person.personId,
                      reason,
                    });
                    setNotice(recoveryResultText(person.name, result));
                    setPerson({ ...person, twoFactorEnabled: false, sessions: 0 });
                  }}
                />
              ) : null}
              {can.revoke && person.sessions > 0 ? (
                <RecoveryAction
                  what="Sign out everywhere"
                  confirmText="Yes, sign them out everywhere"
                  explain={`Every session ${person.name} has ends at once, on every device. Their password and authenticator stay as they are.`}
                  run={async (reason) => {
                    const result = await api().platformAdmin.revokeSessions({
                      personId: person.personId,
                      reason,
                    });
                    setNotice(recoveryResultText(person.name, result));
                    setPerson({ ...person, sessions: 0 });
                  }}
                />
              ) : null}
            </div>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}

/** A recovery action: a reason with the identity check made (audited), then a confirmation. */
function RecoveryAction({
  what,
  confirmText,
  explain,
  run,
}: {
  readonly what: string;
  readonly confirmText: string;
  readonly explain: string;
  readonly run: (reason: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  if (!open)
    return (
      <Button size="sm" variant="danger" onClick={() => setOpen(true)}>
        {what}
      </Button>
    );

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await run(reason.trim());
      setOpen(false);
      setConfirming(false);
      setReason('');
    } catch (failure) {
      setConfirming(false);
      setError(problemText(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="w-full space-y-2 rounded-md border border-slate-200 p-3">
      <TextAreaField
        label={`Why: ${what.toLowerCase()}`}
        hint="Say how you checked who they are. It is kept in the audit log."
        rows={2}
        maxLength={RECOVERY_REASON_MAX}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        error={error}
        className="[&_textarea]:font-sans"
      />
      {confirming ? (
        <ConfirmBox
          label={`Confirm: ${what.toLowerCase()}`}
          confirmText={confirmText}
          pending={pending}
          onConfirm={() => void confirm()}
          onCancel={() => setConfirming(false)}
        >
          {explain}
        </ConfirmBox>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              const problem = recoveryReasonProblem(reason);
              setError(problem);
              if (!problem) setConfirming(true);
            }}
          >
            {what}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
