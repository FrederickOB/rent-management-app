'use client';

import type { MaintenanceJob } from '@rent/contracts';
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
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { REPAIR_SOURCE_LABELS, REPAIR_STATUS_LABELS } from '@/lib/repairs';
import { useRequestGate } from '@/lib/request-gate';
import { messageExcerpt } from '@/lib/timeline';

const PAGE = 30;

export function RepairsView() {
  const { timeZone } = useApp();
  const [propertyId, setPropertyId] = useState('');
  const [properties, setProperties] = useState<readonly { id: string; label: string }[]>([]);
  const [rows, setRows] = useState<readonly MaintenanceJob[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const gate = useRequestGate();

  const load = useCallback(async () => {
    const current = gate.begin();
    try {
      const page = await api().maintenance.list({
        ...(propertyId ? { propertyId } : {}),
        limit: PAGE,
      });
      if (!current()) return;
      setRows(page.items);
      setCursor(page.nextCursor);
      setProblem(null);
    } catch (failure) {
      if (current()) setProblem(toProblem(failure).message);
    }
  }, [gate, propertyId]);

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);

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
      const page = await api().maintenance.list({
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
        {rows === null && !problem ? <Loading what="repairs" /> : null}
        {rows?.length === 0 ? <Empty>No repair has been reported yet.</Empty> : null}
        {rows?.length ? (
          <Table caption="Reported repairs">
            <thead>
              <tr>
                <Th>Ticket</Th>
                <Th>Reported</Th>
                <Th>Tenant and unit</Th>
                <Th>What they said</Th>
                <Th className="text-right">Media</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((job) => (
                <tr key={job.id} data-testid="repair-row">
                  <Td>
                    <Link
                      href={`/repairs/${job.id}`}
                      className="font-mono font-medium underline underline-offset-2"
                    >
                      {job.ticket}
                    </Link>
                    <p>
                      <Badge tone="amber">{REPAIR_STATUS_LABELS[job.status]}</Badge>
                    </p>
                  </Td>
                  <Td className="whitespace-nowrap">
                    <time dateTime={job.createdAt}>{formatTime(job.createdAt, timeZone)}</time>
                    <p className="text-xs text-slate-600">{REPAIR_SOURCE_LABELS[job.source]}</p>
                  </Td>
                  <Td>
                    {job.tenant?.name ?? 'Unknown tenant'}
                    <p className="font-mono text-xs text-slate-600">
                      {job.unit?.code ?? job.property.name}
                    </p>
                  </Td>
                  <Td className="max-w-md break-words">{messageExcerpt(job.description, 160)}</Td>
                  <Td className="text-right tabular-nums">{job.attachmentCount}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
        {cursor ? (
          <Button variant="secondary" pending={loadingMore} onClick={() => void more()}>
            Show more repairs
          </Button>
        ) : null}
      </CardBody>
    </Card>
  );
}
