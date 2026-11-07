import { sql, type SQL, type Tx } from '@rent/db';
import { DomainError } from '@rent/domain/errors';

/**
 * Money held for tenants (2010), split one way for the owner statement and the dashboard alike
 * (M9 review; founder, 2026-11-07: the allocation basis), as of a business date by accounting
 * date, so a statement regenerated for a past month reads exactly what it read when issued:
 *
 * - unearned rent (AR-03): money allocated to rent lines whose charge period had not started,
 *   that is, not accrued (P02) by then;
 * - unearned service charge: the same for service-charge lines;
 * - credit ("Paid ahead, not yet applied to a month"): the rest of 2010, money held for the tenant
 *   and applied to no line (a payment's surplus, and anything set aside for VAT and levy lines).
 *   Never clamped, so a negative value shows the ledger disagrees with itself.
 *
 * Read from 2010's own journal lines: an allocation to a line not started is posted to 2010 on
 * that line (P03, P19, a late draw's advance), and P02 draws it when the period starts; a credit
 * note or a correction moves it back to the payment's surplus. So the money allocated ahead is
 * the 2010 held on lines not yet accrued, always part of 2010 as of the same date, even for money
 * recorded late. One query; reads only, in the caller's transaction and scope.
 */
export interface PrepaymentSplitRow {
  readonly leaseId: string;
  readonly propertyId: string;
  /** All of the lease's 2010, as a positive amount: the three below add up to it. */
  readonly prepaymentsMinor: number;
  readonly unearnedRentMinor: number;
  readonly unearnedServiceChargeMinor: number;
  readonly creditMinor: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const uuids = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

const whole = (value: unknown): number => {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n))
    throw new DomainError('report.bad_amount', 'Prepayments are whole numbers of pesewas');
  return n;
};

/**
 * Each lease's split as of `asOf` (accounting dates on or before it), for the leases given or for
 * every lease with money in the books given (at least one filter). Leases with nothing held and
 * nothing allocated ahead are left out.
 */
export async function prepaymentSplitAt(
  tx: Tx,
  input: {
    readonly asOf: string;
    readonly bookIds?: readonly string[];
    readonly leaseIds?: readonly string[];
  },
): Promise<Map<string, PrepaymentSplitRow>> {
  if (!ISO_DATE.test(input.asOf)) throw new DomainError('report.bad_date', 'Give a date');
  const books = input.bookIds;
  const leases = input.leaseIds;
  if (!books && !leases)
    throw new DomainError('report.unbounded', 'Name the books or the leases to split');
  if ((books && books.length === 0) || (leases && leases.length === 0)) return new Map();
  const filter: SQL[] = [];
  if (books) filter.push(sql`l.book_id = any(${uuids(books)})`);
  if (leases) filter.push(sql`l.lease_id = any(${uuids(leases)})`);
  const unaccrued = (kind: 'rent' | 'service_charge') =>
    sql`l.invoice_line_id is not null and il.kind = ${kind} and il.base_line_id is null
        and ac.id is null`;
  const rows = await tx.execute<{
    lease_id: string;
    property_id: string;
    prepaid: string | null;
    rent: string | null;
    service: string | null;
  }>(
    sql`select l.lease_id, min(l.property_id::text)::uuid as property_id,
          (0 - sum(l.amount_minor))::bigint as prepaid,
          (0 - coalesce(sum(l.amount_minor) filter (where ${unaccrued('rent')}), 0))::bigint
            as rent,
          (0 - coalesce(sum(l.amount_minor) filter (where ${unaccrued('service_charge')}), 0))::bigint
            as service
        from journal_line l
        join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
        left join invoice_line il on il.company_id = l.company_id and il.id = l.invoice_line_id
        left join invoice_line_accrual ac on ac.company_id = il.company_id
          and ac.invoice_line_id = il.id and ac.accounting_date <= ${input.asOf}::date
        where l.account_code = '2010' and l.lease_id is not null
          and e.accounting_date <= ${input.asOf}::date and ${sql.join(filter, sql` and `)}
        group by l.lease_id`,
  );
  const out = new Map<string, PrepaymentSplitRow>();
  for (const r of rows.rows) {
    const prepaymentsMinor = whole(r.prepaid);
    const unearnedRentMinor = whole(r.rent);
    const unearnedServiceChargeMinor = whole(r.service);
    if (prepaymentsMinor === 0 && unearnedRentMinor === 0 && unearnedServiceChargeMinor === 0)
      continue;
    out.set(r.lease_id, {
      leaseId: r.lease_id,
      propertyId: r.property_id,
      prepaymentsMinor,
      unearnedRentMinor,
      unearnedServiceChargeMinor,
      creditMinor: prepaymentsMinor - unearnedRentMinor - unearnedServiceChargeMinor,
    });
  }
  return out;
}

/** The split added up by property (the statement's pages). */
export function prepaymentSplitByProperty(
  rows: Iterable<PrepaymentSplitRow>,
): Map<string, Omit<PrepaymentSplitRow, 'leaseId' | 'propertyId'>> {
  const out = new Map<string, Omit<PrepaymentSplitRow, 'leaseId' | 'propertyId'>>();
  for (const r of rows) {
    const t = out.get(r.propertyId) ?? {
      prepaymentsMinor: 0,
      unearnedRentMinor: 0,
      unearnedServiceChargeMinor: 0,
      creditMinor: 0,
    };
    out.set(r.propertyId, {
      prepaymentsMinor: t.prepaymentsMinor + r.prepaymentsMinor,
      unearnedRentMinor: t.unearnedRentMinor + r.unearnedRentMinor,
      unearnedServiceChargeMinor: t.unearnedServiceChargeMinor + r.unearnedServiceChargeMinor,
      creditMinor: t.creditMinor + r.creditMinor,
    });
  }
  return out;
}
