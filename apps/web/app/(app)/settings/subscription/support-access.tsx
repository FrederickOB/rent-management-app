'use client';

import { useCallback, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextAreaField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  grantActiveAt,
  grantHoursProblem,
  grantStateText,
  SUPPORT_CONSENT_TEXT,
  SUPPORT_GRANT_DEFAULT_HOURS,
  subscriptionMessage,
} from '@/lib/subscription';
import { useLoad } from '@/lib/use-load';
import { useNow } from '@/lib/use-now';

type Grant = Awaited<ReturnType<ReturnType<typeof api>['supportGrants']['list']>>[number];

/**
 * Support access (AD-10, decision 13): the company's admin lets the platform's support read the
 * company, read-only, for a reason and a time, and ends it at will. Each request made under a
 * grant is listed, as the company's audit log records it.
 */
export function SupportAccess() {
  const load = useCallback(() => api().supportGrants.list(), []);
  const { state, reload } = useLoad(load);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <Card data-testid="support-access">
      <CardHeader title="Support access" description={SUPPORT_CONSENT_TEXT} />
      <CardBody className="space-y-4">
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        <GrantForm
          onGranted={(text) => {
            setNotice(text);
            reload();
          }}
        />
        {state.status === 'loading' ? <Loading what="support access" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {state.status === 'ready' ? (
          state.data.length === 0 ? (
            <Empty>Support has never had access to this company.</Empty>
          ) : (
            <ul className="space-y-3">
              {state.data.map((grant) => (
                <GrantItem
                  key={grant.id}
                  grant={grant}
                  onRevoked={(text) => {
                    setNotice(text);
                    reload();
                  }}
                />
              ))}
            </ul>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}

function GrantForm({ onGranted }: { readonly onGranted: (text: string) => void }) {
  const { timeZone } = useApp();
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(String(SUPPORT_GRANT_DEFAULT_HOURS));
  const [errors, setErrors] = useState<{ reason?: string; hours?: string }>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    const trimmed = reason.trim();
    const count = /^\d+$/.test(hours.trim()) ? Number(hours.trim()) : Number.NaN;
    const next = {
      reason:
        trimmed.length < 5
          ? 'Say why support needs access, in a few words.'
          : trimmed.length > 500
            ? 'Keep the reason under 500 characters.'
            : undefined,
      hours: grantHoursProblem(count) ?? undefined,
    };
    setErrors(next);
    if (next.reason || next.hours) return;
    setPending(true);
    try {
      const grant = await api().supportGrants.grant({ reason: trimmed, hours: count });
      setReason('');
      setHours(String(SUPPORT_GRANT_DEFAULT_HOURS));
      onGranted(`Support can read the company until ${formatTime(grant.until, timeZone)}.`);
    } catch (failure) {
      setProblem(subscriptionMessage(failure) ?? toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      aria-label="Grant support access"
      className="space-y-3"
      onSubmit={(event) => void submit(event)}
    >
      <TextAreaField
        label="Why support needs access"
        value={reason}
        rows={2}
        maxLength={500}
        onChange={(event) => setReason(event.target.value)}
        error={errors.reason}
      />
      <TextField
        label="For how many hours"
        hint="24 hours unless you choose otherwise; at most 7 days (168 hours)."
        inputMode="numeric"
        value={hours}
        onChange={(event) => setHours(event.target.value)}
        error={errors.hours}
        className="max-w-48"
      />
      <Button type="submit" pending={pending}>
        Grant read-only access
      </Button>
      {problem ? <Alert tone="error">{problem}</Alert> : null}
    </form>
  );
}

function GrantItem({
  grant,
  onRevoked,
}: {
  readonly grant: Grant;
  readonly onRevoked: (text: string) => void;
}) {
  const { timeZone } = useApp();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const time = (iso: string) => formatTime(iso, timeZone);
  // Review N7: the server's `active`, ended at the grant's expiry as time moves on.
  const now = useNow();
  const active = grantActiveAt(grant, now);
  const stateText = grantStateText(
    { expiresAt: grant.until, revokedAt: grant.revokedAt, revokedByName: grant.revokedByName },
    active ? grant.from : grant.until,
    time,
  );

  async function revoke() {
    setPending(true);
    setProblem(null);
    try {
      await api().supportGrants.revoke({ grantId: grant.id });
      onRevoked('Support access ended.');
    } catch (failure) {
      setProblem(subscriptionMessage(failure) ?? toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <li
      className="space-y-2 rounded-md border border-slate-200 p-3 text-sm"
      data-testid="support-grant"
    >
      <p className="flex flex-wrap items-center gap-2">
        <Badge tone={active ? 'amber' : 'neutral'}>{active ? 'Active' : 'Ended'}</Badge>
        <span className="text-slate-900">{grant.reason}</span>
      </p>
      <p className="text-slate-700">
        Granted by {grant.grantedBy.name} {time(grant.from)}. {stateText.text}
      </p>
      {grant.sessions.length > 0 ? (
        <Table caption="Pages support opened under this access">
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Who</Th>
              <Th>What</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {grant.sessions.map((session, index) => (
              <tr key={`${session.at}-${index}`}>
                <Td>{time(session.at)}</Td>
                <Td>{session.adminName}</Td>
                <Td className="break-all">
                  {session.route}
                  {session.record ? ` (${session.record})` : ''}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="text-slate-600">Support has opened nothing under this access.</p>
      )}
      {active ? (
        <Button size="sm" variant="danger" pending={pending} onClick={() => void revoke()}>
          End this access now
        </Button>
      ) : null}
      {problem ? <Alert tone="error">{problem}</Alert> : null}
    </li>
  );
}
