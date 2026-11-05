'use client';

import type {
  ConversationDetail,
  ConversationSummary,
  InboxStreamEvent,
  ThreadMessage,
} from '@rent/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/components/app-context';
import {
  ChannelBadge,
  ConversationStateBadge,
  MessageStatusBadge,
  StreamStatusLine,
} from '@/components/inbox-badges';
import { LoadFailed, Loading } from '@/components/load-state';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { openFetchedLink } from '@/lib/browser-files';
import { formatBusinessDate } from '@/lib/business-dates';
import { cn } from '@/lib/cn';
import { toProblem, type Problem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  authorLabel,
  conversationTitle,
  eventTouches,
  HANDOVER_REASON_LABELS,
  mergeMessages,
  msUntil,
  responseDueText,
  sinceText,
  sizeText,
  statusReasonText,
  windowStatus,
} from '@/lib/inbox';
import { useCoalesced, useInboxStream } from '@/lib/inbox-stream';
import { useRequestGate } from '@/lib/request-gate';
import { isNotOnPlan } from '@/lib/plan';
import { formatMinor } from '@/lib/tenancy-format';
import { useInterval } from '@/lib/use-interval';
import { ConversationActions } from './conversation-actions';
import { Composer } from './composer';

const PAGE = 50;

/** The thread page: messages oldest first, the composer, and the side panel. */
export function ThreadView({
  conversationId,
  since,
}: {
  readonly conversationId: string;
  readonly since: string | null;
}) {
  const { timeZone } = useApp();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<readonly ThreadMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Undefined until the first page arrives; null when there is nothing older.
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [refreshProblem, setRefreshProblem] = useState<string | null>(null);
  const [olderProblem, setOlderProblem] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const loadedOnce = useRef(false);
  // A slow reply that arrives after a newer one is dropped, so the detail never goes back in time.
  const gate = useRequestGate();

  const load = useCallback(async () => {
    const current = gate.begin();
    try {
      const [conversation, page] = await Promise.all([
        api().inbox.conversation({ conversationId }),
        api().inbox.messages({ conversationId, ...(since ? { since } : {}), limit: PAGE }),
      ]);
      if (!current()) return;
      setDetail(conversation);
      setMessages((current) => mergeMessages(current, page.items));
      setOlderCursor((cursor) => (cursor === undefined ? page.nextCursor : cursor));
      loadedOnce.current = true;
      setLoaded(true);
      setProblem(null);
      setRefreshProblem(null);
      setNow(new Date());
    } catch (failure) {
      if (!current()) return;
      // A failed first load replaces the page; a failed refresh keeps what is shown.
      if (loadedOnce.current) setRefreshProblem(toProblem(failure).message);
      else setProblem(toProblem(failure));
    }
  }, [gate, conversationId, since]);

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);

  const refresh = useCoalesced(() => void load());
  const mergedFrom = detail?.mergedFrom;
  const handlers = useMemo(
    () => ({
      onEvent: (event: InboxStreamEvent) => {
        if (eventTouches(event, conversationId, mergedFrom)) refresh();
      },
      onResync: refresh,
    }),
    [conversationId, mergedFrom, refresh],
  );
  const stream = useInboxStream(loaded, handlers);
  useInterval(refresh, loaded ? stream.pollMs : null);
  // The window's remaining time and the response target count down.
  useInterval(() => setNow(new Date()), 30_000);
  // When the WhatsApp window closes, the composer must stop offering free text: fetch the
  // conversation again then, so the API says what each channel takes now (review W12).
  const closesAt = detail?.channels.find((c) => c.channel === 'whatsapp')?.windowClosesAt ?? null;
  useEffect(() => {
    const wait = msUntil(closesAt, new Date());
    if (wait === null) return undefined;
    const id = window.setTimeout(refresh, wait);
    return () => window.clearTimeout(id);
  }, [closesAt, refresh]);

  async function loadOlder() {
    if (!olderCursor) return;
    setLoadingOlder(true);
    setOlderProblem(null);
    try {
      const page = await api().inbox.messages({
        conversationId,
        ...(since ? { since } : {}),
        cursor: olderCursor,
        limit: PAGE,
      });
      setMessages((current) => mergeMessages(current, page.items));
      setOlderCursor(page.nextCursor);
    } catch (failure) {
      setOlderProblem(toProblem(failure).message);
    } finally {
      setLoadingOlder(false);
    }
  }

  const changed = useCallback(
    (summary: ConversationSummary) => {
      setDetail((current) => (current ? { ...current, ...summary } : current));
      refresh();
    },
    [refresh],
  );

  if (problem) {
    const missing = problem.status === 404 || problem.status === 400;
    return (
      <>
        <Breadcrumb title="Conversation" />
        <PageHeader title="Conversation" />
        {missing ? (
          <Alert tone="info">This conversation does not exist, or it is not one you can see.</Alert>
        ) : problem.status === 403 && problem.code?.toUpperCase() === 'NOT_ON_PLAN' ? (
          <Alert tone="info">The inbox is not on your company’s plan.</Alert>
        ) : (
          <LoadFailed message={problem.message} onRetry={() => void load()} />
        )}
      </>
    );
  }
  if (!detail) {
    return (
      <>
        <Breadcrumb title="Conversation" />
        <Loading what="the conversation" />
      </>
    );
  }

  const title = conversationTitle(detail);
  const whatsapp = detail.channels.find((c) => c.channel === 'whatsapp');
  const waWindow = whatsapp ? windowStatus(whatsapp.windowClosesAt, now, timeZone) : null;
  const due = responseDueText(detail, now, timeZone);

  return (
    <>
      <Breadcrumb title={title} />
      <div className="space-y-2">
        <PageHeader title={title} />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <ConversationStateBadge state={detail.state} />
          {detail.overdue ? <Badge tone="red">Overdue</Badge> : null}
          {detail.handoverReason ? (
            <Badge tone="blue">{HANDOVER_REASON_LABELS[detail.handoverReason]}</Badge>
          ) : null}
          {detail.tenant ? (
            <Link href={`/tenants/${detail.tenant.id}`} className="underline underline-offset-2">
              Tenant profile
            </Link>
          ) : null}
          {detail.leases.map((lease) => (
            <Link
              key={lease.leaseId}
              href={`/portfolio/units/${lease.unitId}`}
              className="font-mono text-xs underline underline-offset-2"
            >
              {lease.unitCode}
            </Link>
          ))}
        </div>
        <StreamStatusLine status={stream.status} />
      </div>

      {refreshProblem ? <Alert tone="warning">{refreshProblem}</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader
              title="Messages"
              description="Oldest first, on every channel. Sent messages are kept as they went: they cannot be edited or deleted."
            />
            <CardBody>
              {since ? (
                <Alert tone="info">
                  {sinceText(since, formatBusinessDate)}{' '}
                  <Link href={`/inbox/${conversationId}`} className="underline underline-offset-2">
                    Show the whole conversation
                  </Link>
                </Alert>
              ) : null}
              {olderCursor ? (
                <Button
                  size="sm"
                  variant="secondary"
                  pending={loadingOlder}
                  onClick={() => void loadOlder()}
                >
                  Show earlier messages
                </Button>
              ) : null}
              {olderProblem ? <Alert tone="error">{olderProblem}</Alert> : null}
              {messages.length === 0 ? (
                <p className="text-sm text-slate-600">No messages yet.</p>
              ) : (
                <ol className="space-y-3" aria-label="Messages">
                  {messages.map((message) => (
                    <MessageItem
                      key={message.id}
                      message={message}
                      conversationId={detail.id}
                      timeZone={timeZone}
                    />
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>

          {detail.state === 'resolved' ? (
            <Alert tone="info" title="This conversation is resolved">
              {detail.can.resolve
                ? 'Reopen it to reply. The tenant’s next message reopens it too.'
                : 'The tenant’s next message reopens it.'}
            </Alert>
          ) : detail.state === 'triage' ? (
            <Alert tone="info">
              {detail.can.triage
                ? 'This sender is not linked to a tenant yet. Link them to reply: their messages then join that tenant’s conversation.'
                : 'This sender is not linked to a tenant yet. An administrator or manager can link them.'}
            </Alert>
          ) : detail.can.reply ? (
            <Composer
              detail={detail}
              windowText={waWindow?.open ? waWindow.text : null}
              onSent={(message) => {
                setMessages((current) => mergeMessages(current, [message]));
                refresh();
              }}
              onStale={refresh}
            />
          ) : (
            <Alert tone="info">You can read this conversation, but not reply to it.</Alert>
          )}
        </div>

        <aside className="space-y-4" aria-label="About this conversation">
          {waWindow ? (
            <Card data-testid="whatsapp-window">
              <CardBody>
                <p className={cn('text-sm', waWindow.open ? 'text-emerald-900' : 'text-slate-700')}>
                  {waWindow.text}
                </p>
                {!waWindow.open ? (
                  <p className="text-sm text-slate-600">
                    Outside the window, WhatsApp takes only an approved template.
                  </p>
                ) : null}
              </CardBody>
            </Card>
          ) : null}
          {due ? (
            <Card>
              <CardBody>
                <p
                  data-testid="response-due"
                  className={cn('text-sm', detail.overdue ? 'font-medium text-red-800' : '')}
                >
                  {due}
                </p>
              </CardBody>
            </Card>
          ) : null}
          <ConversationActions detail={detail} onChanged={changed} />
        </aside>
      </div>
    </>
  );
}

function Breadcrumb({ title }: { readonly title: string }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm">
      <Link href="/inbox" className="underline underline-offset-2">
        Inbox
      </Link>{' '}
      <span aria-hidden="true">›</span> <span>{title}</span>
    </nav>
  );
}

/** One message. There is deliberately no control to edit or delete it (CM-05). */
function MessageItem({
  message,
  conversationId,
  timeZone,
}: {
  readonly message: ThreadMessage;
  readonly conversationId: string;
  readonly timeZone: string;
}) {
  const inbound = message.direction === 'inbound';
  const reason = statusReasonText(message.statusReason);
  const arriving = message.attachmentCount - message.attachments.length;
  return (
    <li
      data-testid="thread-message"
      data-direction={message.direction}
      data-message-id={message.id}
      className={cn(
        'space-y-2 rounded-lg border p-3 text-sm',
        inbound ? 'mr-6 border-slate-200 bg-slate-50' : 'ml-6 border-sky-200 bg-sky-50',
      )}
    >
      <p className="flex flex-wrap items-center gap-2 text-slate-700">
        <span className="font-medium text-slate-900">{authorLabel(message)}</span>
        <ChannelBadge channel={message.channel} />
        <time dateTime={message.createdAt}>{formatTime(message.createdAt, timeZone)}</time>
      </p>
      {message.subject ? (
        <p className="font-medium text-slate-900">Subject: {message.subject}</p>
      ) : null}
      <p className="break-words whitespace-pre-wrap text-slate-900" data-testid="message-body">
        {message.body}
      </p>
      {message.templateKey ? (
        <p className="text-xs text-slate-600">
          Sent as the WhatsApp template “{message.templateKey}”, because the 24-hour window was
          closed.
        </p>
      ) : null}
      {message.attachments.length || arriving > 0 ? (
        <Attachments
          message={message}
          conversationId={conversationId}
          arriving={Math.max(0, arriving)}
        />
      ) : null}
      <p className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <MessageStatusBadge status={message.status} />
        {reason ? <span data-testid="message-status-reason">{reason}</span> : null}
        <span>
          <time dateTime={message.statusAt}>{formatTime(message.statusAt, timeZone)}</time>
        </span>
        {message.costMinor !== null ? (
          <span>
            Cost {formatMinor(message.costMinor)}
            {message.currency && message.currency !== 'GHS' ? ` ${message.currency}` : ''}
          </span>
        ) : null}
      </p>
    </li>
  );
}

const KIND_WORDS: Record<ThreadMessage['attachments'][number]['kind'], string> = {
  image: 'photo',
  video: 'video',
  audio: 'voice note',
  document: 'document',
  sticker: 'sticker',
};

function Attachments({
  message,
  conversationId,
  arriving,
}: {
  readonly message: ThreadMessage;
  readonly conversationId: string;
  readonly arriving: number;
}) {
  const [problem, setProblem] = useState<string | null>(null);

  async function open(attachmentId: string) {
    setProblem(null);
    try {
      await openFetchedLink(
        async () => (await api().inbox.attachmentDownload({ conversationId, attachmentId })).url,
      );
    } catch (failure) {
      setProblem(
        isNotOnPlan(failure)
          ? 'The inbox is not on your company’s plan.'
          : toProblem(failure).message,
      );
    }
  }

  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap gap-2" aria-label="Attachments">
        {message.attachments.map((attachment) => {
          const name = attachment.filename ?? KIND_WORDS[attachment.kind];
          const size = sizeText(attachment.sizeBytes);
          return (
            <li key={attachment.id} data-testid="message-attachment">
              {attachment.status === 'stored' ? (
                <Button size="sm" variant="secondary" onClick={() => void open(attachment.id)}>
                  Open {name}
                  {size ? ` (${size})` : ''}
                </Button>
              ) : (
                <span className="text-xs text-amber-900">
                  A {KIND_WORDS[attachment.kind]} was not kept
                  {attachment.rejectReason ? `: ${attachment.rejectReason}` : ''}.
                </span>
              )}
              {attachment.caption ? (
                <p className="text-xs text-slate-700">{attachment.caption}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {arriving > 0 ? (
        <p className="text-xs text-slate-600">
          {arriving === 1 ? 'One more attachment is' : `${arriving} more attachments are`} being
          copied.
        </p>
      ) : null}
      {problem ? <Alert tone="error">{problem}</Alert> : null}
    </div>
  );
}
