'use client';

import type { ThreadMessage, UnitConversation } from '@rent/contracts';
import { LEASE_STATUS_LABELS, type LeaseStatus } from '@rent/domain/tenancy';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/components/app-context';
import { ChannelBadge, MessageStatusBadge } from '@/components/inbox-badges';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import { cn } from '@/lib/cn';
import { toProblem } from '@/lib/errors';
import { formatTime, humanise } from '@/lib/format';
import { authorLabel, mergeMessages } from '@/lib/inbox';

const leaseStatusText = (status: string): string =>
  status in LEASE_STATUS_LABELS ? LEASE_STATUS_LABELS[status as LeaseStatus] : humanise(status);

const termText = (row: UnitConversation): string =>
  `${formatBusinessDate(row.startDate)} to ${row.endDate ? formatBusinessDate(row.endDate) : 'no end date'}`;

/**
 * Every conversation with the unit's tenants since each lease began, across channels (CM-05
 * acceptance; M6 plan 4.11). Each lease's messages open here, and in the inbox.
 */
export function UnitConversations({ unitId }: { readonly unitId: string }) {
  const [rows, setRows] = useState<readonly UnitConversation[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api().inbox.unitConversations({ unitId }));
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, [unitId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card data-testid="unit-conversations">
      <CardHeader
        title="Conversations"
        description="Every message with this unit’s tenants since each lease began, on every channel."
      />
      <CardBody>
        {problem ? <LoadFailed message={problem} onRetry={() => void load()} /> : null}
        {rows === null && !problem ? <Loading what="conversations" /> : null}
        {rows?.length === 0 ? (
          <Empty>No lease on this unit has a tenant to talk to yet.</Empty>
        ) : null}
        {rows?.length ? (
          <ul className="divide-y divide-slate-100" aria-label="Conversations for this unit">
            {rows.map((row) => (
              <LeaseConversation key={`${row.leaseId}-${row.tenant.id}`} row={row} />
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}

function LeaseConversation({ row }: { readonly row: UnitConversation }) {
  const { timeZone } = useApp();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<readonly ThreadMessage[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const page = useCallback(
    async (from: string | null) => {
      if (!row.conversationId) return;
      const result = await api().inbox.messages({
        conversationId: row.conversationId,
        since: row.since,
        limit: 100,
        ...(from ? { cursor: from } : {}),
      });
      setMessages((current) => mergeMessages(current ?? [], result.items));
      setCursor(result.nextCursor);
    },
    [row.conversationId, row.since],
  );

  async function first() {
    setProblem(null);
    try {
      await page(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && messages === null) await first();
  }

  async function more() {
    setLoadingMore(true);
    try {
      await page(cursor);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <li data-testid="unit-conversation" className="space-y-2 py-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-2">
            <Link
              href={`/tenants/${row.tenant.id}`}
              className="text-base font-semibold text-slate-900 underline underline-offset-2"
            >
              {row.tenant.name}
            </Link>
            <span className="text-slate-600">{leaseStatusText(row.leaseStatus)}</span>
          </p>
          <p className="text-slate-700">Lease {termText(row)}</p>
          <p className="text-slate-600" data-testid="unit-conversation-count">
            {row.messageCount === 1 ? '1 message' : `${row.messageCount} messages`} since{' '}
            {formatBusinessDate(row.since)}
            {row.lastMessageAt ? (
              <>
                {' '}
                · last{' '}
                <time dateTime={row.lastMessageAt}>{formatTime(row.lastMessageAt, timeZone)}</time>
              </>
            ) : null}
          </p>
        </div>
        {row.conversationId ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              aria-expanded={open}
              aria-label={`${open ? 'Hide' : 'Show'} messages with ${row.tenant.name}`}
              onClick={() => void toggle()}
            >
              {open ? 'Hide messages' : 'Show messages'}
            </Button>
            <Link
              href={`/inbox/${row.conversationId}?since=${row.since}`}
              className="inline-flex min-h-9 items-center text-sm font-medium underline underline-offset-2"
            >
              Open in the inbox
            </Link>
          </div>
        ) : (
          <p className="text-slate-600">No messages yet.</p>
        )}
      </div>
      {open ? (
        <div className="space-y-2">
          {/* Trying again keeps the panel open (review W11). */}
          {problem ? <LoadFailed message={problem} onRetry={() => void first()} /> : null}
          {messages === null && !problem ? <Loading what="messages" /> : null}
          {messages?.length === 0 ? <Empty>No messages since the lease began.</Empty> : null}
          {cursor ? (
            <Button size="sm" variant="ghost" pending={loadingMore} onClick={() => void more()}>
              Show earlier messages
            </Button>
          ) : null}
          {messages?.length ? (
            <ol className="space-y-2" aria-label={`Messages with ${row.tenant.name}`}>
              {messages.map((message) => (
                <li
                  key={message.id}
                  data-testid="unit-message"
                  className={cn(
                    'space-y-1 rounded-md border p-2',
                    message.direction === 'inbound'
                      ? 'mr-6 border-slate-200 bg-slate-50'
                      : 'ml-6 border-sky-200 bg-sky-50',
                  )}
                >
                  <p className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
                    <span className="font-medium text-slate-900">{authorLabel(message)}</span>
                    <ChannelBadge channel={message.channel} />
                    <time dateTime={message.createdAt}>
                      {formatTime(message.createdAt, timeZone)}
                    </time>
                    <MessageStatusBadge status={message.status} />
                  </p>
                  <p className="break-words whitespace-pre-wrap text-slate-900">{message.body}</p>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
