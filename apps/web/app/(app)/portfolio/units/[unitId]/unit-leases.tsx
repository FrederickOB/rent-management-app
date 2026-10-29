'use client';

import type { UnitDetailView } from '@rent/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { secondaryLink } from '@/components/link-styles';
import { LeaseStatusBadge, PaperBadge } from '@/components/tenancy-badges';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { termLabel } from '@/lib/tenancy-format';

type Row = Awaited<ReturnType<ReturnType<typeof api>['leases']['list']>>[number];

const OCCUPANCY_NOTES: Record<UnitDetailView['occupancy'], string> = {
  occupied: 'Occupied: a lease is active, ending or holding over.',
  reserved: 'Reserved: a signed lease starts soon.',
  vacant: 'No lease holds this unit.',
};

/**
 * The unit's leases (PB-09): occupancy comes from them, never from a setting. A unit with no lease
 * holding it can get a new draft or a lease already signed on paper.
 */
export function UnitLeases({
  unit,
  canDraft,
}: {
  readonly unit: UnitDetailView;
  readonly canDraft: boolean;
}) {
  const [rows, setRows] = useState<readonly Row[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api()
      .leases.list({ unitId: unit.id })
      .then(
        (list) => {
          if (current) setRows(list);
        },
        (failure: unknown) => {
          if (current) setProblem(toProblem(failure).message);
        },
      );
    return () => {
      current = false;
    };
  }, [unit.id]);

  return (
    <Card data-testid="unit-leases">
      <CardHeader
        title="Leases"
        description={OCCUPANCY_NOTES[unit.occupancy]}
        actions={
          canDraft && unit.occupancy === 'vacant' ? (
            <div className="flex flex-wrap gap-2">
              <Link href={`/leases/new?unitId=${unit.id}`} className={secondaryLink}>
                Start a lease
              </Link>
              <Link href={`/leases/paper?unitId=${unit.id}`} className={secondaryLink}>
                Record a paper lease
              </Link>
            </div>
          ) : null
        }
      />
      <CardBody>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {rows === null && !problem ? (
          <p role="status" className="text-sm text-slate-600">
            Loading…
          </p>
        ) : null}
        {rows?.length === 0 ? <p className="text-sm text-slate-600">No leases yet.</p> : null}
        {rows?.length ? (
          <ul className="divide-y divide-slate-100 text-sm" aria-label="Leases on this unit">
            {rows.map((row) => (
              <li
                key={row.id}
                data-testid="unit-lease"
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <Link
                  href={`/leases/${row.id}`}
                  className="font-medium underline underline-offset-2"
                >
                  {row.access === 'full' ? `${row.tenant.displayName}: ` : ''}
                  {termLabel(row.startDate, row.endDate)}
                </Link>
                <span className="flex flex-wrap gap-1">
                  <LeaseStatusBadge status={row.status} />
                  {row.access === 'full' && row.signedOnPaper ? <PaperBadge /> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}
