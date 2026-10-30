'use client';

import type { LeaseTerms } from '@rent/domain/tenancy';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table, Td, Th } from '@/components/ui/table';
import { formatBusinessDate } from '@/lib/business-dates';
import { projectedSchedule } from '@/lib/lease-form';
import { formatMinor } from '@/lib/tenancy-format';

const FIRST_ROWS = 6;

/**
 * The monthly periods these terms make (TL-06), worked out by the same domain rules the API uses.
 * Nothing is recorded until the lease is signed; invoices group the periods by the billing cycle.
 */
export function ProjectedSchedule({ terms }: { readonly terms: LeaseTerms | null }) {
  const [all, setAll] = useState(false);
  const rows = projectedSchedule(terms);
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);
  return (
    <details className="rounded-md border border-slate-200 p-3" data-testid="projected-schedule">
      <summary className="cursor-pointer text-sm font-medium text-slate-800">
        The rent schedule these terms make ({terms!.periodCount}{' '}
        {terms!.periodCount === 1 ? 'period' : 'periods'})
      </summary>
      <div className="mt-3 space-y-2">
        <Table caption="Projected rent schedule">
          <thead>
            <tr>
              <Th>Period</Th>
              <Th>Charge</Th>
              <Th className="text-right">Amount</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((row) => (
              <tr key={`${row.sequence}-${row.chargeType}`}>
                <Td className="whitespace-nowrap">
                  {formatBusinessDate(row.periodStart)} to {formatBusinessDate(row.periodEnd)}
                </Td>
                <Td>
                  {row.chargeType === 'rent' ? 'Rent' : 'Service charge'}
                  {row.prorated ? ' (part month, by the day)' : ''}
                </Td>
                <Td className="text-right tabular-nums">{formatMinor(row.amountMinor)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {rows.length > FIRST_ROWS ? (
          <Button size="sm" variant="ghost" onClick={() => setAll((a) => !a)}>
            {all ? 'Show fewer' : `Show all ${rows.length} rows`}
          </Button>
        ) : null}
      </div>
    </details>
  );
}
