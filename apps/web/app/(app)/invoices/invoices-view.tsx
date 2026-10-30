'use client';

import type { InvoiceRow } from '@rent/contracts';
import { INVOICE_STATUSES, type InvoiceStatus } from '@rent/domain/billing';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { InvoiceStatusBadge } from '@/components/billing-badges';
import { Empty, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { CheckboxField, SelectField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { INVOICE_KIND_LABELS, invoiceStatusLabel, periodLabel } from '@/lib/billing-format';
import { formatBusinessDate } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { useRequestGate } from '@/lib/request-gate';
import { formatMinor } from '@/lib/tenancy-format';

const LIMIT = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface InvoiceFilters {
  /** Set from a link (a lease or a tenant); shown as a filter that can be cleared. */
  readonly leaseId: string | null;
  readonly tenantId: string | null;
  readonly propertyId: string;
  readonly ownerId: string;
  readonly status: string;
  readonly overdue: boolean;
  readonly dueFrom: string;
  readonly dueTo: string;
}

interface Option {
  readonly value: string;
  readonly label: string;
}

const statusOf = (value: string): InvoiceStatus | undefined =>
  INVOICE_STATUSES.find((s) => s === value);

/** The invoice list (plan 4.19): status, property, owner and whether it is overdue. */
export function InvoicesView({
  initial,
  filterOwners,
}: {
  readonly initial: InvoiceFilters;
  readonly filterOwners: boolean;
}) {
  const [filters, setFilters] = useState(initial);
  const [rows, setRows] = useState<readonly InvoiceRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [properties, setProperties] = useState<readonly Option[]>([]);
  const [owners, setOwners] = useState<readonly Option[]>([]);
  const gate = useRequestGate();

  // The choices for the property and owner filters, as this person may see them (AD-02).
  useEffect(() => {
    let current = true;
    void api()
      .register.listProperties({})
      .then(
        (list) => {
          if (current)
            setProperties(list.rows.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` })));
        },
        () => undefined,
      );
    if (filterOwners)
      void api()
        .owners.list({})
        .then(
          (list) => {
            if (current)
              setOwners(
                list.map((o) => ({ value: o.id, label: `${o.displayName} (${o.reference})` })),
              );
          },
          () => undefined,
        );
    return () => {
      current = false;
    };
  }, [filterOwners]);

  const load = useCallback(async () => {
    const current = gate.begin();
    try {
      const status = statusOf(filters.status);
      const list = await api().invoices.list({
        ...(filters.leaseId ? { leaseId: filters.leaseId } : {}),
        ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
        ...(filters.propertyId ? { propertyId: filters.propertyId } : {}),
        ...(filters.ownerId ? { ownerId: filters.ownerId } : {}),
        ...(status ? { status } : {}),
        ...(filters.overdue ? { overdue: 'true' } : {}),
        ...(ISO_DATE.test(filters.dueFrom) ? { dueFrom: filters.dueFrom } : {}),
        ...(ISO_DATE.test(filters.dueTo) ? { dueTo: filters.dueTo } : {}),
        limit: LIMIT,
      });
      if (!current()) return;
      setRows(list);
      setProblem(null);
    } catch (failure) {
      if (current()) setProblem(toProblem(failure).message);
    }
  }, [gate, filters]);

  useEffect(() => {
    void load();
    return gate.cancel;
  }, [gate, load]);

  const set = (patch: Partial<InvoiceFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const narrowed = filters.leaseId ? 'one lease' : filters.tenantId ? 'one tenant' : null;

  return (
    <Card>
      <CardBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField
            label="Status"
            value={filters.status}
            options={[
              { value: '', label: 'Any' },
              ...INVOICE_STATUSES.map((s) => ({ value: s, label: invoiceStatusLabel(s) })),
            ]}
            onChange={(event) => set({ status: event.target.value })}
          />
          <SelectField
            label="Property"
            value={filters.propertyId}
            options={[{ value: '', label: 'Every property' }, ...properties]}
            onChange={(event) => set({ propertyId: event.target.value })}
          />
          {filterOwners ? (
            <SelectField
              label="Owner"
              value={filters.ownerId}
              options={[{ value: '', label: 'Every owner' }, ...owners]}
              onChange={(event) => set({ ownerId: event.target.value })}
            />
          ) : null}
          <TextField
            label="Due from"
            type="date"
            value={filters.dueFrom}
            onChange={(event) => set({ dueFrom: event.target.value })}
          />
          <TextField
            label="Due to"
            type="date"
            value={filters.dueTo}
            onChange={(event) => set({ dueTo: event.target.value })}
          />
          <CheckboxField
            label="Overdue only"
            hint="Past the due date with something still to pay."
            checked={filters.overdue}
            onChange={(event) => set({ overdue: event.target.checked })}
            className="self-end"
          />
        </div>
        {narrowed ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="blue">Showing {narrowed}</Badge>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => set({ leaseId: null, tenantId: null })}
            >
              Show every invoice
            </Button>
          </div>
        ) : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {rows === null && !problem ? <Loading what="invoices" /> : null}
        {rows?.length === 0 ? <Empty>No invoice matches.</Empty> : null}
        {rows?.length ? (
          <>
            <Table caption="Invoices">
              <thead>
                <tr>
                  <Th>Invoice</Th>
                  <Th>Tenant and unit</Th>
                  <Th>Owner</Th>
                  <Th>For</Th>
                  <Th>Due</Th>
                  <Th className="text-right">Total</Th>
                  <Th className="text-right">Still to pay</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} data-testid="invoice-row">
                    <Td>
                      <Link
                        href={`/invoices/${row.id}`}
                        className="font-mono font-medium underline underline-offset-2"
                      >
                        {row.number}
                      </Link>
                    </Td>
                    <Td>
                      {row.tenantName}
                      <p className="text-xs text-slate-600">
                        <span className="font-mono">{row.unitCode}</span> · {row.propertyName}
                      </p>
                    </Td>
                    <Td>{row.ownerName}</Td>
                    <Td>
                      {INVOICE_KIND_LABELS[row.kind]}
                      {row.hasVat ? ' with VAT' : ''}
                      {periodLabel(row.periodFrom, row.periodTo) ? (
                        <p className="text-xs whitespace-nowrap text-slate-600">
                          {periodLabel(row.periodFrom, row.periodTo)}
                        </p>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap">{formatBusinessDate(row.dueDate)}</Td>
                    <Td className="text-right tabular-nums">{formatMinor(row.totalMinor)}</Td>
                    <Td className="text-right tabular-nums">{formatMinor(row.outstandingMinor)}</Td>
                    <Td>
                      <InvoiceStatusBadge status={row.status} overdue={row.overdue} />
                      {row.unverifiedRules ? (
                        <p className="mt-1 text-xs text-amber-900">Unverified VAT rates</p>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {rows.length >= LIMIT ? (
              <p className="text-sm text-slate-600">
                Showing the first {LIMIT}. Narrow the filters to find others.
              </p>
            ) : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
