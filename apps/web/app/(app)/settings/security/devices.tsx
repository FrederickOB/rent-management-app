'use client';

import { useCallback, useState } from 'react';
import { useApp } from '@/components/app-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { authClient } from '@/lib/auth-client';
import { describeDevice } from '@/lib/device';
import { authProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { useLoad } from '@/lib/use-load';

interface Device {
  readonly id: string;
  readonly token: string;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly lastActiveAt: string;
  readonly expiresAt: string;
  readonly current: boolean;
}

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

async function loadDevices(): Promise<Device[]> {
  const client = authClient();
  const [sessions, current] = await Promise.all([client.listSessions(), client.getSession()]);
  if (sessions.error) throw sessions.error;
  const currentId = current.data?.session.id ?? null;
  return (sessions.data ?? [])
    .map((s) => ({
      id: s.id,
      token: s.token,
      userAgent: s.userAgent ?? null,
      createdAt: iso(s.createdAt),
      lastActiveAt: iso(s.updatedAt),
      expiresAt: iso(s.expiresAt),
      current: s.id === currentId,
    }))
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) || b.lastActiveAt.localeCompare(a.lastActiveAt),
    );
}

/** The device list and remote sign-out (AD-06). A revoked session fails on its next request. */
export function Devices() {
  const { timeZone } = useApp();
  const { state, reload } = useLoad(loadDevices, authProblem);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const revoke = useCallback(
    async (device: Device) => {
      setBusy(device.id);
      setNotice(null);
      try {
        const result = await authClient().revokeSession({ token: device.token });
        if (result.error) throw result.error;
        setNotice({ tone: 'success', text: `Signed out ${describeDevice(device.userAgent)}.` });
        reload();
      } catch (failure) {
        setNotice({ tone: 'error', text: authProblem(failure).message });
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  const revokeOthers = useCallback(async () => {
    setBusy('others');
    setNotice(null);
    try {
      const result = await authClient().revokeOtherSessions();
      if (result.error) throw result.error;
      setNotice({ tone: 'success', text: 'Signed out of every other device.' });
      reload();
    } catch (failure) {
      setNotice({ tone: 'error', text: authProblem(failure).message });
    } finally {
      setBusy(null);
    }
  }, [reload]);

  const devices = state.status === 'ready' ? state.data : [];
  const others = devices.filter((d) => !d.current).length;

  return (
    <Card>
      <CardHeader
        title="Devices"
        description={`Where you are signed in now. Times are in ${timeZone}.`}
        actions={
          others > 0 ? (
            <Button
              variant="secondary"
              pending={busy === 'others'}
              onClick={() => void revokeOthers()}
            >
              Sign out all other devices
            </Button>
          ) : null
        }
      />
      <CardBody>
        {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
        {state.status === 'loading' ? (
          <p role="status" className="text-sm text-slate-600">
            Loading your devices…
          </p>
        ) : null}
        {state.status === 'error' ? <Alert tone="error">{state.problem.message}</Alert> : null}
        {state.status === 'ready' ? (
          <ul className="divide-y divide-slate-200" aria-label="Signed-in devices">
            {devices.map((device) => (
              <li
                key={device.id}
                data-testid="session"
                className="flex flex-wrap items-start justify-between gap-3 py-3"
              >
                <div className="min-w-0 space-y-1">
                  <p className="font-medium">
                    {describeDevice(device.userAgent)}
                    {device.current ? (
                      <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
                        This device
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs break-all text-slate-500">
                    {device.userAgent ?? 'No browser details'}
                  </p>
                  <dl className="grid gap-x-4 text-sm text-slate-700 sm:grid-cols-[auto_1fr]">
                    <dt className="text-slate-500">Signed in</dt>
                    <dd>{formatTime(device.createdAt, timeZone)}</dd>
                    <dt className="text-slate-500">Last active</dt>
                    <dd>{formatTime(device.lastActiveAt, timeZone)}</dd>
                    <dt className="text-slate-500">Ends by</dt>
                    <dd>{formatTime(device.expiresAt, timeZone)}</dd>
                  </dl>
                </div>
                {device.current ? null : (
                  <Button
                    variant="secondary"
                    size="sm"
                    pending={busy === device.id}
                    onClick={() => void revoke(device)}
                  >
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}
