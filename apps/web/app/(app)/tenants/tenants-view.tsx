'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { IdStatusBadge } from '@/components/tenancy-badges';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody } from '@/components/ui/card';
import { CheckboxField, SelectField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { useRequestGate } from '@/lib/request-gate';
import { ID_STATUS_LABELS, TENANT_KIND_LABELS, type IdStatus } from '@/lib/tenancy-format';
import { consentSummary } from '@/lib/tenant-form';

const SEARCH_DELAY_MS = 300;
const ID_STATUSES = Object.keys(ID_STATUS_LABELS) as IdStatus[];

type Row = Awaited<ReturnType<ReturnType<typeof api>['tenants']['list']>>[number];

/**
 * The tenant list (TL-01; plan 4.16): search by name, phone or unit code, and filter by an active
 * lease and the ID check. A caretaker sees only names, phones and units (tenant.view_details).
 */
export function TenantsView({
  initialSearch,
  details,
}: {
  readonly initialSearch: string;
  /** tenant.view_details: the ID check and consent columns, and the ID filter. */
  readonly details: boolean;
}) {
  const [search, setSearch] = useState(initialSearch);
  const [query, setQuery] = useState(initialSearch);
  const [activeOnly, setActiveOnly] = useState(false);
  const [idStatus, setIdStatus] = useState<IdStatus | ''>('');
  const [rows, setRows] = useState<readonly Row[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A reply for an older search or filter never replaces the newer one.
  const gate = useRequestGate();

  useEffect(() => {
    const id = window.setTimeout(() => setQuery(search), SEARCH_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [search]);

  const load = useCallback(async () => {
    const current = gate.begin();
    try {
      // M11 decision 6: by POST, so a phone number or a name never sits in a URL.
      const list = await api().tenants.search({
        search: query.trim() || undefined,
        ...(activeOnly ? { withActiveLease: true } : {}),
        ...(idStatus && details ? { idStatus } : {}),
      });
      if (!current()) return;
      setRows(list);
      setProblem(null);
    } catch (failure) {
      if (current()) setProblem(toProblem(failure).message);
    }
  }, [gate, query, activeOnly, idStatus, details]);

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);

  return (
    <Card>
      <CardBody>
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            label="Search"
            hint="A name, a phone number or a unit code."
            type="search"
            autoComplete="off"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {details ? (
            <SelectField
              label="ID check"
              value={idStatus}
              options={[
                { value: '', label: 'Any' },
                ...ID_STATUSES.map((s) => ({ value: s, label: ID_STATUS_LABELS[s] })),
              ]}
              onChange={(event) =>
                setIdStatus(ID_STATUSES.find((s) => s === event.target.value) ?? '')
              }
            />
          ) : null}
          <CheckboxField
            className="self-center"
            label="Only tenants with an active lease"
            checked={activeOnly}
            onChange={(event) => setActiveOnly(event.target.checked)}
          />
        </div>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {rows === null ? (
          <p role="status" className="text-sm text-slate-600">
            Loading tenants…
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-600">No tenant matches.</p>
        ) : (
          <Table caption="Tenants">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Phone</Th>
                <Th>Units</Th>
                {details ? (
                  <>
                    <Th>ID check</Th>
                    <Th>Messages by</Th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.id} data-testid="tenant-row">
                  <Td>
                    <Link
                      href={`/tenants/${row.id}`}
                      className="font-medium underline underline-offset-2"
                    >
                      {row.displayName}
                    </Link>{' '}
                    {row.kind === 'company' ? <Badge>{TENANT_KIND_LABELS.company}</Badge> : null}
                    {row.access === 'full' && row.archived ? (
                      <Badge tone="dark">Archived</Badge>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap">{row.phone ?? '—'}</Td>
                  <Td className="font-mono text-xs">{row.units.join(', ') || '—'}</Td>
                  {details && row.access === 'full' ? (
                    <>
                      <Td>
                        <IdStatusBadge status={row.identity.status} />
                      </Td>
                      <Td>{consentSummary(row.consent)}</Td>
                    </>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}
