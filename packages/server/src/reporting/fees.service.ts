import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import {
  creditDrawFee,
  creditDrawFeeLines,
  feeOnBaseMinor,
  feeTermsOn,
  FEE_BEARING_KINDS,
  fixedFeesForMonth,
  managementFeeKeys,
  managementFeeLines,
  managementFeeReversalLines,
  percentageFee,
  refundedFeeBaseMinor,
  refundFeeReversalMinor,
  type FeeBasePart,
  type FeeDimensions,
  type FeeTerms,
  type FeeTermsVersion,
  type JournalLineDraft,
  type PaymentAmount,
} from '@rent/domain/ledger';
import type { LineKind } from '@rent/domain/billing';
import type { AlertPort } from '@rent/integrations';
import {
  BillingEngine,
  type FeeHooks,
  type LeaseState,
  type SettledEvent,
} from '../billing/engine';
import { dimsOf, type PaymentRecord } from '../billing/records';
import { companyRecord } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { ALERT_PORT, CLOCK, DATABASE } from '../core/tokens';
import { ownerBook } from '../ledger/ledger.queries';
import { PostingService } from '../ledger/posting.service';
import { ownersOn } from '../portfolio/ownership';

type FeeRow = typeof schema.managementFee.$inferSelect;

/** The fee terms a version row holds. */
export function termsOfRow(row: typeof schema.managementFeeTerms.$inferSelect): FeeTerms {
  return row.kind === 'percentage'
    ? { kind: 'percentage', rateBps: row.rateBps! }
    : row.kind === 'fixed_per_unit'
      ? { kind: 'fixed_per_unit', amountMinor: Number(row.fixedMinor) }
      : { kind: 'none' };
}

/** An owner's fee-term versions, oldest first (a later version of the same day wins). */
export async function feeTermsVersions(tx: Tx, ownerId: string): Promise<FeeTermsVersion[]> {
  const rows = await tx
    .select()
    .from(schema.managementFeeTerms)
    .where(eq(schema.managementFeeTerms.ownerId, ownerId))
    .orderBy(
      asc(schema.managementFeeTerms.effectiveFrom),
      asc(schema.managementFeeTerms.createdAt),
    );
  return rows.map((r) => ({ effectiveFrom: r.effectiveFrom, terms: termsOfRow(r) }));
}

/** The lease, the leases it renews and the leases that renew it, all the way along. */
async function renewalChain(tx: Tx, leaseId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(
    sql`with recursive up(id) as (
          select ${leaseId}::uuid
          union select l.renews_lease_id from lease l join up on l.id = up.id
                where l.renews_lease_id is not null),
        down(id) as (
          select ${leaseId}::uuid
          union select l.id from lease l join down on l.renews_lease_id = down.id)
        select id from up union select id from down`,
  );
  return rows.rows.map((r) => r.id).sort();
}

/** Rent and service charge settled by money (payments, deposits, withholding) on the chain's other leases. */
async function settledElsewhere(
  tx: Tx,
  chain: readonly string[],
  leaseId: string,
): Promise<number> {
  const others = chain.filter((id) => id !== leaseId);
  if (others.length === 0) return 0;
  const [row] = (
    await tx.execute<{ total: number }>(
      sql`select coalesce(sum(a.amount_minor), 0)::bigint as total from allocation a
          join invoice_line il on il.company_id = a.company_id and il.id = a.invoice_line_id
          where a.lease_id = any(${`{${others.join(',')}}`}::uuid[])
            and a.source in ('payment', 'deposit', 'withholding')
            and il.kind = any(${`{${FEE_BEARING_KINDS.join(',')}}`}::text[])`,
    )
  ).rows;
  return Math.max(0, Number(row?.total ?? 0));
}

export const FIXED_FEES_JOB = 'reporting.fixed-fees';
export const FEE_CHECK_JOB = 'reporting.fee-check';

/**
 * Management fees (P14; AC-02; M9 plan 4.2, decisions 1 to 3 and the founder's decision on drawn
 * surplus). Percentage fees post in the event's own transaction, through billing's fee hooks: on
 * the rent and service charge a receipt settles (advances included), credit drawn onto a month,
 * rent settled from a deposit, and tax withheld; never on deposits paid in, VAT, one-off charges or
 * surplus not yet drawn. A reversal mirrors them (P21b), a refund takes them back in proportion,
 * and a chargeback's deposit unwind takes back the deposit fee. Fixed fees post monthly. Each fee
 * is recorded in `management_fee` with its base, which the guard and the nightly check read. Only
 * an agency's owners pay fees; fees carry no VAT (OQ-60).
 */
@Injectable()
export class ManagementFeesService implements FeeHooks {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(BillingEngine) engine: BillingEngine,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
  ) {
    // As rent tax does: once constructed, every settlement in this engine is charged its fee.
    engine.useFeeHooks(this);
  }

  // Percentage fees on money settled ---------------------------------------------------------------

  async afterSettled(tx: Tx, state: LeaseState, event: SettledEvent): Promise<void> {
    if (state.company.kind !== 'agency' || state.book.kind !== 'book') return;
    const parts = event.parts.filter((p) => p.amountMinor > 0);
    if (parts.length === 0) return;
    const terms = feeTermsOn(await feeTermsVersions(tx, state.book.ownerId), event.valueDate);
    if (terms?.terms.kind !== 'percentage') return;
    const kinds = new Map(state.lines.map((l) => [l.id, l.kind as LineKind]));
    const bearing = parts.filter((p) => FEE_BEARING_KINDS.includes(kinds.get(p.lineId)!));
    // Across the renewal chain: credit a renewal carried over may have been charged on the old
    // lease (a credit note's release, say), so the guard counts both leases' money and fees.
    const chain = await renewalChain(tx, state.lease.id);
    const guard = {
      settledMinor: this.settled(state) + (await settledElsewhere(tx, chain, state.lease.id)),
      chargedBaseMinor: await this.chargedBase(tx, chain),
    };
    const dims: FeeDimensions = { ...dimsOf(state.lease), propertyId: state.lease.propertyId };
    const bookId = state.book.bookId;
    let lines: JournalLineDraft[];
    let rows: { paymentId: string | null; baseMinor: number; feeMinor: number }[];
    if (event.source === 'credit_draw') {
      const byPayment = new Map<string, number>();
      for (const p of bearing)
        if (p.paymentId)
          byPayment.set(p.paymentId, (byPayment.get(p.paymentId) ?? 0) + p.amountMinor);
      const draws: PaymentAmount[] = [...byPayment].map(([paymentId, amountMinor]) => ({
        paymentId,
        amountMinor,
      }));
      // Rent and service charge bear the same rate, so the draw is charged as one base.
      const fee = creditDrawFee({ terms: terms.terms, kind: 'rent', draws, guard });
      if (!fee || fee.feeMinor === 0) return;
      lines = creditDrawFeeLines({ bookId, dims, fee });
      rows = fee.shares.map((s) => ({
        paymentId: s.paymentId,
        baseMinor: s.baseMinor,
        feeMinor: s.feeMinor,
      }));
    } else {
      const feeParts: FeeBasePart[] = bearing.map((p) => ({
        kind: kinds.get(p.lineId)!,
        source: event.source as Exclude<SettledEvent['source'], 'credit_draw'>,
        amountMinor: p.amountMinor,
      }));
      const fee = percentageFee({ terms: terms.terms, parts: feeParts, guard });
      if (!fee || fee.feeMinor === 0) return;
      const paymentId = event.source === 'payment' ? (parts[0]!.paymentId ?? null) : null;
      lines = managementFeeLines({
        bookId,
        dims: { ...dims, paymentId },
        amountMinor: fee.feeMinor,
      });
      rows = [{ paymentId, baseMinor: fee.baseMinor, feeMinor: fee.feeMinor }];
    }
    const posted = await this.posting.post(tx, {
      companyId: state.company.id,
      rule: 'P14',
      key: event.key,
      valueDate: event.valueDate,
      lines,
      record: { type: event.recordType, id: event.recordId },
      causedBy: event.causedBy,
    });
    if (!posted || posted.replayed) return;
    await tx.insert(schema.managementFee).values(
      rows.map((r) => ({
        companyId: state.company.id,
        ownerId: state.book.kind === 'book' ? state.book.ownerId : '',
        bookId,
        propertyId: state.lease.propertyId,
        unitId: state.lease.unitId,
        leaseId: state.lease.id,
        paymentId: r.paymentId,
        key: event.key,
        source: event.source,
        rateBps: terms.terms.kind === 'percentage' ? terms.terms.rateBps : null,
        baseMinor: r.baseMinor,
        feeMinor: r.feeMinor,
        valueDate: event.valueDate,
        entryId: posted.entryId,
      })),
    );
  }

  /** Rent and service charge settled on the lease by payments, deposits and withholding, net. */
  private settled(state: LeaseState): number {
    const kinds = new Map(state.lines.map((l) => [l.id, l.kind as LineKind]));
    let total = 0;
    for (const a of state.allocations)
      if (
        FEE_BEARING_KINDS.includes(kinds.get(a.lineId)!) &&
        (a.source === 'payment' || a.source === 'deposit' || a.source === 'withholding')
      )
        total += a.amountMinor;
    return Math.max(0, total);
  }

  /** The base the chain's fees already cover, net of take-backs (the guard). */
  private async chargedBase(tx: Tx, chain: readonly string[]): Promise<number> {
    const [row] = (
      await tx.execute<{ total: number }>(
        sql`select coalesce(sum(base_minor), 0)::bigint as total from management_fee
            where lease_id = any(${`{${chain.join(',')}}`}::uuid[]) and source <> 'fixed'`,
      )
    ).rows;
    return Math.max(0, Number(row?.total ?? 0));
  }

  // Take-backs -----------------------------------------------------------------------------------

  /** What is left of each fee: the original row, its base and fee net of every take-back. */
  private async remaining(tx: Tx, where: ReturnType<typeof sql>) {
    const originals = (
      await tx.execute<FeeRow & { left_base: number; left_fee: number; taken_base: number }>(
        sql`select f.*, f.base_minor + coalesce(t.base, 0) as left_base, f.fee_minor + coalesce(t.fee, 0) as left_fee,
              -coalesce(t.base, 0) as taken_base
            from management_fee f
            left join (select reverses_fee_id, sum(base_minor)::bigint as base, sum(fee_minor)::bigint as fee
                       from management_fee where reverses_fee_id is not null group by 1) t on t.reverses_fee_id = f.id
            where f.reverses_fee_id is null and ${where}`,
      )
    ).rows;
    return originals.map((r) => ({
      id: String((r as unknown as { id: string }).id),
      ownerId: String((r as unknown as { owner_id: string }).owner_id),
      bookId: String((r as unknown as { book_id: string }).book_id),
      propertyId: String((r as unknown as { property_id: string }).property_id),
      unitId: (r as unknown as { unit_id: string | null }).unit_id,
      leaseId: (r as unknown as { lease_id: string | null }).lease_id,
      paymentId: (r as unknown as { payment_id: string | null }).payment_id,
      source: String((r as unknown as { source: string }).source),
      rateBps: (r as unknown as { rate_bps: number | null }).rate_bps,
      baseMinor: Number((r as unknown as { base_minor: number }).base_minor),
      feeMinor: Number((r as unknown as { fee_minor: number }).fee_minor),
      leftBase: Number(r.left_base),
      leftFee: Number(r.left_fee),
      takenBase: Number(r.taken_base),
    }));
  }

  private async takeBack(
    tx: Tx,
    companyId: string,
    input: {
      key: string;
      source: 'reversal' | 'refund' | 'unwind';
      valueDate: string;
      record: { type: string; id: string };
      causedBy: string | null;
      parts: {
        fee: Awaited<ReturnType<ManagementFeesService['remaining']>>[number];
        baseMinor: number;
        feeMinor: number;
      }[];
    },
  ): Promise<void> {
    const parts = input.parts.filter((p) => p.feeMinor > 0);
    if (parts.length === 0) return;
    const lines = parts.flatMap((p) =>
      managementFeeReversalLines({
        bookId: p.fee.bookId,
        dims: {
          propertyId: p.fee.propertyId,
          unitId: p.fee.unitId ?? undefined,
          leaseId: p.fee.leaseId ?? undefined,
          paymentId: p.fee.paymentId ?? undefined,
        } as FeeDimensions,
        amountMinor: p.feeMinor,
      }),
    );
    const posted = await this.posting.post(tx, {
      companyId,
      rule: input.source === 'reversal' ? 'P21' : 'P14',
      key: input.key,
      valueDate: input.valueDate,
      lines,
      record: input.record,
      causedBy: input.causedBy,
    });
    if (!posted || posted.replayed) return;
    await tx.insert(schema.managementFee).values(
      parts.map((p) => ({
        companyId,
        ownerId: p.fee.ownerId,
        bookId: p.fee.bookId,
        propertyId: p.fee.propertyId,
        unitId: p.fee.unitId,
        leaseId: p.fee.leaseId,
        paymentId: p.fee.paymentId,
        key: `${input.key}#${p.fee.id}`,
        source: input.source,
        reversesFeeId: p.fee.id,
        rateBps: p.fee.rateBps,
        baseMinor: -p.baseMinor,
        feeMinor: -p.feeMinor,
        valueDate: input.valueDate,
        entryId: posted.entryId,
      })),
    );
  }

  /** P21b mirrors what is left of the payment's fees: on its receipt and on its credit drawn. */
  async afterReversal(
    tx: Tx,
    states: readonly LeaseState[],
    payment: PaymentRecord,
    reversal: {
      readonly reversalId: string;
      readonly valueDate: string;
      readonly causedBy: string | null;
    },
  ): Promise<void> {
    const fees = await this.remaining(tx, sql`f.payment_id = ${payment.id}::uuid`);
    await this.takeBack(tx, payment.row.companyId, {
      key: managementFeeKeys.paymentReversal(payment.id),
      source: 'reversal',
      valueDate: reversal.valueDate,
      record: { type: 'payment_reversal', id: reversal.reversalId },
      causedBy: reversal.causedBy,
      parts: fees.map((fee) => ({ fee, baseMinor: fee.leftBase, feeMinor: fee.leftFee })),
    });
    void states;
  }

  /** A refund of a receipt's credit takes back the fee on the base it returns (decision 3). */
  async afterRefund(
    tx: Tx,
    state: LeaseState,
    refund: {
      readonly refundId: string;
      readonly valueDate: string;
      readonly causedBy: string | null;
      readonly credits: readonly PaymentAmount[];
    },
  ): Promise<void> {
    const kinds = new Map(state.lines.map((l) => [l.id, l.kind as LineKind]));
    for (const credit of refund.credits) {
      const [fee] = await this.remaining(
        tx,
        sql`f.payment_id = ${credit.paymentId}::uuid and f.lease_id = ${state.lease.id}::uuid and f.source = 'payment'`,
      );
      if (!fee || fee.leftFee <= 0) continue;
      let kept = 0;
      for (const a of state.allocations)
        if (
          a.paymentId === credit.paymentId &&
          a.source === 'payment' &&
          FEE_BEARING_KINDS.includes(kinds.get(a.lineId)!)
        )
          kept += a.amountMinor;
      const base = refundedFeeBaseMinor({
        baseMinor: fee.baseMinor,
        keptBaseMinor: Math.max(0, kept),
        refundedBaseBeforeMinor: fee.takenBase,
        refundMinor: credit.amountMinor,
      });
      const amount = refundFeeReversalMinor({
        feeMinor: fee.feeMinor,
        baseMinor: fee.baseMinor,
        refundedBaseBeforeMinor: fee.takenBase,
        refundedBaseMinor: base,
      });
      await this.takeBack(tx, state.company.id, {
        key: managementFeeKeys.refund(refund.refundId, credit.paymentId),
        source: 'refund',
        valueDate: refund.valueDate,
        record: { type: 'refund', id: refund.refundId },
        causedBy: refund.causedBy,
        parts: [{ fee, baseMinor: base, feeMinor: amount }],
      });
    }
  }

  /** A chargeback took back a deposit share: the fee on the rent it had settled follows it. */
  async afterDepositUnwound(
    tx: Tx,
    state: LeaseState,
    unwound: {
      readonly moveOutId: string;
      readonly paymentId: string;
      readonly appliedMinor: number;
      readonly reversalId: string;
      readonly valueDate: string;
      readonly causedBy: string | null;
    },
  ): Promise<void> {
    const [fee] = await this.remaining(
      tx,
      sql`f.key = ${managementFeeKeys.event(unwound.moveOutId)} and f.source = 'deposit'`,
    );
    if (!fee || fee.leftFee <= 0) return;
    const base = Math.min(unwound.appliedMinor, fee.baseMinor - fee.takenBase);
    const amount = refundFeeReversalMinor({
      feeMinor: fee.feeMinor,
      baseMinor: fee.baseMinor,
      refundedBaseBeforeMinor: fee.takenBase,
      refundedBaseMinor: base,
    });
    await this.takeBack(tx, state.company.id, {
      key: `P14:${unwound.moveOutId}:${unwound.paymentId}:unwind`,
      source: 'unwind',
      valueDate: unwound.valueDate,
      record: { type: 'payment_reversal', id: unwound.reversalId },
      causedBy: unwound.causedBy,
      parts: [{ fee, baseMinor: base, feeMinor: amount }],
    });
  }

  // Fixed fees, monthly (`reporting.fixed-fees`) ------------------------------------------------

  /**
   * P14 fixed fees for a month, for every agency-managed owner whose terms on its last day are a
   * fixed fee per unit: once per unit billable that month (D8). Idempotent by key.
   */
  async runFixedFees(companyId: string, month: string): Promise<number> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const company = await companyRecord(tx, companyId);
      if (company?.kind !== 'agency') return 0;
      const first = parseBusinessDate(`${month}-01`);
      const last = toIsoDate(addDays(addMonths(first, 1), -1));
      const owners = await tx
        .selectDistinct({ ownerId: schema.managementFeeTerms.ownerId })
        .from(schema.managementFeeTerms);
      let posted = 0;
      for (const { ownerId } of owners) {
        const versions = await feeTermsVersions(tx, ownerId);
        if (feeTermsOn(versions, last)?.terms.kind !== 'fixed_per_unit') continue;
        const bookId = await ownerBook(tx, ownerId);
        if (!bookId) continue;
        // The owner's units on the month's last day (sole ownership, as fees post on one book).
        const properties = await tx.select({ id: schema.property.id }).from(schema.property);
        const owned: string[] = [];
        for (const p of properties) {
          const holders = await ownersOn(tx, p.id, last);
          if (holders.length === 1 && holders[0]!.ownerId === ownerId) owned.push(p.id);
        }
        if (owned.length === 0) continue;
        const units = (
          await tx.execute<{ property_id: string; unit_id: string }>(
            sql`select u.property_id, u.id as unit_id from unit u
                where u.property_id = any(${`{${owned.join(',')}}`}::uuid[])`,
          )
        ).rows;
        const leases = (
          await tx.execute<{ unit_id: string; start_date: string; last_day: string | null }>(
            sql`select l.unit_id, l.start_date::text, coalesce(l.move_out_date, l.ended_on)::text as last_day
                from lease l where l.unit_id = any(${`{${units.map((u) => u.unit_id).join(',')}}`}::uuid[])
                  and l.status in ('active', 'ending', 'holding_over', 'ended', 'terminated')`,
          )
        ).rows;
        const fees = fixedFeesForMonth({
          ownerId,
          month,
          versions,
          units: units.map((u) => ({
            propertyId: u.property_id,
            unitId: u.unit_id,
            leases: leases
              .filter((l) => l.unit_id === u.unit_id)
              .map((l) => ({ startDate: l.start_date, lastDay: l.last_day })),
          })),
        });
        for (const fee of fees) {
          const entry = await this.posting.post(tx, {
            companyId,
            rule: 'P14',
            key: fee.key,
            valueDate: last,
            lines: managementFeeLines({
              bookId,
              dims: { propertyId: fee.propertyId, unitId: fee.unitId },
              amountMinor: fee.amountMinor,
            }),
            record: { type: 'owner', id: ownerId },
            causedBy: null,
          });
          if (!entry || entry.replayed) continue;
          await tx.insert(schema.managementFee).values({
            companyId,
            ownerId,
            bookId,
            propertyId: fee.propertyId,
            unitId: fee.unitId,
            key: fee.key,
            source: 'fixed',
            baseMinor: 0,
            feeMinor: fee.amountMinor,
            valueDate: last,
            entryId: entry.entryId,
          });
          posted += 1;
        }
      }
      return posted;
    });
  }

  // The nightly check (plan risk 1) ------------------------------------------------------------

  /**
   * Fees equal rate × base per receipt: each percentage fee's rows (a credit draw's shares added
   * together) equal the rate on their base, rounded once, and 5100 for the fee's entry equals the
   * rows. Mismatches raise an alert.
   */
  async check(companyId: string, options: { alert?: boolean } = {}) {
    const mismatches = await withCompany(
      this.database,
      { companyId, actorKind: 'system' },
      async (tx) => {
        const groups = (
          await tx.execute<{
            key: string;
            rate_bps: number;
            base: number;
            fee: number;
            ledger: number;
          }>(
            sql`select f.key, max(f.rate_bps) as rate_bps, sum(f.base_minor)::bigint as base, sum(f.fee_minor)::bigint as fee,
                  (select coalesce(sum(l.amount_minor), 0)::bigint from journal_line l
                   where l.company_id = f.company_id and l.account_code = '5100'
                     and l.entry_id = any(array_agg(f.entry_id))) as ledger
                from management_fee f where f.reverses_fee_id is null and f.source <> 'fixed'
                group by f.company_id, f.key`,
          )
        ).rows;
        const out: { key: string; expectedMinor: number; actualMinor: number }[] = [];
        for (const g of groups) {
          const expected = feeOnBaseMinor(Number(g.base), Number(g.rate_bps));
          if (expected !== Number(g.fee) || Number(g.ledger) !== Number(g.fee))
            out.push({ key: g.key, expectedMinor: expected, actualMinor: Number(g.fee) });
        }
        return out;
      },
    );
    if (mismatches.length > 0 && options.alert !== false)
      await this.alerts
        .raise({
          severity: 'critical',
          code: 'reporting.fee_mismatch',
          message: 'A management fee does not equal its rate on its base',
          context: {
            companyId,
            keys: mismatches
              .map((m) => m.key)
              .slice(0, 20)
              .join(','),
          },
        })
        .catch(() => undefined);
    return { mismatches };
  }

  /** The month whose fixed fees run today: today's month on its last day, else none. */
  /**
   * The monthly run (`reporting.fixed-fees`): on the company's last day of a month, that month's
   * fixed fees; on the 1st, last month's again, so a run the company's time zone put past midnight
   * (a London owner in summer) or one that failed still posts. Keys make the repeat a no-op.
   */
  async runMonthEnd(companyId: string): Promise<{ months: string[]; posted: number }> {
    const today = await this.todayFor(companyId);
    const months: string[] = [];
    const ending = this.monthEndingOn(today);
    if (ending) months.push(ending);
    if (today.endsWith('-01'))
      months.push(toIsoDate(addMonths(parseBusinessDate(today), -1)).slice(0, 7));
    let posted = 0;
    for (const month of months) posted += await this.runFixedFees(companyId, month);
    return { months, posted };
  }

  monthEndingOn(today: string): string | null {
    const next = toIsoDate(addDays(parseBusinessDate(today), 1));
    return next.endsWith('-01') ? today.slice(0, 7) : null;
  }

  /** Today for the company (the job's date). */
  async todayFor(companyId: string): Promise<string> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const company = await companyRecord(tx, companyId);
      const zone = company?.timeZone ?? 'Africa/Accra';
      return toIsoDate(businessDateOf(instantFrom(this.clock.now()), zone));
    });
  }
}

export type { FeeRow };
