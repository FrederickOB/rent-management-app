import { Inject, Injectable } from '@nestjs/common';
import { sql, type Database, type Tx } from '@rent/db';
import type { AlertPort } from '@rent/integrations';
import { ALERT_PORT, DATABASE } from '../core/tokens';
import { SubscriptionCoreService } from './core.service';
import { platformBookId, withPlatform } from './platform';

export interface SubscriptionSubledgerMismatch {
  /**
   * `receivable`: 1100 for an invoice differs from what it owes; `prepaid_credit`: 2020 for a
   * subscriber differs from its prepaid credit; `unattributed`: a 1100 or 2020 balance in the
   * platform book that names no subscription invoice or payment.
   */
  readonly check: 'receivable' | 'prepaid_credit' | 'unattributed';
  /** The invoice id, the subscriber company id, or `<account>:<dimension>`. Ids only. */
  readonly subject: string;
  readonly expectedMinor: number;
  readonly actualMinor: number;
}

export interface SubscriptionSubledgerResult {
  readonly invoices: number;
  readonly subscribers: number;
  readonly mismatches: readonly SubscriptionSubledgerMismatch[];
}

/**
 * The nightly subscription sub-ledger check (M10, as billing's `SubledgerCheckService`): in the
 * platform book, 1100 per subscription invoice (`journal_line.invoice_line_id` holds the invoice
 * id) equals what the invoice still owes (its total less the payments and prepaid draws allocated
 * to it; nothing for a void one), and 2020 per subscriber equals its prepaid credit
 * (`SubscriptionCoreService.creditMinor`). 2020 lines name the subscriber through their payment
 * (`payment_id`) or, for a monthly draw, their invoice. Any difference raises an alert naming ids
 * only. Read in one read-only snapshot, so a payment committing midway raises no false alarm.
 */
@Injectable()
export class SubscriptionSubledgerCheck {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(SubscriptionCoreService) private readonly core: SubscriptionCoreService,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
  ) {}

  /** For the worker's nightly job (no payload: the platform company is the only book checked). */
  async check(options: { readonly alert?: boolean } = {}): Promise<SubscriptionSubledgerResult> {
    const result = await withPlatform(
      this.database,
      {},
      (tx, platformId) => this.run(tx, platformId),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    if (result.mismatches.length > 0 && options.alert !== false)
      await this.alerts.raise({
        severity: 'critical',
        code: 'subscription.subledger_mismatch',
        message: 'The platform book does not match the subscription sub-ledgers',
        context: {
          mismatches: result.mismatches.length,
          first: result.mismatches
            .slice(0, 5)
            .map((m) => `${m.check}:${m.subject}`)
            .join(', '),
        },
      });
    return result;
  }

  private async run(tx: Tx, platformId: string): Promise<SubscriptionSubledgerResult> {
    const bookId = await platformBookId(tx, platformId);
    const mismatches: SubscriptionSubledgerMismatch[] = [];

    // 1100 per invoice against what each owes.
    const invoices = await tx.execute<{
      id: string;
      status: string;
      total_minor: string | number;
      settled_minor: string | number;
    }>(
      sql`select i.id, i.status, i.total_minor,
            coalesce((select sum(a.amount_minor) from subscription_allocation a
                      left join subscription_payment p on p.company_id = a.company_id and p.id = a.payment_id
                      where a.company_id = i.company_id and a.invoice_id = i.id
                        and (a.payment_id is null or p.status = 'succeeded')), 0) as settled_minor
          from subscription_invoice i order by i.id`,
    );
    const receivables = await tx.execute<{ invoice_id: string | null; total: string | number }>(
      sql`select invoice_line_id as invoice_id, sum(amount_minor) as total from journal_line
          where book_id = ${bookId}::uuid and account_code = '1100'
          group by invoice_line_id`,
    );
    const ledger = new Map(receivables.rows.map((r) => [r.invoice_id, Number(r.total)]));
    for (const invoice of invoices.rows) {
      const expectedMinor =
        invoice.status === 'void' ? 0 : Number(invoice.total_minor) - Number(invoice.settled_minor);
      const actualMinor = ledger.get(invoice.id) ?? 0;
      ledger.delete(invoice.id);
      if (actualMinor !== expectedMinor)
        mismatches.push({ check: 'receivable', subject: invoice.id, expectedMinor, actualMinor });
    }
    for (const [invoiceId, actualMinor] of ledger)
      if (actualMinor !== 0)
        mismatches.push({
          check: 'unattributed',
          subject: `1100:${invoiceId ?? 'none'}`,
          expectedMinor: 0,
          actualMinor,
        });

    // 2020 per subscriber against its prepaid credit.
    const credits = await tx.execute<{ subscriber: string | null; total: string | number }>(
      sql`select coalesce(p.subscriber_company_id, i.subscriber_company_id) as subscriber,
            sum(l.amount_minor) as total
          from journal_line l
          left join subscription_payment p on p.company_id = l.company_id and p.id = l.payment_id
          left join subscription_invoice i on i.company_id = l.company_id and i.id = l.invoice_line_id
          where l.book_id = ${bookId}::uuid and l.account_code = '2020'
          group by 1`,
    );
    // A liability: credit held is the negated balance.
    const held = new Map(credits.rows.map((r) => [r.subscriber, -Number(r.total)]));
    const unattributed = held.get(null);
    held.delete(null);
    if (unattributed !== undefined && unattributed !== 0)
      mismatches.push({
        check: 'unattributed',
        subject: '2020:none',
        expectedMinor: 0,
        actualMinor: unattributed,
      });
    const subscribers = await tx.execute<{ id: string }>(
      sql`select subscriber_company_id as id from subscription
          union select subscriber_company_id from subscription_payment
          order by 1`,
    );
    const ids = new Set([
      ...subscribers.rows.map((r) => r.id),
      ...(held.keys() as Iterable<string>),
    ]);
    for (const subscriberId of ids) {
      const expectedMinor = await this.core.creditMinor(tx, subscriberId);
      const actualMinor = held.get(subscriberId) ?? 0;
      if (actualMinor !== expectedMinor)
        mismatches.push({
          check: 'prepaid_credit',
          subject: subscriberId,
          expectedMinor,
          actualMinor,
        });
    }
    return { invoices: invoices.rows.length, subscribers: ids.size, mismatches };
  }
}
