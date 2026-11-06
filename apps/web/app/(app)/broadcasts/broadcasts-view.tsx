'use client';

import type { Broadcast } from '@rent/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { BROADCAST_STATUS_LABELS } from '@/lib/broadcasts';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { useRequestGate } from '@/lib/request-gate';
import { refreshedRows, type Shown } from '@/lib/inbox';
import { useVisibleInterval } from '@/lib/use-visible-interval';

const PAGE = 30;

/** The broadcast list, with a property filter; sending ones refresh until they finish. */
export function BroadcastsView() {
  const { timeZone } = useApp();
  const [propertyId, setPropertyId] = useState('');
  const [properties, setProperties] = useState<readonly { id: string; label: string }[]>([]);
  const [rows, setRows] = useState<readonly Broadcast[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const gate = useRequestGate();

  const load = useCallback(
    async (shown: Shown<Broadcast> | null = null) => {
      const current = gate.begin();
      try {
        const page = await api().broadcasts.list({
          ...(propertyId ? { propertyId } : {}),
          // A refresh while sending fetches as many as are shown, up to the API's 100.
          limit: Math.min(100, Math.max(PAGE, shown?.items.length ?? 0)),
        });
        if (!current()) return;
        // Pages loaded with "Show more" stay (review note).
        const next = refreshedRows(shown, page, 100);
        setRows(next.items);
        setCursor(next.nextCursor);
        setProblem(null);
      } catch (failure) {
        if (current()) setProblem(toProblem(failure).message);
      }
    },
    [gate, propertyId],
  );

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);
  const sending = rows?.some((r) => r.status === 'sending') ?? false;
  useVisibleInterval(
    () => void load(rows ? { items: rows, cursor } : null),
    sending ? 5_000 : null,
  );

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

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api().broadcasts.list({
        ...(propertyId ? { propertyId } : {}),
        cursor,
        limit: PAGE,
      });
      setRows((current) => [...(current ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Card>
      <CardBody>
        <SelectField
          label="Property"
          className="max-w-md"
          value={propertyId}
          options={[
            { value: '', label: 'Every property' },
            ...properties.map((p) => ({ value: p.id, label: p.label })),
          ]}
          onChange={(event) => setPropertyId(event.target.value)}
        />
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {rows === null && !problem ? <Loading what="broadcasts" /> : null}
        {rows?.length === 0 ? <Empty>No broadcast has been sent yet.</Empty> : null}
        {rows?.length ? (
          <Table caption="Broadcasts">
            <thead>
              <tr>
                <Th>Topic</Th>
                <Th>To</Th>
                <Th>Sent</Th>
                <Th className="text-right">Tenants</Th>
                <Th className="text-right">Delivered</Th>
                <Th className="text-right">Failed or not sent</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.id} data-testid="broadcast-row">
                  <Td>
                    <Link
                      href={`/broadcasts/${row.id}`}
                      className="font-medium underline underline-offset-2"
                    >
                      {row.topic}
                    </Link>
                    <p className="text-xs text-slate-600">
                      <Badge tone={row.status === 'sending' ? 'blue' : 'green'}>
                        {BROADCAST_STATUS_LABELS[row.status]}
                      </Badge>
                    </p>
                  </Td>
                  <Td>{row.audienceLabel}</Td>
                  <Td>
                    <time dateTime={row.confirmedAt}>{formatTime(row.confirmedAt, timeZone)}</time>
                    <p className="text-xs text-slate-600">by {row.createdBy.name}</p>
                  </Td>
                  <Td className="text-right tabular-nums">{row.audienceCount}</Td>
                  <Td className="text-right tabular-nums">
                    {row.stats.delivered + row.stats.read}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {row.stats.failed + row.stats.notSent}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
        {cursor ? (
          <Button variant="secondary" pending={loadingMore} onClick={() => void more()}>
            Show more broadcasts
          </Button>
        ) : null}
      </CardBody>
    </Card>
  );
}
