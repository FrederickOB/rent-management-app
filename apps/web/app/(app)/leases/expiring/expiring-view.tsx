'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LeaseStatusBadge } from '@/components/tenancy-badges';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatBusinessDate } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import { daysLeftLabel } from '@/lib/tenancy-format';

type Row = Awaited<ReturnType<ReturnType<typeof api>['leases']['expiring']>>[number];

/** The expiring-leases list (TL-09; plan 4.10). "Offer renewal" makes a draft for the new term. */
export function ExpiringView({
  initialDays,
  windows,
  canRenew,
}: {
  readonly initialDays: number;
  readonly windows: readonly number[];
  readonly canRenew: boolean;
}) {
  const router = useRouter();
  const [days, setDays] = useState(initialDays);
  const [rows, setRows] = useState<readonly Row[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api().leases.expiring({ days }));
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  async function renew(row: Row) {
    setBusy(row.id);
    setProblem(null);
    try {
      const renewal = await api().leases.renewal({ leaseId: row.id });
      router.push(`/leases/${renewal.id}?saved=renewal`);
    } catch (failure) {
      setProblem(toProblem(failure).message);
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardBody>
        <SelectField
          label="Ending within"
          value={String(days)}
          options={windows.map((w) => ({ value: String(w), label: `${w} days` }))}
          onChange={(event) => {
            const next = Number(event.target.value);
            setDays(next);
            router.replace(`/leases/expiring?days=${next}`, { scroll: false });
          }}
          className="max-w-xs"
        />
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {rows === null ? (
          <p role="status" className="text-sm text-slate-600">
            Loading…
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-600">No lease ends within {days} days.</p>
        ) : (
          <Table caption="Leases ending soon">
            <thead>
              <tr>
                <Th>Unit</Th>
                <Th>Tenant</Th>
                <Th>Ends</Th>
                <Th>Renewal</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.id} data-testid="expiring-row">
                  <Td>
                    <Link
                      href={`/leases/${row.id}`}
                      className="font-mono font-medium underline underline-offset-2"
                    >
                      {row.unitCode}
                    </Link>
                    <p className="text-xs text-slate-600">{row.propertyName}</p>
                  </Td>
                  <Td>{row.tenantName || '—'}</Td>
                  <Td className="whitespace-nowrap">
                    {formatBusinessDate(row.endDate)}{' '}
                    <span className="text-slate-600" data-testid="days-left">
                      ({daysLeftLabel(row.daysLeft)})
                    </span>
                    {row.status === 'ending' ? (
                      <span className="ml-1">
                        <LeaseStatusBadge status={row.status} />
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    {row.renewal ? (
                      <Link
                        href={`/leases/${row.renewal.id}`}
                        className="inline-flex items-center gap-2 underline underline-offset-2"
                      >
                        Renewal <LeaseStatusBadge status={row.renewal.status} />
                      </Link>
                    ) : canRenew && row.status === 'active' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        pending={busy === row.id}
                        aria-label={`Offer a renewal for ${row.unitCode}`}
                        onClick={() => void renew(row)}
                      >
                        Offer a renewal
                      </Button>
                    ) : (
                      <span className="text-slate-600">None</span>
                    )}
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
