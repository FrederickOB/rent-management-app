'use client';

import type { InboxStreamEvent } from '@rent/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/components/app-context';
import { MessageStatusBadge } from '@/components/inbox-badges';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { eventTouches } from '@/lib/inbox';
import { useCoalesced, useInboxStream } from '@/lib/inbox-stream';
import { timelineDetail, timelineLabel } from '@/lib/tenancy-format';
import {
  messageExcerpt,
  messageHeadline,
  messageOfEvent,
  type TimelineEvent,
  type TimelineMessage,
} from '@/lib/timeline';

/**
 * The tenant's timeline (plan 4.16): the record, its contacts, consent, ID checks and leases, from
 * the audit log, and since M6 every message to and from them (CM-05). The API puts the messages in
 * the timeline itself, on every plan (decision 9: a Starter landlord finds what the tenant wrote
 * here), so each shows once (review W2). With the inbox, it is live and links to the conversation.
 * Times show the company's time zone.
 */
export function TimelineCard({
  tenantId,
  version,
  withMessages = false,
  canWrite = false,
}: {
  readonly tenantId: string;
  /** Changes whenever the page saves something, so the timeline reloads. */
  readonly version: number;
  /** Whether this person and plan have the inbox: the conversation link and live updates (M6). */
  readonly withMessages?: boolean;
  /** Whether this person may write to the tenant (messaging.reply), to start a conversation. */
  readonly canWrite?: boolean;
}) {
  const { timeZone } = useApp();
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [startProblem, setStartProblem] = useState<string | null>(null);
  const [events, setEvents] = useState<readonly TimelineEvent[] | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [timeline, conversation] = await Promise.all([
        api().tenants.timeline({ tenantId }),
        withMessages
          ? api()
              .inbox.tenantConversation({ tenantId })
              .then(
                (found) => found.conversation?.id ?? null,
                // The link and live updates are extras; the timeline shows without them.
                () => null,
              )
          : Promise.resolve(null),
      ]);
      setEvents(timeline);
      setConversationId(conversation);
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, [tenantId, withMessages]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const refresh = useCoalesced(() => void load());
  const handlers = useMemo(
    () => ({
      onEvent: (event: InboxStreamEvent) => {
        if (conversationId && eventTouches(event, conversationId)) refresh();
      },
      onResync: refresh,
    }),
    [conversationId, refresh],
  );
  useInboxStream(withMessages && conversationId !== null, handlers);

  async function start() {
    setStarting(true);
    setStartProblem(null);
    try {
      const conversation = await api().inbox.startConversation({ tenantId });
      router.push(`/inbox/${conversation.id}`);
    } catch (failure) {
      setStartProblem(toProblem(failure).message);
      setStarting(false);
    }
  }

  return (
    <Card data-testid="timeline">
      <CardHeader
        title="Timeline"
        description="Everything recorded about this tenant, and every message to and from them, newest first."
        actions={
          conversationId ? (
            <Link
              href={`/inbox/${conversationId}`}
              className="text-sm font-medium underline underline-offset-2"
            >
              Open the conversation
            </Link>
          ) : withMessages && canWrite && events !== null ? (
            <Button size="sm" variant="secondary" pending={starting} onClick={() => void start()}>
              Write to the tenant
            </Button>
          ) : null
        }
      />
      <CardBody>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {startProblem ? <Alert tone="error">{startProblem}</Alert> : null}
        {events === null ? (
          <p role="status" className="text-sm text-slate-600">
            Loading…
          </p>
        ) : events.length === 0 ? (
          <p className="text-sm text-slate-600">Nothing recorded yet.</p>
        ) : (
          <ol className="divide-y divide-slate-100" aria-label="Timeline">
            {events.map((event, index) => {
              const key = `${event.at}-${event.action}-${event.recordId ?? index}`;
              const message = messageOfEvent(event);
              return message ? (
                <MessageItem key={key} at={event.at} message={message} timeZone={timeZone} />
              ) : (
                <EventItem key={key} event={event} timeZone={timeZone} />
              );
            })}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

function EventItem({
  event,
  timeZone,
}: {
  readonly event: TimelineEvent;
  readonly timeZone: string;
}) {
  const detail = timelineDetail(event.action, event.data);
  return (
    <li data-testid="timeline-event" className="space-y-1 py-3 text-sm">
      <p className="font-medium text-slate-900">{timelineLabel(event.action)}</p>
      <p className="text-slate-700">
        <time dateTime={event.at}>{formatTime(event.at, timeZone)}</time> ·{' '}
        {event.actorName ?? 'The system'}
      </p>
      {detail ? <p className="break-words text-slate-600">{detail}</p> : null}
    </li>
  );
}

function MessageItem({
  at,
  message,
  timeZone,
}: {
  readonly at: string;
  readonly message: TimelineMessage;
  readonly timeZone: string;
}) {
  return (
    <li
      data-testid="timeline-message"
      data-direction={message.direction}
      className="space-y-1 py-3 text-sm"
    >
      <p className="font-medium text-slate-900">{messageHeadline(message)}</p>
      <p className="text-slate-700">
        <time dateTime={at}>{formatTime(at, timeZone)}</time>
      </p>
      {message.subject ? <p className="text-slate-800">Subject: {message.subject}</p> : null}
      {message.preview ? (
        <p className="break-words whitespace-pre-wrap text-slate-800" data-testid="message-body">
          {messageExcerpt(message.preview)}
        </p>
      ) : null}
      {message.status ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <MessageStatusBadge status={message.status} />
        </p>
      ) : null}
    </li>
  );
}
