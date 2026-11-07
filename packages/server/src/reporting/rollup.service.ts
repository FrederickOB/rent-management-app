import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { AGE_BUCKETS, monthsPaidAhead, type AgeBucket } from '@rent/domain/billing';
import { ledgerArrears, rentRoll, reportMonth } from '@rent/domain/reporting';
import type { AlertPort } from '@rent/integrations';
import { OCCUPYING_STATUSES } from '@rent/domain/tenancy';
import { BillingEngine } from '../billing/engine';
import { isoNow } from '../billing/records';
import { companyRecord } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { ALERT_PORT, CLOCK, DATABASE } from '../core/tokens';
import { sumLines } from '../ledger/ledger.queries';
import { Gate1Service, type StoredGate1 } from './gate1.service';
import { prepaymentSplitAt } from './prepayment-split';

/** The daily rollup (decision 11; architecture section 10), and the queue a refresh feeds. */
export const METRICS_ROLLUP_JOB = 'reporting.metrics-rollup';
/** Outbox event a dashboard refresh records; the worker runs one rollup for the company. */
export const METRICS_REFRESH_EVENT = 'reporting.metrics-refresh';

/** Leases walked per read transaction: short transactions, few round trips. */
const LEASE_BATCH = 200;
const INSERT_BATCH = 500;

type SnapshotRow = typeof schema.leaseSnapshot.$inferInsert;

export interface RollupResult {
  readonly companyId: string;
  readonly snapshotDate: string;
  readonly month: string;
  readonly leases: number;
  readonly computedAt: Date;
  /** Past months this run marked final (normally last month, on the 1st). */
  readonly finalised: readonly string[];
  /** Final months whose notice or repair windows this run worked out again. */
  readonly settled: readonly string[];
  /**
   * Leases whose credit came out below zero: more allocated to months not started than their 2010
   * holds, so the ledger and the sub-ledger disagree. Raised as a critical alert, never clamped.
   */
  readonly negativeCredit: readonly string[];
}

/** The alert a negative credit raises (M9 review: shown, never clamped, never silent). */
export const PREPAYMENT_SPLIT_ALERT = 'reporting.prepayment_split_negative';

const BUCKET_COLUMN: Record<AgeBucket, keyof SnapshotRow> = {
  '0_30': 'arrears0To30Minor',
  '31_60': 'arrears31To60Minor',
  '61_90': 'arrears61To90Minor',
  '90_plus': 'arrears90PlusMinor',
};

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/**
 * `reporting.metrics-rollup` (decision 11): per company and day, a snapshot row per lease with its
 * paid-until, months paid ahead, arrears by bucket, unearned rent, deposit held and rent roll, from
 * billing's own engine walk and the ledger, plus the month's Gate 1 figures with their inputs.
 * The leases are walked in batches of read-only transactions; the day's rows are then replaced in
 * one short transaction, so a reader sees the old snapshot or the new one, never half of either,
 * and running it again for the same day gives the same rows. It posts and alerts nothing.
 *
 * Gate 1's months are finalised (M9 review): a past month the rollup stored figures for is worked
 * out once more after its end and marked final, on its last day's row (normally on the 1st; a
 * failed run's month is caught by the next run). A final month's figures never change after that,
 * except its notices and repairs, worked out again each run while any window is still open, so
 * nothing stays pending once its window has closed.
 *
 * Money held for tenants is split as the statement splits it (`prepaymentSplitAt`, the invoice
 * basis): a lease whose credit comes out negative raises a critical alert, the one thing it alerts.
 */
@Injectable()
export class ReportingRollupService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(Gate1Service) private readonly gate1: Gate1Service,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(ALERT_PORT) private readonly alerts?: AlertPort,
  ) {}

  async run(companyId: string): Promise<RollupResult> {
    const ctx = { companyId, actorKind: 'system' as const };
    const readOnly = { accessMode: 'read only' as const };
    const { timeZone, today, leaseIds } = await withCompany(
      this.database,
      ctx,
      async (tx) => {
        const company = await companyRecord(tx, companyId);
        if (!company) throw new Error('Company not found');
        // Every lease with money on the books, and every lease holding its unit.
        const rows = await tx.execute<{ id: string }>(
          sql`select id from lease where status in ('signed', 'active', 'ending', 'holding_over')
              union select lease_id from invoice
              union select lease_id from payment where lease_id is not null
              union select lease_id from payment_match
              union select lease_id from credit_carry_over
              order by 1`,
        );
        return {
          timeZone: company.timeZone,
          today: isoNow(this.clock, company.timeZone),
          leaseIds: rows.rows.map((r) => r.id),
        };
      },
      readOnly,
    );
    const rows: SnapshotRow[] = [];
    for (const batch of chunks(leaseIds, LEASE_BATCH))
      rows.push(
        ...(await withCompany(
          this.database,
          ctx,
          (tx) => this.snapshotRows(tx, companyId, batch, today),
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
        )),
      );
    const month = today.slice(0, 7);
    const computedAt = this.clock.now();
    const { figures, finals, settles } = await withCompany(
      this.database,
      ctx,
      async (tx) => {
        const figures = await this.gate1.compute(tx, companyId, month, computedAt, timeZone);
        const finals: { month: string; metricDate: string; figures: StoredGate1 }[] = [];
        for (const past of await this.gate1.monthsToFinaliseIn(tx, month))
          finals.push({
            month: past,
            metricDate: reportMonth(past).lastDay,
            figures: await this.gate1.compute(tx, companyId, past, computedAt, timeZone),
          });
        const settles: { month: string; metricDate: string; figures: StoredGate1 }[] = [];
        for (const open of await this.gate1.unsettledIn(tx, month)) {
          const windows = await this.gate1.windowsIn(
            tx,
            companyId,
            open.month,
            computedAt,
            timeZone,
          );
          settles.push({
            ...open,
            figures: {
              gate1: {
                ...open.figures.gate1,
                noticeAcknowledgement: windows.noticeAcknowledgement,
                repairResponse: windows.repairResponse,
              },
              inputs: {
                ...open.figures.inputs,
                notices: windows.notices,
                emergencyJobs: windows.emergencyJobs,
                windowsAsOf: computedAt.toISOString(),
              },
            },
          });
        }
        return { figures, finals, settles };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    for (const row of rows) row.computedAt = computedAt;
    const written = await withCompany(this.database, ctx, async (tx) => {
      // One rollup per company at a time: a refresh and the daily run never interleave.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`reporting.rollup:${companyId}`}, 0))`,
      );
      await tx
        .delete(schema.leaseSnapshot)
        .where(
          and(
            eq(schema.leaseSnapshot.companyId, companyId),
            eq(schema.leaseSnapshot.snapshotDate, today),
          ),
        );
      for (const part of chunks(rows, INSERT_BATCH))
        await tx.insert(schema.leaseSnapshot).values(part);
      await tx
        .insert(schema.metricDaily)
        .values({ companyId, metricDate: today, month, figures, computedAt })
        .onConflictDoUpdate({
          target: [schema.metricDaily.companyId, schema.metricDaily.metricDate],
          set: { month, figures, computedAt },
        });
      // A month is finalised once: a run that lost the race to another leaves its row alone.
      const finalised: string[] = [];
      for (const f of finals) {
        const done = await tx
          .insert(schema.metricDaily)
          .values({
            companyId,
            metricDate: f.metricDate,
            month: f.month,
            figures: f.figures,
            computedAt,
            finalisedAt: computedAt,
          })
          .onConflictDoUpdate({
            target: [schema.metricDaily.companyId, schema.metricDaily.metricDate],
            set: { month: f.month, figures: f.figures, computedAt, finalisedAt: computedAt },
            setWhere: sql`${schema.metricDaily.finalisedAt} is null`,
          })
          .returning({ month: schema.metricDaily.month });
        if (done.length > 0) finalised.push(f.month);
      }
      const settled: string[] = [];
      for (const w of settles) {
        const done = await tx
          .update(schema.metricDaily)
          .set({ figures: w.figures, computedAt })
          .where(
            and(
              eq(schema.metricDaily.companyId, companyId),
              eq(schema.metricDaily.metricDate, w.metricDate),
              sql`${schema.metricDaily.finalisedAt} is not null`,
            ),
          )
          .returning({ month: schema.metricDaily.month });
        if (done.length > 0) settled.push(w.month);
      }
      return { finalised, settled };
    });
    const negativeCredit = rows.filter((r) => (r.creditMinor ?? 0) < 0).map((r) => r.leaseId);
    if (negativeCredit.length > 0 && this.alerts)
      await this.alerts
        .raise({
          severity: 'critical',
          code: PREPAYMENT_SPLIT_ALERT,
          message:
            'A lease has more allocated to months not started than its prepayments (2010) hold',
          context: {
            companyId,
            leases: negativeCredit.length,
            first: negativeCredit.slice(0, 5).join(','),
          },
        })
        .catch(() => undefined);
    return {
      companyId,
      snapshotDate: today,
      month,
      leases: rows.length,
      computedAt,
      ...written,
      negativeCredit,
    };
  }

  /** Snapshot rows for a batch of leases, as the money card works them out (AR-02, AR-03, BC-08). */
  private async snapshotRows(
    tx: Tx,
    companyId: string,
    leaseIds: readonly string[],
    today: string,
  ): Promise<SnapshotRow[]> {
    // Each lease's prepayments (2010), split as the statement splits them: the one reader both
    // share, on the invoice basis, by accounting date up to today (founder decision, 2026-11-07).
    const splits = await prepaymentSplitAt(tx, { leaseIds, asOf: today });
    // The deposit each lease holds (2100), as BillingEngine.depositHeld reads it, in one query.
    const deposits = new Map(
      (await sumLines(tx, { accounts: ['2100'], leaseIds }, ['leaseId'])).map((r) => [
        r.leaseId!,
        0 - r.balanceMinor,
      ]),
    );
    const renewals = new Map(
      (
        await tx.execute<{ renews_lease_id: string; status: string }>(
          sql`select renews_lease_id, status from lease
              where renews_lease_id = any(${`{${leaseIds.join(',')}}`}::uuid[]) and status <> 'cancelled'`,
        )
      ).rows.map((r) => [r.renews_lease_id, r.status]),
    );
    const out: SnapshotRow[] = [];
    for (const leaseId of leaseIds) {
      const state = await this.engine.load(tx, companyId, leaseId);
      const walk = this.engine.walk(state);
      // Arrears as the statement counts them: 1100 past its due date, aged; months billed and
      // past due but not charged yet (an annual invoice's) kept apart, by their allocations.
      const arrears = ledgerArrears({
        lines: state.lines,
        allocations: state.allocations,
        asOf: today,
      });
      const split = splits.get(leaseId);
      const lease = state.lease;
      const occupying = OCCUPYING_STATUSES.includes(lease.status);
      // Decision 12: the rent roll counts the leases holding their unit today.
      const roll = occupying
        ? rentRoll(
            [
              {
                leaseId,
                startDate: lease.startDate,
                lastDay: null,
                monthlyRentMinor: lease.terms.monthlyRentMinor,
                steps: lease.terms.steps,
                serviceChargeMonthlyMinor: lease.terms.serviceChargeMonthlyMinor,
              },
            ],
            today,
          ).leases[0]
        : undefined;
      const row: SnapshotRow = {
        companyId,
        snapshotDate: today,
        leaseId,
        propertyId: lease.propertyId,
        unitId: lease.unitId,
        ownerId: state.book.kind === 'book' ? state.book.ownerId : null,
        leaseStatus: lease.status,
        occupying,
        endDate: lease.endDate,
        renewalStatus: renewals.get(leaseId) ?? null,
        paidUntil: walk.paidUntil,
        monthsPaidAhead: monthsPaidAhead(walk, today),
        unearnedRentMinor: split?.unearnedRentMinor ?? 0,
        unearnedServiceChargeMinor: split?.unearnedServiceChargeMinor ?? 0,
        creditMinor: split?.creditMinor ?? 0,
        dueNotStartedMinor: arrears.dueNotStartedMinor,
        depositHeldMinor: deposits.get(leaseId) ?? 0,
        rentMinor: roll?.rentMinor ?? 0,
        serviceChargeMinor: roll?.serviceChargeMinor ?? 0,
        computedAt: new Date(0),
      };
      for (const bucket of AGE_BUCKETS)
        (row as Record<string, unknown>)[BUCKET_COLUMN[bucket]] = arrears.byBucket[bucket];
      out.push(row);
    }
    return out;
  }
}
