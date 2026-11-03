import Link from 'next/link';
import { aheadLabel, overBy, ruleLabel, type AdvanceReportRow } from '@/lib/advance-compliance';
import { formatBusinessDate } from '@/lib/business-dates';
import { Table, Td, Th } from './ui/table';

/**
 * The advance rent report's rows (AR-05; plan 5.5): each lease paid further ahead than the limit
 * for its term, the months paid ahead, the limit, and the rule version it was judged by with its
 * verification status. It says only that a limit is exceeded; it never calls an advance compliant.
 */
export function AdvanceReportTable({
  rows,
  linkPayments,
}: {
  readonly rows: readonly AdvanceReportRow[];
  readonly linkPayments: boolean;
}) {
  return (
    <Table caption="Leases paid further ahead than the advance rent limit">
      <thead>
        <tr>
          <Th>Lease</Th>
          <Th>Property</Th>
          <Th>Paid ahead</Th>
          <Th>Rule</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row) => (
          <tr key={`${row.leaseId}-${row.paymentId}`} data-testid="advance-row">
            <Td>
              <Link
                href={`/leases/${row.leaseId}`}
                className="font-mono font-medium underline underline-offset-2"
              >
                {row.unitCode}
              </Link>
              <p className="text-xs text-slate-600">{row.tenantName}</p>
            </Td>
            <Td>{row.propertyName}</Td>
            <Td className="min-w-56 space-y-1">
              <p data-testid="advance-ahead">{aheadLabel(row)}</p>
              {overBy(row) ? <p className="font-medium text-amber-900">{overBy(row)}</p> : null}
              {row.policy === 'block' ? (
                <p className="text-xs text-slate-700">
                  It arrived from a payment provider while the check refuses such advances, so it
                  was recorded for a person to look at.
                </p>
              ) : null}
              {row.receivedOn ? (
                <p className="text-xs text-slate-600">
                  {linkPayments ? (
                    <Link
                      href={`/payments/${row.paymentId}`}
                      className="underline underline-offset-2"
                    >
                      Payment of {formatBusinessDate(row.receivedOn)}
                    </Link>
                  ) : (
                    `Payment of ${formatBusinessDate(row.receivedOn)}`
                  )}
                </p>
              ) : null}
            </Td>
            <Td className="min-w-56 text-xs text-slate-700" data-testid="advance-rule">
              {ruleLabel(row.rule)}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
