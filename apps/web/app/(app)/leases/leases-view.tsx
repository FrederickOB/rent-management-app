'use client';

import { LEASE_STATUSES, type LeaseStatus } from '@rent/domain/tenancy';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { LeaseStatusBadge, PaperBadge } from '@/components/tenancy-badges';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { useRequestGate } from '@/lib/request-gate';
import { leaseStatusLabel, rentLabel, termLabel } from '@/lib/tenancy-format';

const SEARCH_DELAY_MS = 300;

type Row = Awaited<ReturnType<ReturnType<typeof api>['leases']['list']>>[number];

/** The lease list (plan 4.16), filtered by status and searched by unit code or tenant. */
export function LeasesView({ detailed }: { readonly detailed: boolean }) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<LeaseStatus | ''>('');
  const [rows, setRows] = useState<readonly Row[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A reply for an older search or status never replaces the newer one.
  const gate = useRequestGate();

  useEffect(() => {
    const id = window.setTimeout(() => setQuery(search), SEARCH_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [search]);

  const load = useCallback(async () => {
    const current = gate.begin();
    try {
      const list = await api().leases.list({
        search: query.trim() || undefined,
        ...(status ? { status } : {}),
      });
      if (!current()) return;
      setRows(list);
      setProblem(null);
    } catch (failure) {
      if (current()) setProblem(toProblem(failure).message);
    }
  }, [gate, query, status]);

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);

  return (
    <Card>
      <CardBody>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Search"
            hint={detailed ? 'A unit code or a tenant’s name.' : 'A unit code.'}
            type="search"
            autoComplete="off"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <SelectField
            label="Status"
            value={status}
            options={[
              { value: '', label: 'Any' },
              ...LEASE_STATUSES.map((s) => ({ value: s, label: leaseStatusLabel(s) })),
            ]}
            onChange={(event) =>
              setStatus(LEASE_STATUSES.find((s) => s === event.target.value) ?? '')
            }
          />
        </div>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {rows === null ? (
          <p role="status" className="text-sm text-slate-600">
            Loading leases…
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-600">No lease matches.</p>
        ) : (
          <Table caption="Leases">
            <thead>
              <tr>
                <Th>Unit</Th>
                {detailed ? <Th>Tenant</Th> : null}
                <Th>Term</Th>
                {detailed ? <Th>Rent</Th> : null}
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.id} data-testid="lease-row">
                  <Td>
                    <Link
                      href={`/leases/${row.id}`}
                      className="font-mono font-medium underline underline-offset-2"
                    >
                      {row.unit.code}
                    </Link>
                    {row.access === 'full' ? (
                      <p className="text-xs text-slate-600">{row.propertyName}</p>
                    ) : null}
                  </Td>
                  {row.access === 'full' ? <Td>{row.tenant.displayName}</Td> : null}
                  <Td className="whitespace-nowrap">{termLabel(row.startDate, row.endDate)}</Td>
                  {row.access === 'full' ? (
                    <Td>{rentLabel(row.monthlyRentMinor, row.cycle)}</Td>
                  ) : null}
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      <LeaseStatusBadge status={row.status} />
                      {row.access === 'full' && row.signedOnPaper ? <PaperBadge /> : null}
                      {row.access === 'full' && row.advanceFlagged ? (
                        <Badge tone="amber">Advance over the limit</Badge>
                      ) : null}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}
