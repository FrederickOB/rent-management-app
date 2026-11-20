import { Inject, Injectable } from '@nestjs/common';
import { sql, withSystem, type Database } from '@rent/db';
import type { Clock } from '../core/clock';
import { CLOCK, DATABASE } from '../core/tokens';
import { RATE_LIMIT_KEEP_MS, REJECTED_WEBHOOK_KEEP_DAYS } from './constants';

/**
 * `ops.prune` (daily; M11 review R3 F1): what an attacker can grow without bound is trimmed.
 * - `rate_limit` rows whose last request (or window start) is more than 24 hours old: the longest
 *   window in use is a day, so nothing still counting is removed.
 * - rejected webhooks (bad signature or too large, kept without a body) older than 30 days,
 *   through app.prune_rejected_webhooks, which never deletes a signed row.
 */
@Injectable()
export class OpsPruningService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async prune(): Promise<{ rateLimits: number; rejectedWebhooks: number }> {
    const cutoff = this.clock.now().getTime() - RATE_LIMIT_KEEP_MS;
    const rateLimits = await withSystem(this.database, {}, (tx) =>
      tx.execute<{ n: number }>(
        sql`with gone as (delete from rate_limit where last_request < ${cutoff} returning 1)
            select count(*)::int as n from gone`,
      ),
    );
    // The database's own clock: the function refuses a cut-off newer than 30 days ago.
    const rejected = await withSystem(this.database, {}, (tx) =>
      tx.execute<{ n: number }>(
        sql`select app.prune_rejected_webhooks(now() - make_interval(days => ${REJECTED_WEBHOOK_KEEP_DAYS}::int)) as n`,
      ),
    );
    return {
      rateLimits: Number(rateLimits.rows[0]?.n ?? 0),
      rejectedWebhooks: Number(rejected.rows[0]?.n ?? 0),
    };
  }
}
