import { sql, withSystem, type Database } from '@rent/db';

export interface RateLimit {
  readonly count: number;
  readonly windowMinutes: number;
}

/**
 * Counts one hit against a fixed-window limit in the global `rate_limit` table, as the M1 sign-in
 * code limit does, and says whether it is within the limit. Keys never hold a phone number, an
 * email or an IP address in the clear: callers pass a keyed hash (CLAUDE.md section 10).
 */
export async function consumeRateLimit(
  database: Database,
  key: string,
  limit: RateLimit,
  nowMs: number,
): Promise<boolean> {
  const windowStart = nowMs - limit.windowMinutes * 60_000;
  const result = await withSystem(database, {}, (tx) =>
    tx.execute<{ count: number }>(sql`
      insert into rate_limit (key, count, last_request) values (${key}, 1, ${nowMs})
      on conflict (key) do update set
        count = case when rate_limit.last_request <= ${windowStart} then 1 else rate_limit.count + 1 end,
        last_request = case when rate_limit.last_request <= ${windowStart} then ${nowMs} else rate_limit.last_request end
      returning count`),
  );
  return Number(result.rows[0]?.count ?? 0) <= limit.count;
}
