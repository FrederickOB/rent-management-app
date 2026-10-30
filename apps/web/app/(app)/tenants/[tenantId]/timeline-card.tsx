'use client';

import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/components/app-context';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { timelineDetail, timelineLabel } from '@/lib/tenancy-format';

type Event = Awaited<ReturnType<ReturnType<typeof api>['tenants']['timeline']>>[number];

/**
 * The tenant's timeline (plan 4.16): the record, its contacts, consent, ID checks and leases, from
 * the audit log. Payments join in M4 and messages in M6. Times show the company's time zone.
 */
export function TimelineCard({
  tenantId,
  version,
}: {
  readonly tenantId: string;
  /** Changes whenever the page saves something, so the timeline reloads. */
  readonly version: number;
}) {
  const { timeZone } = useApp();
  const [events, setEvents] = useState<readonly Event[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEvents(await api().tenants.timeline({ tenantId }));
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  return (
    <Card data-testid="timeline">
      <CardHeader
        title="Timeline"
        description="Everything recorded about this tenant, newest first."
      />
      <CardBody>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {events === null ? (
          <p role="status" className="text-sm text-slate-600">
            Loading…
          </p>
        ) : events.length === 0 ? (
          <p className="text-sm text-slate-600">Nothing recorded yet.</p>
        ) : (
          <ol className="divide-y divide-slate-100" aria-label="Timeline">
            {events.map((event, index) => {
              const detail = timelineDetail(event.action, event.data);
              return (
                <li
                  key={`${event.at}-${event.action}-${index}`}
                  data-testid="timeline-event"
                  className="space-y-1 py-3 text-sm"
                >
                  <p className="font-medium text-slate-900">{timelineLabel(event.action)}</p>
                  <p className="text-slate-700">
                    <time dateTime={event.at}>{formatTime(event.at, timeZone)}</time> ·{' '}
                    {event.actorName ?? 'The system'}
                  </p>
                  {detail ? <p className="break-words text-slate-600">{detail}</p> : null}
                </li>
              );
            })}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}
