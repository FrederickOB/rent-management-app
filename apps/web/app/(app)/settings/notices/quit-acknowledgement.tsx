'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { acknowledgementProblem } from '@/lib/notice-settings';

type Acknowledgement = Awaited<ReturnType<ReturnType<typeof api>['quitAcknowledgement']['get']>>;

/**
 * The OQ-16 acknowledgement (decision 9): notices to quit stay off until an agency admin or the
 * landlord accepts this versioned statement by typing their name. Its version and hash are kept
 * with the acceptance. Withdrawing turns notices to quit off again; those already issued carry on.
 */
export function QuitAcknowledgementCard() {
  const { timeZone } = useApp();
  const [ack, setAck] = useState<Acknowledgement | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [typedName, setTypedName] = useState('');
  const [reason, setReason] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAck(await api().quitAcknowledgement.get());
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (problem) return <LoadFailed message={problem} onRetry={() => void load()} />;
  if (!ack) return <Loading what="the notice to quit acknowledgement" />;

  async function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ack) return;
    const wrong = acknowledgementProblem(typedName);
    setError(wrong);
    setDone(null);
    if (wrong) return;
    setPending(true);
    try {
      setAck(
        await api().quitAcknowledgement.grant({
          statementVersion: ack.statement.version,
          typedName: typedName.trim(),
        }),
      );
      setTypedName('');
      setDone(
        'Accepted. Notices to quit are now on for your company, each with two-person approval.',
      );
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  async function withdraw(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reason.trim().length < 3) {
      setError('Give a reason of at least 3 characters.');
      return;
    }
    setPending(true);
    setError(null);
    setDone(null);
    try {
      setAck(await api().quitAcknowledgement.withdraw({ reason: reason.trim() }));
      setReason('');
      setWithdrawing(false);
      setDone('Withdrawn. Notices to quit are off again; those already issued carry on.');
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-testid="quit-acknowledgement">
      <CardHeader
        title="Notices to quit"
        description="Turned off until an administrator accepts the risk below (OQ-16). Each notice to quit then needs two people."
        actions={
          <span data-testid="quit-enabled">
            <Badge tone={ack.enabled ? 'green' : 'amber'}>{ack.enabled ? 'On' : 'Off'}</Badge>
          </span>
        }
      />
      <CardBody>
        <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-900">
            The statement (version {ack.statement.version})
          </p>
          <p className="text-sm whitespace-pre-wrap text-slate-800" data-testid="quit-statement">
            {ack.statement.text}
          </p>
          <p className="font-mono text-xs break-all text-slate-600">
            SHA-256 {ack.statement.sha256}
          </p>
        </div>
        {ack.current ? (
          <p className="text-sm text-slate-700">
            Accepted by {ack.current.byName}, who typed “{ack.current.typedName}”,{' '}
            {formatTime(ack.current.at, timeZone)} (statement version {ack.current.statementVersion}
            ).
            {ack.current.statementVersion !== ack.statement.version
              ? ' The statement has changed since; accepting the new version keeps notices to quit on.'
              : ''}
          </p>
        ) : null}
        {ack.mayChange &&
        (!ack.enabled || ack.current?.statementVersion !== ack.statement.version) ? (
          <form onSubmit={grant} noValidate aria-label="Accept the statement" className="space-y-3">
            <TextField
              label="Type your full name to accept the statement"
              autoComplete="name"
              maxLength={120}
              value={typedName}
              onChange={(event) => setTypedName(event.target.value)}
            />
            <Button type="submit" pending={pending}>
              Accept and turn notices to quit on
            </Button>
          </form>
        ) : null}
        {ack.mayChange && ack.enabled && !withdrawing ? (
          <Button variant="ghost" onClick={() => setWithdrawing(true)}>
            Withdraw the acceptance
          </Button>
        ) : null}
        {withdrawing ? (
          <form
            onSubmit={withdraw}
            noValidate
            aria-label="Withdraw the acceptance"
            className="space-y-3 rounded-md border border-red-200 bg-red-50 p-3"
          >
            <TextField
              label="Reason"
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="danger" pending={pending}>
                Turn notices to quit off
              </Button>
              <Button variant="ghost" onClick={() => setWithdrawing(false)}>
                Keep them on
              </Button>
            </div>
          </form>
        ) : null}
        {!ack.mayChange ? (
          <p className="text-sm text-slate-600">
            Only an agency administrator or the landlord can accept or withdraw this.
          </p>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {done ? <Alert tone="success">{done}</Alert> : null}
        {ack.history.length ? (
          <div className="space-y-1 text-sm">
            <p className="font-medium text-slate-900">History</p>
            <ul className="space-y-1">
              {ack.history.map((h, index) => (
                <li key={`${h.at}-${index}`} className="text-slate-700">
                  {h.action === 'grant' ? 'Accepted' : 'Withdrawn'} by {h.byName},{' '}
                  {formatTime(h.at, timeZone)} (version {h.statementVersion})
                  {h.reason ? `: ${h.reason}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
