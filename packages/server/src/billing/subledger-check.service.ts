import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, type Database, type Tx } from '@rent/db';
import { lineBalance, paymentCredit, postingClassOf } from '@rent/domain/billing';
import type { AlertPort } from '@rent/integrations';
import { ALERT_PORT, DATABASE } from '../core/tokens';
import { BillingEngine } from './engine';
import { loadAllocations, paymentsByIds } from './records';

export interface SubledgerMismatch {
  readonly check:
    | 'receivable'
    | 'prepayment'
    | 'deposit'
    | 'deposit_unfunded'
    | 'payment'
    | 'cash'
    | 'suspense'
    | 'entry';
  readonly subject: string;
  readonly expectedMinor: number;
  readonly actualMinor: number;
}

export interface SubledgerResult {
  readonly companyId: string;
  readonly leases: number;
  readonly lines: number;
  readonly mismatches: readonly SubledgerMismatch[];
}

/**
 * The nightly sub-ledger check (`billing.subledger-check`, 03:00; plan 4.16), per company. It
 * proves, from the journal against billing's own records:
 * - invariant 2: 1100 per invoice line equals what is outstanding once the line is charged;
 * - invariant 3: 2010 per lease equals advance allocations to lines not yet charged plus the
 *   credit of the payments whose credit sits on the lease;
 * - invariant 4: 2100 per lease equals deposits received less what left, plus carry-overs;
 * - invariant 7: no payment is allocated beyond itself, and a reversed one allocates nothing;
 * - 1060 per collector and book equals approved cash less what was banked or reversed from hand;
 * - 2090 per payment equals the unmatched money still waiting;
 * - and, again, invariant 1: every entry balances in each book.
 * Any mismatch raises an alert naming the line, lease or payment.
 */
@Injectable()
export class SubledgerCheckService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
  ) {}

  async check(
    companyId: string,
    options: { readonly alert?: boolean } = {},
  ): Promise<SubledgerResult> {
    // One snapshot for the whole check, read only: a payment that commits midway is either all
    // in it or not at all, so it never raises a false alarm (review 6).
    const result = await withCompany(
      this.database,
      { companyId, actorKind: 'system' },
      (tx) => this.run(tx, companyId),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    if (result.mismatches.length > 0 && options.alert !== false)
      await this.alerts.raise({
        severity: 'critical',
        code: 'billing.subledger_mismatch',
        message: 'The ledger does not match its sub-ledgers',
        context: {
          companyId,
          mismatches: result.mismatches.length,
          first: result.mismatches
            .slice(0, 5)
            .map((m) => `${m.check}:${m.subject}`)
            .join(', '),
        },
      });
    return result;
  }

  private async sums(tx: Tx, account: string, by: 'invoice_line_id' | 'lease_id' | 'payment_id') {
    const rows = await tx.execute<{ key: string; total: number }>(
      sql`select ${sql.raw(by)} as key, sum(amount_minor)::bigint as total from journal_line
          where account_code = ${account} and ${sql.raw(by)} is not null group by ${sql.raw(by)}`,
    );
    return new Map(rows.rows.map((r) => [r.key, Number(r.total)]));
  }

  private async run(tx: Tx, companyId: string): Promise<SubledgerResult> {
    const mismatches: SubledgerMismatch[] = [];
    const add = (m: SubledgerMismatch) => {
      if (m.expectedMinor !== m.actualMinor) mismatches.push(m);
    };
    // Invariant 1, which the database also enforces at commit.
    const unbalanced = await tx.execute<{ entry_id: string; total: number }>(
      sql`select entry_id, sum(amount_minor)::bigint as total from journal_line
          group by entry_id, book_id having sum(amount_minor) <> 0`,
    );
    for (const r of unbalanced.rows)
      add({ check: 'entry', subject: r.entry_id, expectedMinor: 0, actualMinor: Number(r.total) });

    const receivable = await this.sums(tx, '1100', 'invoice_line_id');
    const prepaid = await this.sums(tx, '2010', 'lease_id');
    const deposits = await this.sums(tx, '2100', 'lease_id');
    const leaseRows = await tx.execute<{ lease_id: string }>(
      sql`select lease_id from invoice union select lease_id from payment where lease_id is not null
          union select lease_id from payment_match union select lease_id from credit_carry_over`,
    );
    let lineCount = 0;
    for (const { lease_id: leaseId } of leaseRows.rows) {
      const state = await this.engine.load(tx, companyId, leaseId);
      let onLines = 0;
      let depositsSettled = 0;
      for (const line of state.lines) {
        lineCount += 1;
        const b = lineBalance(line, state.allocations);
        const cls = postingClassOf(line);
        add({
          check: 'receivable',
          subject: line.id,
          expectedMinor: cls === 'receivable' ? b.outstandingMinor : 0,
          actualMinor: receivable.get(line.id) ?? 0,
        });
        if (cls === 'prepayment') onLines += b.settledMinor;
        if (cls === 'deposit') depositsSettled += b.settledMinor;
      }
      const credit = state.payments.reduce((s, p) => s + paymentCredit(p, state.allocations), 0);
      add({
        check: 'prepayment',
        subject: leaseId,
        expectedMinor: onLines + credit,
        actualMinor: -(prepaid.get(leaseId) ?? 0),
      });
      const carried = await tx.execute<{ net: number }>(
        sql`select coalesce(sum(case when lease_id = ${leaseId} then amount_minor else -amount_minor end), 0)::bigint as net
            from credit_carry_over where kind = 'deposit' and (lease_id = ${leaseId} or from_lease_id = ${leaseId})`,
      );
      add({
        check: 'deposit',
        subject: leaseId,
        expectedMinor: depositsSettled + Number(carried.rows[0]?.net ?? 0),
        actualMinor: -(deposits.get(leaseId) ?? 0),
      });
    }

    // No lease, and no payment's part of it, holds a negative deposit: a deposit taken from the
    // wrong lease is caught here rather than netted away (review 9).
    const unfunded = await tx.execute<{
      lease_id: string;
      payment_id: string | null;
      total: number;
    }>(
      sql`select lease_id, payment_id, sum(amount_minor)::bigint as total from journal_line
          where account_code = '2100' and lease_id is not null and payment_id is not null
          group by lease_id, payment_id having sum(amount_minor) > 0
          union all
          select lease_id, null, sum(amount_minor)::bigint from journal_line
          where account_code = '2100' and lease_id is not null
          group by lease_id having sum(amount_minor) > 0`,
    );
    for (const r of unfunded.rows)
      add({
        check: 'deposit_unfunded',
        subject: `${r.lease_id}:${r.payment_id ?? 'all'}`,
        expectedMinor: 0,
        actualMinor: -Number(r.total),
      });

    // Invariant 7 per payment, and the unmatched suspense (2090).
    const paymentIds = (await tx.execute<{ id: string }>(sql`select id from payment`)).rows.map(
      (r) => r.id,
    );
    const payments = await paymentsByIds(tx, paymentIds);
    const allocations = await loadAllocations(tx, { leaseIds: [], paymentIds });
    const suspense = await this.sums(tx, '2090', 'payment_id');
    for (const p of payments) {
      const allocated = allocations
        .filter((a) => a.source === 'payment' && a.paymentId === p.id)
        .reduce((s, a) => s + a.amountMinor, 0);
      if (p.reversedAccountingDate !== null)
        add({ check: 'payment', subject: p.id, expectedMinor: 0, actualMinor: allocated });
      else {
        let credit: number;
        try {
          credit = paymentCredit(p, allocations);
        } catch {
          credit = -1;
        }
        add({
          check: 'payment',
          subject: p.id,
          expectedMinor: p.amountMinor,
          actualMinor: allocated + credit,
        });
      }
      const waiting = !p.leaseId && p.reversedAccountingDate === null ? p.amountMinor : 0;
      add({
        check: 'suspense',
        subject: p.id,
        expectedMinor: waiting,
        actualMinor: -(suspense.get(p.id) ?? 0),
      });
    }

    // 1060 per collector and book: approved cash, less what was banked or reversed from hand.
    const cash = await tx.execute<{
      collector: string;
      book_id: string;
      expected: number;
      actual: number;
    }>(
      sql`with received as (
            select collector_person_id as collector, book_id, sum(amount_minor) as amount from payment
            where cash_account = '1060' group by 1, 2),
          reversed as (
            select p.collector_person_id as collector, p.book_id, sum(p.amount_minor) as amount
            from payment_reversal r join payment p on p.company_id = r.company_id and p.id = r.payment_id
            where r.money_now_in = 'collector' group by 1, 2),
          banked as (
            select b.collector_person_id as collector, b.book_id, sum(b.amount_minor) as amount
            from cash_banking b where exists (select 1 from journal_entry e
              where e.company_id = b.company_id and e.idempotency_key = 'P07:' || b.id::text)
            group by 1, 2),
          journal as (
            select collector_id as collector, book_id, sum(amount_minor) as amount from journal_line
            where account_code = '1060' group by 1, 2),
          keys as (select collector, book_id from received union select collector, book_id from journal)
          select k.collector, k.book_id,
            (coalesce(r.amount, 0) - coalesce(v.amount, 0) - coalesce(b.amount, 0))::bigint as expected,
            coalesce(j.amount, 0)::bigint as actual
          from keys k
          left join received r on r.collector = k.collector and r.book_id = k.book_id
          left join reversed v on v.collector = k.collector and v.book_id = k.book_id
          left join banked b on b.collector = k.collector and b.book_id = k.book_id
          left join journal j on j.collector = k.collector and j.book_id = k.book_id`,
    );
    for (const r of cash.rows)
      add({
        check: 'cash',
        subject: `${r.collector}:${r.book_id}`,
        expectedMinor: Number(r.expected),
        actualMinor: Number(r.actual),
      });

    return { companyId, leases: leaseRows.rows.length, lines: lineCount, mismatches };
  }
}
