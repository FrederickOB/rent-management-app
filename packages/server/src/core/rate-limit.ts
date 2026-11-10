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

/**
 * An alert window (M11 drills): whether to raise this alert now, at most `limit.count` times per
 * window per key, and how many were held back in the window before (to say so on the next one).
 * The same `rate_limit` row as consumeRateLimit; keys name companies or providers, never people.
 */
export async function consumeAlertWindow(
  database: Database,
  key: string,
  limit: RateLimit,
  nowMs: number,
): Promise<{ raise: boolean; suppressedBefore: number }> {
  const windowStart = nowMs - limit.windowMinutes * 60_000;
  const result = await withSystem(database, {}, (tx) =>
    tx.execute<{ count: number; previous: number | null; previous_at: number | null }>(sql`
      with previous as (select count, last_request from rate_limit where key = ${key})
      insert into rate_limit (key, count, last_request) values (${key}, 1, ${nowMs})
      on conflict (key) do update set
        count = case when rate_limit.last_request <= ${windowStart} then 1 else rate_limit.count + 1 end,
        last_request = case when rate_limit.last_request <= ${windowStart} then ${nowMs} else rate_limit.last_request end
      returning count,
        (select count from previous) as previous,
        (select last_request from previous) as previous_at`),
  );
  const row = result.rows[0];
  const count = Number(row?.count ?? 0);
  const raise = count <= limit.count;
  // A new window: what the last one held back beyond its allowance.
  const reset = row?.previous_at != null && Number(row.previous_at) <= windowStart;
  const suppressedBefore =
    raise && reset ? Math.max(0, Number(row?.previous ?? 0) - limit.count) : 0;
  return { raise, suppressedBefore };
}
