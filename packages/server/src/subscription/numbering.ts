import { sql, type Tx } from '@rent/db';

/**
 * Gap-free subscription invoice and receipt numbers (PB-07): `SUB-2026-000001` and
 * `SUBR-2026-000001`, one sequence per kind and year in the platform company's counters, taken in
 * the issuing transaction and locked until it ends, so a failed transaction rolls its number back.
 */
export type SubscriptionNumberKind = 'invoice' | 'receipt';

const PREFIX: Record<SubscriptionNumberKind, string> = { invoice: 'SUB', receipt: 'SUBR' };

export function formatSubscriptionNumber(
  kind: SubscriptionNumberKind,
  year: number,
  value: number,
): string {
  return `${PREFIX[kind]}-${year}-${String(value).padStart(6, '0')}`;
}

export async function nextSubscriptionNumber(
  tx: Tx,
  platformId: string,
  kind: SubscriptionNumberKind,
  year: number,
): Promise<string> {
  const name = `subscription_${kind}:${year}`;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`counters:${platformId}:${name}`}, 17))`,
  );
  const result = await tx.execute<{ value: number }>(
    sql`insert into company_counter (company_id, name, value) values (${platformId}::uuid, ${name}, 1)
        on conflict (company_id, name) do update set value = company_counter.value + 1
        returning value`,
  );
  return formatSubscriptionNumber(kind, year, Number(result.rows[0]!.value));
}
