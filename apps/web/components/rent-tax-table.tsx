import Link from 'next/link';
import { rateLabel } from '@/lib/billing-format';
import { formatBusinessDate } from '@/lib/business-dates';
import { isOwed, taxItemLabel, type TaxItemRow } from '@/lib/rent-tax';
import { formatMinor } from '@/lib/tenancy-format';
import { DueBadge, RentTaxStatusBadge } from './tax-badges';
import { Table, Td, Th } from './ui/table';

/**
 * Rent tax receipt by receipt (TX-01, TX-02): the base the receipt was taxed on, the rate for the
 * lease's use, the tax, what is still to pay GRA, the due date and where it stands. Every figure
 * is the API's, worked out from the ledger; nothing is added up here.
 */
export function RentTaxTable({
  items,
  today,
  caption,
  ownerNames,
  linkPayments,
}: {
  readonly items: readonly TaxItemRow[];
  readonly today: string;
  readonly caption: string;
  /** For a list across owners, such as the due list for the whole company: their names by id. */
  readonly ownerNames?: ReadonlyMap<string, string>;
  /** Whether this person may open payments (billing.view). */
  readonly linkPayments: boolean;
}) {
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <Th>Rent received</Th>
          {ownerNames ? <Th>Owner</Th> : null}
          <Th>Lease</Th>
          <Th className="text-right">Taxed on</Th>
          <Th className="text-right">Rate</Th>
          <Th className="text-right">Tax</Th>
          <Th className="text-right">Still to pay GRA</Th>
          <Th>Due</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {items.map((item) => (
          <tr key={item.id} data-testid="rent-tax-item" data-item-id={item.id}>
            <Td className="whitespace-nowrap">
              {linkPayments && item.paymentId ? (
                <Link
                  href={`/payments/${item.paymentId}`}
                  className="font-medium underline underline-offset-2"
                >
                  {formatBusinessDate(item.valueDate)}
                </Link>
              ) : (
                formatBusinessDate(item.valueDate)
              )}
              {item.receiptNumber ? (
                <p className="font-mono text-xs text-slate-600">{item.receiptNumber}</p>
              ) : null}
              {item.kind && (item.kind !== 'receipt' || item.withholdingId) ? (
                <p className="text-xs text-slate-700">
                  {taxItemLabel({ kind: item.kind, withholdingId: item.withholdingId ?? null })}
                </p>
              ) : null}
            </Td>
            {ownerNames ? <Td>{ownerNames.get(item.ownerId) ?? 'An owner'}</Td> : null}
            <Td>
              {/* M11 (P25): an opening item is the owner's, with no lease or unit. */}
              {item.unitCode ? (
                <>
                  <span className="font-mono">{item.unitCode}</span>
                  <p className="text-xs text-slate-600">{item.tenantName}</p>
                </>
              ) : (
                <span className="text-slate-700">
                  {ownerNames?.get(item.ownerId) ?? 'The owner'}, at the cut-over
                </span>
              )}
            </Td>
            <Td className="text-right tabular-nums">{formatMinor(item.baseMinor)}</Td>
            <Td className="text-right tabular-nums">{rateLabel(item.rateBps)}</Td>
            <Td className="text-right">
              <span className="tabular-nums" data-testid="rent-tax-amount">
                {formatMinor(item.taxMinor)}
              </span>
              {item.warning ? (
                <p className="text-xs font-medium text-amber-900" data-testid="rent-tax-unverified">
                  Unverified rule
                </p>
              ) : null}
            </Td>
            <Td className="text-right tabular-nums" data-testid="rent-tax-outstanding">
              {isOwed(item.status) ? formatMinor(item.outstandingMinor) : '—'}
            </Td>
            <Td className="min-w-48 space-y-1">
              {isOwed(item.status) ? (
                <DueBadge item={item} today={today} />
              ) : (
                <RentTaxStatusBadge status={item.status} />
              )}
              {isOwed(item.status) && item.status === 'part_paid' ? (
                <RentTaxStatusBadge status={item.status} />
              ) : null}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
