import type { OpeningBalancesApproval } from '@rent/contracts';
import { Table, Td, Th } from '@/components/ui/table';
import { OPENING_TOTAL_COLUMNS } from '@/lib/approvals';
import { formatMinor } from '@/lib/tenancy-format';

/**
 * What a second person approves for an `opening_balances` request (M11 review C2; P25): the money
 * per owner and in total, as the API stored it with the request. The onboarding page shows each
 * lease; this is what they check it against.
 */
export function OpeningBalancesSummary({ batch }: { readonly batch: OpeningBalancesApproval }) {
  return (
    <div data-testid="approval-opening-balances">
      <Table caption="Opening balances per owner">
        <thead>
          <tr>
            <Th>Owner</Th>
            {OPENING_TOTAL_COLUMNS.map((column) => (
              <Th key={column.key} className="text-right">
                {column.label}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {batch.owners.map((row) => (
            <tr key={row.owner.id} data-testid="approval-opening-owner">
              <Th scope="row" className="font-medium">
                {row.owner.name}
              </Th>
              {OPENING_TOTAL_COLUMNS.map((column) => (
                <Td key={column.key} className="text-right tabular-nums">
                  {formatMinor(row[column.key])}
                </Td>
              ))}
            </tr>
          ))}
          <tr data-testid="approval-opening-total">
            <Th scope="row" className="font-semibold">
              Total
            </Th>
            {OPENING_TOTAL_COLUMNS.map((column) => (
              <Td key={column.key} className="text-right font-semibold tabular-nums">
                {formatMinor(batch.totals[column.key])}
              </Td>
            ))}
          </tr>
        </tbody>
      </Table>
    </div>
  );
}
