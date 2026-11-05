'use client';

import type { ConversationSummary } from '@rent/contracts';
import { CHANNEL_LABELS, type InboxView as View } from '@rent/domain/messaging';
import { DEFAULT_INBOX_TAGS } from '@rent/domain/settings';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/components/app-context';
import { ConversationStateBadge, StreamStatusLine } from '@/components/inbox-badges';
import { Empty, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  conversationTitle,
  HANDOVER_REASON_LABELS,
  INBOX_VIEW_LABELS,
  INBOX_VIEW_ORDER,
  plainClick,
  refreshedRows,
  responseDueText,
  type Shown,
} from '@/lib/inbox';
import { useCoalesced, useInboxStream } from '@/lib/inbox-stream';
import { useRequestGate } from '@/lib/request-gate';
import { useInterval } from '@/lib/use-interval';

const PAGE = 30;
const SEARCH_DELAY_MS = 300;

export interface InboxFilters {
  readonly view: View;
  readonly tag: string;
  readonly propertyId: string;
  readonly q: string;
}

type Counts = Partial<Record<View, number>>;
type PropertyOption = { readonly id: string; readonly label: string };

function addressOf(filters: InboxFilters): string {
  const params = new URLSearchParams();
  if (filters.view !== 'all') params.set('view', filters.view);
  if (filters.tag) params.set('tag', filters.tag);
  if (filters.propertyId) params.set('propertyId', filters.propertyId);
  if (filters.q.trim()) params.set('q', filters.q.trim());
  const query = params.toString();
  return query ? `/inbox?${query}` : '/inbox';
}

/** The conversation list: views with counts, tag and property filters, search, live updates. */
export function InboxView({ initial }: { readonly initial: InboxFilters }) {
  const { company, timeZone } = useApp();
  const router = useRouter();
  const [filters, setFilters] = useState<InboxFilters>(initial);
  const [search, setSearch] = useState(initial.q);
  const [items, setItems] = useState<readonly ConversationSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<Counts>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [moreProblem, setMoreProblem] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [properties, setProperties] = useState<readonly PropertyOption[]>([]);
  const [now, setNow] = useState(() => new Date());
  const gate = useRequestGate();
  const tags = company?.settings.inboxTags ?? DEFAULT_INBOX_TAGS;

  const choose = useCallback(
    (next: Partial<InboxFilters>) => {
      const merged = { ...filters, ...next };
      setFilters(merged);
      router.replace(addressOf(merged), { scroll: false });
    },
    [filters, router],
  );

  // Search waits for a pause in typing.
  useEffect(() => {
    if (search === filters.q) return undefined;
    const id = window.setTimeout(() => choose({ q: search }), SEARCH_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [search, filters.q, choose]);

  const load = useCallback(
    async (shown: Shown<ConversationSummary> | null = null) => {
      const current = gate.begin();
      try {
        const [page, viewCounts] = await Promise.all([
          api().inbox.conversations({
            view: filters.view,
            ...(filters.tag ? { tag: filters.tag } : {}),
            ...(filters.propertyId ? { propertyId: filters.propertyId } : {}),
            ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
            // A live refresh fetches as many as are shown, up to the API's 100.
            limit: Math.min(100, Math.max(PAGE, shown?.items.length ?? 0)),
          }),
          api()
            .inbox.counts()
            .catch(() => null),
        ]);
        if (!current()) return;
        // Rows past the first 100, loaded with "Show more", stay with their cursor.
        const next = refreshedRows(shown, page, 100);
        setItems(next.items);
        setNextCursor(next.nextCursor);
        if (viewCounts) setCounts(viewCounts);
        setProblem(null);
        setNow(new Date());
      } catch (failure) {
        if (current()) setProblem(toProblem(failure).message);
      }
    },
    [gate, filters],
  );

  useEffect(() => {
    setItems(null);
    void load();
    return gate.cancel;
  }, [gate, load]);

  const refresh = useCoalesced(() => void load(items ? { items, cursor: nextCursor } : null));
  const handlers = useMemo(() => ({ onEvent: refresh, onResync: refresh }), [refresh]);
  const stream = useInboxStream(true, handlers);
  useInterval(refresh, stream.pollMs);
  // Due times count down between refreshes.
  useInterval(() => setNow(new Date()), 60_000);

  useEffect(() => {
    let current = true;
    api()
      .register.listProperties({})
      .then(
        (result) => {
          if (current)
            setProperties(result.rows.map((p) => ({ id: p.id, label: `${p.code} · ${p.name}` })));
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, []);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreProblem(null);
    try {
      const page = await api().inbox.conversations({
        view: filters.view,
        ...(filters.tag ? { tag: filters.tag } : {}),
        ...(filters.propertyId ? { propertyId: filters.propertyId } : {}),
        ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
        cursor: nextCursor,
        limit: PAGE,
      });
      setItems((current) => {
        const seen = new Set((current ?? []).map((c) => c.id));
        return [...(current ?? []), ...page.items.filter((c) => !seen.has(c.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (failure) {
      setMoreProblem(toProblem(failure).message);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <nav aria-label="Inbox views">
        <ul className="flex flex-wrap gap-2">
          {INBOX_VIEW_ORDER.map((view) => {
            const current = filters.view === view;
            const count = counts[view];
            return (
              <li key={view}>
                <Link
                  href={addressOf({ ...filters, view })}
                  aria-current={current ? 'page' : undefined}
                  data-testid={`inbox-view-${view}`}
                  onClick={(event) => {
                    // A ctrl-, cmd- or middle-click opens the view in a new tab, as links do.
                    if (!plainClick(event)) return;
                    event.preventDefault();
                    choose({ view });
                  }}
                  className={cn(
                    'inline-flex min-h-11 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium',
                    current
                      ? 'bg-brand text-brand-contrast'
                      : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-100',
                  )}
                >
                  {INBOX_VIEW_LABELS[view]}
                  {count !== undefined ? (
                    <span
                      className={cn(
                        'rounded-full px-2 text-xs tabular-nums',
                        current ? 'bg-white/20' : 'bg-slate-100',
                      )}
                      data-testid="view-count"
                    >
                      {count}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <Card>
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label="Search"
              hint="A tenant’s name or a unit code."
              type="search"
              autoComplete="off"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <SelectField
              label="Tag"
              value={filters.tag}
              options={[
                { value: '', label: 'Any tag' },
                ...tags.map((tag) => ({ value: tag, label: tag })),
              ]}
              onChange={(event) => choose({ tag: event.target.value })}
            />
            <SelectField
              label="Property"
              value={filters.propertyId}
              options={[
                { value: '', label: 'Every property' },
                ...properties.map((p) => ({ value: p.id, label: p.label })),
              ]}
              onChange={(event) => choose({ propertyId: event.target.value })}
            />
          </div>
          <StreamStatusLine status={stream.status} />
          {problem ? <Alert tone="error">{problem}</Alert> : null}
          {items === null && !problem ? <Loading what="conversations" /> : null}
          {items?.length === 0 ? <Empty>No conversation in this view.</Empty> : null}
          {items?.length ? (
            <ul className="divide-y divide-slate-100" aria-label="Conversations">
              {items.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  now={now}
                  timeZone={timeZone}
                />
              ))}
            </ul>
          ) : null}
          {moreProblem ? <Alert tone="error">{moreProblem}</Alert> : null}
          {nextCursor ? (
            <Button variant="secondary" pending={loadingMore} onClick={() => void loadMore()}>
              Show more conversations
            </Button>
          ) : null}
        </CardBody>
      </Card>
    </>
  );
}

function ConversationRow({
  conversation,
  now,
  timeZone,
}: {
  readonly conversation: ConversationSummary;
  readonly now: Date;
  readonly timeZone: string;
}) {
  const title = conversationTitle(conversation);
  const due = responseDueText(conversation, now, timeZone);
  return (
    <li data-testid="conversation-row" className="space-y-1 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/inbox/${conversation.id}`}
          className="text-base font-semibold text-slate-900 underline underline-offset-2"
        >
          {title}
        </Link>
        <ConversationStateBadge state={conversation.state} />
        {conversation.overdue ? <Badge tone="red">Overdue</Badge> : null}
        {conversation.unansweredCount > 0 ? (
          <Badge tone="amber">{conversation.unansweredCount} unanswered</Badge>
        ) : null}
        {conversation.handoverReason ? (
          <Badge tone="blue">{HANDOVER_REASON_LABELS[conversation.handoverReason]}</Badge>
        ) : null}
        {conversation.tags.map((tag) => (
          <Badge key={tag}>{tag}</Badge>
        ))}
      </div>
      {conversation.units.length ? (
        <p className="font-mono text-xs text-slate-600">
          {conversation.units.map((u) => u.unitCode).join(', ')}
        </p>
      ) : null}
      {conversation.lastMessagePreview ? (
        <p className="break-words text-slate-700" data-testid="conversation-preview">
          {conversation.lastMessagePreview}
        </p>
      ) : null}
      <p className="text-slate-600">
        {conversation.lastMessageAt ? (
          <>
            <time dateTime={conversation.lastMessageAt}>
              {formatTime(conversation.lastMessageAt, timeZone)}
            </time>
            {conversation.lastInboundChannel
              ? ` · last wrote on ${CHANNEL_LABELS[conversation.lastInboundChannel]}`
              : null}
          </>
        ) : (
          'No messages yet'
        )}
        {' · '}
        {conversation.assignee ? `Assigned to ${conversation.assignee.name}` : 'Unassigned'}
      </p>
      {due ? (
        <p className={conversation.overdue ? 'font-medium text-red-800' : 'text-slate-600'}>
          {due}
        </p>
      ) : null}
    </li>
  );
}
