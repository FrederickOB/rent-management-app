import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, type Database } from '@rent/db';
import type { AlertPort } from '@rent/integrations';
import { ALERT_PORT, DATABASE } from '../core/tokens';

/** The nightly agent cash check (founder decision F3; architecture section 10). */
export const AGENT_CASH_CHECK_JOB = 'ledger.agent-cash-check';

export interface AgentCashShortfall {
  readonly ownerId: string;
  readonly bookId: string;
  /** 1070 in the owner's book: below zero. */
  readonly heldMinor: number;
}

export interface AgentCashCheckResult {
  readonly companyId: string;
  /** Owner books with any 1070 line. */
  readonly books: number;
  readonly negative: readonly AgentCashShortfall[];
}

/**
 * F3's safety net (founder, 2026-11-06): what the agency holds for an owner (1070 in the owner's
 * book) is never below zero. Every payment out of it is refused beyond what is held, under the
 * owner's lock (`assertAgentCash`), but a chargeback or a provider reversal cannot be refused, so
 * this check runs nightly per company and raises the critical `ledger.agent_cash_negative` for
 * any owner book whose 1070 is below zero now. Read only, in one snapshot.
 */
@Injectable()
export class AgentCashCheckService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
  ) {}

  async check(
    companyId: string,
    options: { readonly alert?: boolean } = {},
  ): Promise<AgentCashCheckResult> {
    const rows = await withCompany(
      this.database,
      { companyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ book_id: string; owner_id: string; held: string }>(
          sql`select b.id as book_id, b.owner_id, sum(l.amount_minor)::bigint as held
              from book b
              join journal_line l on l.company_id = b.company_id and l.book_id = b.id
              where b.kind = 'owner' and l.account_code = '1070'
              group by b.id, b.owner_id
              order by b.owner_id`,
        ),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    const negative = rows.rows
      .map((r) => ({ ownerId: r.owner_id, bookId: r.book_id, heldMinor: Number(r.held) }))
      .filter((r) => r.heldMinor < 0);
    if (negative.length > 0 && options.alert !== false)
      await this.alerts.raise({
        severity: 'critical',
        code: 'ledger.agent_cash_negative',
        message: 'The agency holds less than nothing for an owner (1070 below zero)',
        context: {
          companyId,
          owners: negative.length,
          first: negative
            .slice(0, 5)
            .map((n) => `${n.ownerId}:${n.heldMinor}`)
            .join(', '),
        },
      });
    return { companyId, books: rows.rows.length, negative };
  }
}
