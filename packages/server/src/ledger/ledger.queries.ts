import { sql, type SQL, type Tx } from '@rent/db';
import type { AccountCode } from '@rent/domain/ledger';

/**
 * Balance queries over the journal (ADR-003): sums on demand, filtered by book, account and
 * dimensions and grouped by any of them. Indexes lead with (company_id, book_id, account_code)
 * and the lease, invoice line, payment and collector dimensions. RLS applies: a scoped session
 * sums only the lines it may see.
 */
const GROUPS = {
  bookId: 'l.book_id',
  accountCode: 'l.account_code',
  propertyId: 'l.property_id',
  leaseId: 'l.lease_id',
  tenantId: 'l.tenant_id',
  invoiceLineId: 'l.invoice_line_id',
  paymentId: 'l.payment_id',
  collectorId: 'l.collector_id',
} as const;
export type BalanceGroup = keyof typeof GROUPS;

export interface BalanceFilter {
  readonly accounts: readonly AccountCode[];
  readonly bookIds?: readonly string[];
  readonly leaseIds?: readonly string[];
  readonly invoiceLineIds?: readonly string[];
  readonly paymentIds?: readonly string[];
  readonly collectorIds?: readonly string[];
  readonly propertyIds?: readonly string[];
  /** Entries reported on or before this accounting date. */
  readonly accountingDateTo?: string;
}

export type BalanceRow = { readonly balanceMinor: number } & Partial<
  Record<BalanceGroup, string>
> & {
    /** The earliest value date among the lines summed. */
    readonly firstValueDate: string | null;
  };

const uuids = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

export async function sumLines(
  tx: Tx,
  filter: BalanceFilter,
  groupBy: readonly BalanceGroup[] = [],
): Promise<BalanceRow[]> {
  const where: SQL[] = [sql`l.account_code = any(${`{${filter.accounts.join(',')}}`}::text[])`];
  if (filter.bookIds) where.push(sql`l.book_id = any(${uuids(filter.bookIds)})`);
  if (filter.leaseIds) where.push(sql`l.lease_id = any(${uuids(filter.leaseIds)})`);
  if (filter.invoiceLineIds)
    where.push(sql`l.invoice_line_id = any(${uuids(filter.invoiceLineIds)})`);
  if (filter.paymentIds) where.push(sql`l.payment_id = any(${uuids(filter.paymentIds)})`);
  if (filter.collectorIds) where.push(sql`l.collector_id = any(${uuids(filter.collectorIds)})`);
  if (filter.propertyIds) where.push(sql`l.property_id = any(${uuids(filter.propertyIds)})`);
  if (filter.accountingDateTo)
    where.push(sql`e.accounting_date <= ${filter.accountingDateTo}::date`);
  const columns = groupBy.map((g) => sql.raw(`${GROUPS[g]} as "${g}"`));
  const select = columns.length > 0 ? sql`${sql.join(columns, sql`, `)},` : sql``;
  const group =
    groupBy.length > 0 ? sql`group by ${sql.raw(groupBy.map((g) => GROUPS[g]).join(', '))}` : sql``;
  const result = await tx.execute<Record<string, unknown>>(
    sql`select ${select} coalesce(sum(l.amount_minor), 0)::bigint as "balanceMinor",
          min(e.value_date)::text as "firstValueDate"
        from journal_line l join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
        where ${sql.join(where, sql` and `)} ${group}`,
  );
  return result.rows.map((r) => ({ ...r, balanceMinor: Number(r.balanceMinor) }) as BalanceRow);
}

/** One balance: the sum of the lines that match. */
export async function balance(tx: Tx, filter: BalanceFilter): Promise<number> {
  const [row] = await sumLines(tx, filter);
  return row?.balanceMinor ?? 0;
}

/** Balances keyed by one dimension, zero balances left out. */
export async function balancesBy(
  tx: Tx,
  filter: BalanceFilter,
  by: BalanceGroup,
): Promise<Map<string, number>> {
  const rows = await sumLines(tx, filter, [by]);
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = r[by];
    if (key && r.balanceMinor !== 0) out.set(key, r.balanceMinor);
  }
  return out;
}
