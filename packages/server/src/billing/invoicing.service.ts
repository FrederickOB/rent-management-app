import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql, withCompany, type Database, type Tx } from '@rent/db';
import { isTax, lineBalance, linesAfterEnd, withheldOn } from '@rent/domain/billing';
import { formatBusinessDate } from '@rent/domain/dates';
import type { AlertPort } from '@rent/integrations';
import type { Clock } from '../core/clock';
import { ALERT_PORT, CLOCK, DATABASE } from '../core/tokens';
import { companyRecord } from '../companies/companies.service';
import { PostingService } from '../ledger/posting.service';
import { leaseIdsIn, renewedLeaseOf, startedRenewalIds } from '../tenancy/billing-facts';
import { BillingEngine, type LeaseState } from './engine';
import { isoNow, leaseGroup, lockCounters, lockLeases } from './records';

/** Lease states the daily invoice run bills (plan 4.4). */
const BILLED_STATES = ['signed', 'active', 'ending', 'holding_over'] as const;

/**
 * Invoices and accrual over time (BC-01, AR-01; plan 4.4, 4.6 and 4.20): the daily invoice and
 * accrual runs, and billing's reactions to tenancy's lease events through the outbox (signed,
 * started, ended, cancelled). Each lease is worked in its own transaction under its billing lock,
 * and every effect is keyed, so a rerun or a replayed event changes nothing.
 */
@Injectable()
export class InvoicingService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(ALERT_PORT) private readonly alerts?: AlertPort,
  ) {}

  /**
   * Runs one lease's part of a daily run in its own transaction. A lease that fails raises an
   * alert (its id and the error's code, nothing personal) and the run carries on; it is tried
   * again by the next run, and leases that succeeded are never redone (review 7).
   */
  private async eachLease(
    companyId: string,
    job: string,
    ids: readonly string[],
    run: (id: string) => Promise<number>,
  ): Promise<number> {
    let done = 0;
    for (const id of ids)
      try {
        done += await run(id);
      } catch (error) {
        const code =
          (error as { code?: unknown }).code &&
          typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'unexpected';
        await this.alerts
          ?.raise({
            severity: 'critical',
            code: 'billing.lease_run_failed',
            message: 'A lease could not be worked in the daily billing run',
            context: { companyId, job, leaseId: id, error: code },
          })
          .catch(() => undefined);
      }
    return done;
  }

  private system(companyId: string, requestId?: string) {
    return { companyId, actorKind: 'system' as const, requestId: requestId ?? null };
  }

  private async todayOf(companyId: string): Promise<string> {
    return withCompany(this.database, this.system(companyId), async (tx) => {
      const company = await companyRecord(tx, companyId);
      if (!company) throw new Error('Company not found');
      return isoNow(this.clock, company.timeZone);
    });
  }

  /**
   * Runs `fn` on a lease's money in one transaction, under its billing lock (and its renewed
   * lease's, when it is a renewal: both, in one order), after carrying a started renewal's
   * balances over (P29), so a renewal's accrual always finds its carried credit.
   */
  async withLease<T>(
    companyId: string,
    leaseId: string,
    date: string,
    fn: (tx: Tx, state: LeaseState) => Promise<T>,
    requestId?: string,
    options: { readonly numbers?: boolean } = {},
  ): Promise<T> {
    return withCompany(this.database, this.system(companyId, requestId), async (tx) => {
      const oldId = await renewedLeaseOf(tx, leaseId);
      await lockLeases(tx, companyId, await leaseGroup(tx, leaseId));
      // Invoices are numbered: the counters come before anything audited (review 3).
      if (options.numbers) await lockCounters(tx, companyId);
      const state = await this.engine.load(tx, companyId, leaseId);
      if (oldId) await this.engine.carryOverIfStarted(tx, state, date);
      return fn(tx, state);
    });
  }

  /** `billing.generate-invoices` for one company (daily 00:10): every cycle due by the date. */
  async generateAll(companyId: string, date?: string): Promise<number> {
    const today = date ?? (await this.todayOf(companyId));
    const ids = await withCompany(this.database, this.system(companyId), (tx) =>
      leaseIdsIn(tx, BILLED_STATES),
    );
    return this.eachLease(companyId, 'billing.generate-invoices', ids, (id) =>
      this.withLease(
        companyId,
        id,
        today,
        async (tx, state) => (await this.engine.generate(tx, state, today)).length,
        undefined,
        { numbers: true },
      ),
    );
  }

  /**
   * `billing.accrue-periods` for one company (daily 00:20, after the invoices): every lease with a
   * started line not yet accrued, and every renewal that has started, catching up any missed day.
   */
  async accrueAll(companyId: string, date?: string): Promise<number> {
    const today = date ?? (await this.todayOf(companyId));
    const ids = await withCompany(this.database, this.system(companyId), async (tx) => {
      const rows = await tx.execute<{ lease_id: string }>(
        sql`select distinct il.lease_id from invoice_line il
            where il.kind in ('rent', 'service_charge') and il.period_start <= ${today}::date
              and not exists (select 1 from invoice_line_accrual a
                              where a.company_id = il.company_id and a.invoice_line_id = il.id)`,
      );
      const renewals = [];
      for (const id of await startedRenewalIds(tx, today))
        if (!(await this.posting.findByKey(tx, companyId, `P29:${id}`))) renewals.push(id);
      return [...new Set([...rows.rows.map((r) => r.lease_id), ...renewals])].sort();
    });
    return this.eachLease(companyId, 'billing.accrue-periods', ids, (id) =>
      this.withLease(companyId, id, today, (tx, state) => this.engine.accrue(tx, state, today)),
    );
  }

  /**
   * `lease.signed`: the payment reference, the deposit invoice (a renewal asks only for what its
   * carried deposit does not cover), and the invoices already due (plan 4.4).
   */
  async onLeaseSigned(companyId: string, leaseId: string, requestId?: string): Promise<void> {
    const today = await this.todayOf(companyId);
    await this.withLease(
      companyId,
      leaseId,
      today,
      async (tx, state) => {
        await this.engine.ensureReference(tx, state.lease);
        if (state.book.kind !== 'book') return;
        const carried = state.lease.renewsLeaseId
          ? await this.engine.depositHeld(tx, state.lease.renewsLeaseId)
          : 0;
        await this.engine.issueDeposit(tx, state, carried, today);
        await this.engine.generate(tx, state, today);
        await this.engine.accrue(tx, state, today);
      },
      requestId,
      { numbers: true },
    );
  }

  /** `lease.activated`: a renewal carries its old lease's credit and deposit over (P29). */
  async onLeaseActivated(companyId: string, leaseId: string, requestId?: string): Promise<void> {
    const today = await this.todayOf(companyId);
    await this.withLease(companyId, leaseId, today, async () => undefined, requestId);
  }

  /**
   * `lease.ended`: lines of periods that start after the end (an early move-out) are cancelled by
   * a system credit note naming the end, with their VAT lines. No income was recognised on them,
   * so only their VAT and any money paid towards them move (plan 4.4, 4.9).
   */
  async onLeaseEnded(companyId: string, leaseId: string, requestId?: string): Promise<number> {
    const today = await this.todayOf(companyId);
    return this.withLease(
      companyId,
      leaseId,
      today,
      async (tx, state) => {
        const lastDay = state.lease.moveOutDate ?? state.lease.endedOn;
        if (!lastDay || state.book.kind !== 'book') return 0;
        const reason = `The lease ended on ${formatBusinessDate(lastDay)}`;
        return this.creditAll(tx, state, linesAfterEnd(state.lines, lastDay), reason, today);
      },
      requestId,
    );
  }

  /**
   * `lease.cancelled`: a signed lease cancelled before its start has every line cancelled the
   * same way. Money paid stays as the tenant's credit (a deposit stays held); refunds come later.
   */
  async onLeaseCancelled(companyId: string, leaseId: string, requestId?: string): Promise<number> {
    const today = await this.todayOf(companyId);
    return this.withLease(
      companyId,
      leaseId,
      today,
      async (tx, state) => {
        if (state.book.kind !== 'book') return 0;
        const bases = state.lines.filter((l) => !isTax(l.kind));
        return this.creditAll(tx, state, bases, 'The lease was cancelled before it started', today);
      },
      requestId,
    );
  }

  private async creditAll(
    tx: Tx,
    state: LeaseState,
    lines: readonly { readonly id: string }[],
    reason: string,
    today: string,
  ): Promise<number> {
    let credited = 0;
    for (const line of lines) {
      const current = state.lines.find((l) => l.id === line.id)!;
      const b = lineBalance(current, state.allocations);
      // Tax the tenant withheld on a month after the end stays on it: a credit note cannot take
      // it back (M5 decision 9); staff settle it by hand, and the termination's preview says so.
      const amount =
        current.kind === 'deposit'
          ? b.outstandingMinor
          : b.netMinor - b.writtenOffMinor - withheldOn(current.id, state.allocations);
      if (amount <= 0) continue;
      await this.engine.credit(tx, state, {
        lineId: current.id,
        amountMinor: amount,
        reason,
        kind: 'system',
        approvalRequestId: null,
        createdBy: null,
        valueDate: today,
      });
      credited += 1;
    }
    return credited;
  }
}
