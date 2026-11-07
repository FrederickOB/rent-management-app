import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  schema,
  sql,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import {
  chargeAllocations,
  feeBearing,
  feeOnBaseMinor,
  feeTermsOn,
  fixedFeesForMonth,
  managementFeeLines,
  managementFeeReversalLines,
  takeBacks,
  undoings,
  type ChargedAllocation,
  type FeeAllocation,
  type FeeDimensions,
  type FeeTakeBack,
  type FeeTerms,
  type FeeTermsVersion,
  type JournalLineDraft,
  type PaymentCharge,
} from '@rent/domain/ledger';
import type { AllocationSource, LineKind } from '@rent/domain/billing';
import type { AlertPort } from '@rent/integrations';
import {
  BillingEngine,
  type AllocationWrite,
  type FeeHooks,
  type LeaseState,
} from '../billing/engine';
import { dimsOf } from '../billing/records';
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

type AllocationRow = typeof schema.allocation.$inferSelect;

export interface FeeMismatch {
  readonly key: string;
  readonly expectedMinor: number;
  readonly actualMinor: number;
  readonly problems: string[];
}

const feeAllocationOf = (
  r: Pick<AllocationRow, 'id' | 'invoiceLineId' | 'source' | 'paymentId' | 'amountMinor'>,
  kinds: ReadonlyMap<string, LineKind>,
): FeeAllocation => ({
  id: r.id,
  lineId: r.invoiceLineId,
  lineKind: kinds.get(r.invoiceLineId) ?? ('one_off' as LineKind),
  source: r.source as AllocationSource,
  paymentId: r.paymentId,
  amountMinor: Number(r.amountMinor),
});

/** A charged allocation as stored, with its event row and what was taken back so far. */
interface StoredCharge extends ChargedAllocation {
  readonly managementFeeId: string | null;
  readonly rateBps: number;
  readonly source: string;
  readonly paymentId: string | null;
  readonly propertyId: string;
  readonly unitId: string | null;
  readonly leaseId: string | null;
}

async function storedCharges(tx: Tx, allocationIds: readonly string[]): Promise<StoredCharge[]> {
  const rows = await tx.execute<{
    allocation_id: string;
    management_fee_id: string | null;
    rate_bps: number;
    base: string;
    fee: string;
    taken_base: string;
    taken_fee: string;
    source: string | null;
    payment_id: string | null;
    property_id: string;
    unit_id: string | null;
    lease_id: string;
  }>(
    sql`select c.allocation_id, c.management_fee_id, c.rate_bps, c.base_minor::text as base,
          c.fee_minor::text as fee,
          coalesce((select -sum(t.base_minor) from allocation_fee t
                    where t.company_id = c.company_id and t.charged_allocation_id = c.allocation_id), 0)::text as taken_base,
          coalesce((select -sum(t.fee_minor) from allocation_fee t
                    where t.company_id = c.company_id and t.charged_allocation_id = c.allocation_id), 0)::text as taken_fee,
          f.source, c.payment_id, c.property_id, f.unit_id, c.lease_id
        from allocation_fee c
        left join management_fee f on f.company_id = c.company_id and f.id = c.management_fee_id
        where c.charged_allocation_id is null
          and c.allocation_id = any(${`{${allocationIds.join(',')}}`}::uuid[])`,
  );
  return rows.rows.map((r) => ({
    allocationId: r.allocation_id,
    managementFeeId: r.management_fee_id,
    rateBps: Number(r.rate_bps),
    baseMinor: Number(r.base),
    feeMinor: Number(r.fee),
    takenBaseMinor: Number(r.taken_base),
    takenFeeMinor: Number(r.taken_fee),
    source: r.source ?? 'payment',
    paymentId: r.payment_id,
    propertyId: r.property_id,
    unitId: r.unit_id,
    leaseId: r.lease_id,
  }));
}

async function entryKeyOf(tx: Tx, entryId: string): Promise<string | null> {
  const [row] = await tx
    .select({ key: schema.journalEntry.idempotencyKey })
    .from(schema.journalEntry)
    .where(eq(schema.journalEntry.id, entryId));
  return row?.key ?? null;
}

/** What a charge is called: money received, credit drawn onto a month, a deposit, withholding. */
function chargeSource(a: FeeAllocation, write: AllocationWrite): string {
  if (a.source === 'deposit') return 'deposit';
  if (a.source === 'withholding') return 'withholding';
  return write.recordType === 'payment' || write.recordType === 'match' ? 'payment' : 'credit_draw';
}

/**
 * A charge's key: `P14:<payment>` for money received or matched, `P14:<record>` for a deposit
 * applied or tax withheld, and `P14:<draw entry key>` for credit drawn (`P14:P02:<line>`, a redraw's
 * `P14:P02:<line>:redraw:<n>`, P13's `P14:P13:…`).
 */
function chargeKey(write: AllocationWrite, entryKey: string | null, paymentId: string | null) {
  if ((write.recordType === 'payment' || write.recordType === 'match') && paymentId)
    return `P14:${paymentId}`;
  if (write.recordType === 'withholding' || write.recordType === 'move_out')
    return entryKey && !entryKey.startsWith('P11') && write.recordType === 'move_out'
      ? `P14:${entryKey}`
      : `P14:${write.recordId}`;
  return entryKey ? `P14:${entryKey}` : `P14:${write.recordType}:${write.recordId}`;
}

/** A take-back's key: the P21 mirror `P21:<payment>:fee`, a deposit unwind, or a release. */
function takeBackKey(source: string, write: AllocationWrite, paymentId: string | null) {
  if (source === 'reversal' && paymentId) return `P21:${paymentId}:fee`;
  if (source === 'unwind') return `P14:unwind:${write.recordId}`;
  return `P14:release:${write.recordType}:${write.recordId}`;
}

/** Keys are unique per company and payment: a second fee under the same key gets `:2`, `:3`… */
async function uniqueFeeKey(tx: Tx, key: string, paymentId: string | null): Promise<string> {
  const taken = await tx
    .select({ key: schema.managementFee.key })
    .from(schema.managementFee)
    .where(
      and(
        sql`${schema.managementFee.key} like ${`${key}%`}`,
        paymentId
          ? eq(schema.managementFee.paymentId, paymentId)
          : isNull(schema.managementFee.paymentId),
      ),
    );
  const used = new Set(taken.map((t) => t.key));
  if (!used.has(key)) return key;
  for (let n = 2; ; n += 1) if (!used.has(`${key}:${n}`)) return `${key}:${n}`;
}

export const FIXED_FEES_JOB = 'reporting.fixed-fees';
export const FEE_CHECK_JOB = 'reporting.fee-check';

/**
 * Management fees (P14; AC-02; M9 plan 4.2, decisions 1 to 3, and the M9 review's must-fix 1).
 * Percentage fees follow the allocations: every rent or service-charge allocation of money (a
 * payment, its credit drawn onto a month, a deposit applied, tax withheld) carries its fee at the
 * rate in force on its value date, in the transaction that writes it, and a negative allocation (a
 * reversal, a release, a chargeback's deposit unwind) takes back the fee of what it undoes, in
 * proportion and mirrored exactly (`@rent/domain/ledger` allocation-fees). Each allocation's share
 * is in `allocation_fee`; `management_fee` holds the posted totals per event and payment, which
 * statements, the nightly check and the screens read. Fixed fees post monthly. Only an agency's
 * owners pay fees; fees carry no VAT (OQ-60).
 */
@Injectable()
export class ManagementFeesService implements FeeHooks {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
  ) {
    // As rent tax does: once constructed, every allocation in this engine carries its fee.
    engine.useFeeHooks(this);
  }

  // Percentage fees on allocations -------------------------------------------------------------

  async afterAllocations(
    tx: Tx,
    state: LeaseState,
    rows: readonly AllocationRow[],
    write: AllocationWrite,
  ): Promise<void> {
    if (state.company.kind !== 'agency' || rows.length === 0) return;
    const kinds = await this.lineKinds(
      tx,
      state,
      rows.map((r) => r.invoiceLineId),
    );
    const fee = rows
      .map((r) => ({ row: r, alloc: feeAllocationOf(r, kinds) }))
      .filter((x) => feeBearing(x.alloc));
    if (fee.length === 0) return;
    const byLease = new Map<string, typeof fee>();
    for (const f of fee) byLease.set(f.row.leaseId, [...(byLease.get(f.row.leaseId) ?? []), f]);
    for (const [leaseId, leaseRows] of byLease) {
      const leaseState =
        leaseId === state.lease.id ? state : await this.engine.load(tx, state.company.id, leaseId);
      if (leaseState.book.kind !== 'book') continue;
      await this.feesFor(tx, leaseState, leaseRows, kinds, write);
    }
  }

  private async lineKinds(
    tx: Tx,
    state: LeaseState,
    lineIds: readonly string[],
  ): Promise<Map<string, LineKind>> {
    const kinds = new Map(state.lines.map((l) => [l.id, l.kind as LineKind]));
    const missing = [...new Set(lineIds)].filter((id) => !kinds.has(id));
    if (missing.length > 0) {
      const found = await tx
        .select({ id: schema.invoiceLine.id, kind: schema.invoiceLine.kind })
        .from(schema.invoiceLine)
        .where(inArray(schema.invoiceLine.id, missing));
      for (const f of found) kinds.set(f.id, f.kind as LineKind);
    }
    return kinds;
  }

  private async feesFor(
    tx: Tx,
    state: LeaseState,
    rows: readonly { row: AllocationRow; alloc: FeeAllocation }[],
    kinds: Map<string, LineKind>,
    write: AllocationWrite,
  ): Promise<void> {
    if (state.book.kind !== 'book') return;
    const { ownerId, bookId } = state.book;
    const companyId = state.company.id;
    const positives = rows.filter((r) => r.alloc.amountMinor > 0).map((r) => r.alloc);
    const negatives = rows.filter((r) => r.alloc.amountMinor < 0).map((r) => r.alloc);

    // Charges: the rate in force on the allocations' value date (none before the terms began).
    let charges: PaymentCharge[] = [];
    if (positives.length > 0) {
      const terms = feeTermsOn(await feeTermsVersions(tx, ownerId), write.valueDate);
      if (terms?.terms.kind === 'percentage')
        charges = chargeAllocations(positives, terms.terms.rateBps);
    }

    // Take-backs: what each negative allocation undoes, latest first, and the fee it carried.
    let backs: FeeTakeBack[] = [];
    const charged = new Map<string, StoredCharge>();
    if (negatives.length > 0) {
      const lineIds = [...new Set(negatives.map((n) => n.lineId))];
      const history = (
        await tx
          .select()
          .from(schema.allocation)
          .where(inArray(schema.allocation.invoiceLineId, lineIds))
          .orderBy(asc(schema.allocation.createdAt), asc(schema.allocation.id))
      ).map((r) => feeAllocationOf(r, kinds));
      const undone = undoings(history, new Set(negatives.map((n) => n.id)));
      const ids = [...new Set(undone.map((u) => u.undoesId))];
      if (ids.length > 0) {
        for (const c of await storedCharges(tx, ids)) charged.set(c.allocationId, c);
        backs = takeBacks(undone, charged);
      }
    }
    if (charges.length === 0 && backs.length === 0) return;

    // One entry for the write: Dr 5100, Cr 2300 per charge; the reverse per fee taken back.
    const leaseDims = dimsOf(state.lease);
    const dims = (paymentId: string | null): FeeDimensions => ({
      ...leaseDims,
      propertyId: state.lease.propertyId,
      ...(paymentId ? { paymentId } : {}),
    });
    const groups = new Map<string, { charge: StoredCharge; base: number; fee: number }[]>();
    for (const b of backs) {
      const c = charged.get(b.chargedAllocationId)!;
      const key = c.managementFeeId ?? '';
      groups.set(key, [
        ...(groups.get(key) ?? []),
        { charge: c, base: b.baseMinor, fee: b.feeMinor },
      ]);
    }
    const lines: JournalLineDraft[] = [
      ...charges.flatMap((c) =>
        managementFeeLines({ bookId, dims: dims(c.paymentId), amountMinor: c.feeMinor }),
      ),
      ...[...groups.values()].flatMap((g) =>
        managementFeeReversalLines({
          bookId,
          dims: dims(g[0]!.charge.paymentId),
          amountMinor: g.reduce((s, x) => s + x.fee, 0),
        }),
      ),
    ];
    const posted =
      lines.length === 0
        ? null
        : await this.posting.post(tx, {
            companyId,
            rule: write.recordType === 'reversal' && charges.length === 0 ? 'P21' : 'P14',
            key: `P14:alloc:${rows[0]!.alloc.id}`,
            valueDate: write.valueDate,
            lines,
            record: { type: write.recordType, id: write.recordId },
            causedBy: write.causedBy,
          });
    if (posted?.replayed) return;
    const entryKey = write.entryId ? await entryKeyOf(tx, write.entryId) : null;

    // The posted totals, per event and payment, and each allocation's share.
    for (const c of charges) {
      const source = chargeSource(
        rows.find((r) => r.alloc.id === c.parts[0]!.allocationId)!.alloc,
        write,
      );
      const managementFeeId = posted
        ? await this.insertFee(tx, {
            companyId,
            ownerId,
            bookId,
            propertyId: state.lease.propertyId,
            unitId: state.lease.unitId,
            leaseId: state.lease.id,
            paymentId: c.paymentId,
            key: await uniqueFeeKey(tx, chargeKey(write, entryKey, c.paymentId), c.paymentId),
            source,
            rateBps: c.rateBps,
            baseMinor: c.baseMinor,
            feeMinor: c.feeMinor,
            valueDate: write.valueDate,
            entryId: posted.entryId,
          })
        : null;
      await tx.insert(schema.allocationFee).values(
        c.parts.map((p) => {
          const row = rows.find((r) => r.alloc.id === p.allocationId)!.row;
          return {
            companyId,
            managementFeeId,
            ownerId,
            propertyId: row.propertyId,
            allocationId: p.allocationId,
            leaseId: row.leaseId,
            invoiceLineId: row.invoiceLineId,
            paymentId: row.paymentId,
            rateBps: c.rateBps,
            baseMinor: p.baseMinor,
            feeMinor: p.feeMinor,
          };
        }),
      );
    }
    for (const [feeId, g] of groups) {
      const fee = g.reduce((s, x) => s + x.fee, 0);
      const base = g.reduce((s, x) => s + x.base, 0);
      const first = g[0]!.charge;
      const source =
        write.recordType === 'reversal'
          ? first.source === 'deposit'
            ? 'unwind'
            : 'reversal'
          : 'refund';
      const managementFeeId =
        posted && feeId && fee > 0
          ? await this.insertFee(tx, {
              companyId,
              ownerId,
              bookId,
              propertyId: first.propertyId,
              unitId: first.unitId,
              leaseId: first.leaseId,
              paymentId: first.paymentId,
              key: await uniqueFeeKey(
                tx,
                `${takeBackKey(source, write, first.paymentId)}#${feeId}`,
                first.paymentId,
              ),
              source,
              reversesFeeId: feeId,
              rateBps: first.rateBps,
              baseMinor: -base,
              feeMinor: -fee,
              valueDate: write.valueDate,
              entryId: posted.entryId,
            })
          : null;
      await tx.insert(schema.allocationFee).values(
        backs
          .filter((b) => (charged.get(b.chargedAllocationId)!.managementFeeId ?? '') === feeId)
          .map((b) => {
            const neg = rows.find((r) => r.alloc.id === b.allocationId)!.row;
            const c = charged.get(b.chargedAllocationId)!;
            return {
              companyId,
              managementFeeId,
              ownerId,
              propertyId: neg.propertyId,
              allocationId: b.allocationId,
              chargedAllocationId: b.chargedAllocationId,
              leaseId: neg.leaseId,
              invoiceLineId: neg.invoiceLineId,
              paymentId: neg.paymentId,
              rateBps: c.rateBps,
              baseMinor: -b.baseMinor,
              feeMinor: -b.feeMinor,
            };
          }),
      );
    }
  }

  private async insertFee(
    tx: Tx,
    values: typeof schema.managementFee.$inferInsert,
  ): Promise<string> {
    const [row] = await tx
      .insert(schema.managementFee)
      .values(values)
      .returning({ id: schema.managementFee.id });
    return row!.id;
  }

  // Fixed fees, monthly (`reporting.fixed-fees`) ------------------------------------------------

  /**
   * P14 fixed fees for a month, for every agency-managed owner whose terms on its last day are a
   * fixed fee per unit: once per unit billable that month (D8). Idempotent by key.
   * - A property the owner shares carries none (it shows on the fee terms as co-owned).
   * - A property sold during the month: the owner on its last day is charged; the seller is not.
   * - A month that began under percentage terms carries no fixed fee.
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
        // A month that began under percentage terms was charged per allocation until the switch:
        // the fixed fee starts the month after, never both in one month (M9 review).
        const firstDay = toIsoDate(first);
        const days = [
          firstDay,
          ...versions.map((v) => v.effectiveFrom).filter((d) => d > firstDay && d <= last),
        ];
        if (days.some((d) => feeTermsOn(versions, d)?.terms.kind === 'percentage')) continue;
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

  // The nightly check (plan risk 1; M9 review must-fix 1) --------------------------------------

  /**
   * `reporting.fee-check`, for a company. Any difference raises one critical alert:
   * - each percentage fee posted equals its rate on its base, rounded once;
   * - each posted fee equals its allocations' shares (`allocation_fee`);
   * - no charged allocation has more taken back than it carried;
   * - each owner book's 5100 equals its fee records (take-backs and fixed fees included);
   * - per lease, the base charged and still live equals the rent and service charge settled by
   *   money since the terms began, net of what was undone (replayed from the allocations).
   */
  async check(companyId: string, options: { alert?: boolean } = {}) {
    const mismatches = await withCompany(
      this.database,
      { companyId, actorKind: 'system' },
      async (tx) => {
        const out = new Map<string, FeeMismatch>();
        const add = (key: string, expected: number, actual: number, problem: string) => {
          const m = out.get(key);
          if (m) m.problems.push(problem);
          else
            out.set(key, {
              key,
              expectedMinor: expected,
              actualMinor: actual,
              problems: [problem],
            });
        };
        // 1. Each posted percentage fee is its rate on its base.
        const groups = (
          await tx.execute<{ key: string; rate_bps: number; base: string; fee: string }>(
            sql`select f.key, max(f.rate_bps) as rate_bps, sum(f.base_minor)::text as base, sum(f.fee_minor)::text as fee
                from management_fee f where f.reverses_fee_id is null and f.source <> 'fixed'
                group by f.company_id, f.key`,
          )
        ).rows;
        for (const g of groups) {
          const expected = feeOnBaseMinor(Number(g.base), Number(g.rate_bps));
          if (expected !== Number(g.fee)) add(g.key, expected, Number(g.fee), 'rate_on_base');
        }
        // 2. Each posted fee equals its allocations' shares.
        for (const r of (
          await tx.execute<{
            key: string;
            fee: string;
            base: string;
            parts_fee: string;
            parts_base: string;
          }>(
            sql`select f.key, f.fee_minor::text as fee, f.base_minor::text as base,
                  sum(a.fee_minor)::text as parts_fee, sum(a.base_minor)::text as parts_base
                from management_fee f join allocation_fee a
                  on a.company_id = f.company_id and a.management_fee_id = f.id
                group by f.id, f.key, f.fee_minor, f.base_minor
                having sum(a.fee_minor) <> f.fee_minor or sum(a.base_minor) <> f.base_minor`,
          )
        ).rows)
          add(r.key, Number(r.parts_fee), Number(r.fee), 'allocations');
        // 3. No allocation has more taken back than it carried.
        for (const r of (
          await tx.execute<{ allocation_id: string; fee: string; taken: string }>(
            sql`select c.allocation_id, c.fee_minor::text as fee, (-sum(t.fee_minor))::text as taken
                from allocation_fee c join allocation_fee t
                  on t.company_id = c.company_id and t.charged_allocation_id = c.allocation_id
                where c.charged_allocation_id is null
                group by c.allocation_id, c.fee_minor, c.base_minor
                having -sum(t.fee_minor) > c.fee_minor or -sum(t.base_minor) > c.base_minor`,
          )
        ).rows)
          add(`allocation:${r.allocation_id}`, Number(r.fee), Number(r.taken), 'over_taken');
        // 4. Each owner book's 5100 equals its fee records.
        for (const r of (
          await tx.execute<{ book_id: string; ledger: string; fees: string }>(
            sql`select b.id as book_id,
                  (select coalesce(sum(l.amount_minor), 0) from journal_line l
                   where l.company_id = b.company_id and l.book_id = b.id and l.account_code = '5100')::text as ledger,
                  (select coalesce(sum(f.fee_minor), 0) from management_fee f
                   where f.company_id = b.company_id and f.book_id = b.id)::text as fees
                from book b where b.owner_id is not null`,
          )
        ).rows)
          if (Number(r.ledger) !== Number(r.fees))
            add(`book:${r.book_id}`, Number(r.fees), Number(r.ledger), 'ledger');
        // 5. Per lease, the live base charged equals the money settled since the terms began.
        for (const m of await this.liveBaseMismatches(tx))
          add(m.key, m.expected, m.actual, 'live_base');
        return [...out.values()];
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
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

  /**
   * Replays every lease of an owner who has had percentage terms: each fee-bearing allocation of
   * money made while percentage terms were in force should carry a fee, and what negative
   * allocations undid of it should have come back. Compares the live base so found with the
   * live base of `allocation_fee`.
   */
  private async liveBaseMismatches(
    tx: Tx,
  ): Promise<{ key: string; expected: number; actual: number }[]> {
    const owners = (
      await tx.execute<{ owner_id: string }>(
        sql`select distinct owner_id from management_fee_terms where kind = 'percentage'`,
      )
    ).rows.map((r) => r.owner_id);
    const out: { key: string; expected: number; actual: number }[] = [];
    for (const ownerId of owners) {
      const versions = await feeTermsVersions(tx, ownerId);
      const rows = (
        await tx.execute<{
          id: string;
          lease_id: string;
          invoice_line_id: string;
          kind: string;
          source: string;
          payment_id: string | null;
          amount_minor: string;
          value_date: string;
        }>(
          sql`select a.id, a.lease_id, a.invoice_line_id, il.kind, a.source, a.payment_id,
                a.amount_minor::text as amount_minor, a.value_date::text as value_date
              from allocation a
              join invoice_line il on il.company_id = a.company_id and il.id = a.invoice_line_id
              where a.property_id in (
                select co.property_id from property_current_ownership co
                where co.company_id = a.company_id and co.owner_id = ${ownerId}::uuid)
                and (select c.kind from company c where c.id = a.company_id) = 'agency'
              order by a.created_at, a.id`,
        )
      ).rows;
      const byLease = new Map<string, typeof rows>();
      for (const r of rows) byLease.set(r.lease_id, [...(byLease.get(r.lease_id) ?? []), r]);
      for (const [leaseId, leaseRows] of byLease) {
        const allocs = leaseRows.map((r) => ({
          id: r.id,
          lineId: r.invoice_line_id,
          lineKind: r.kind as LineKind,
          source: r.source as AllocationSource,
          paymentId: r.payment_id,
          amountMinor: Number(r.amount_minor),
        }));
        const termed = new Set(
          leaseRows
            .filter(
              (r) =>
                Number(r.amount_minor) > 0 &&
                feeTermsOn(versions, r.value_date)?.terms.kind === 'percentage',
            )
            .map((r) => r.id),
        );
        let expected = 0;
        for (const a of allocs) if (termed.has(a.id) && feeBearing(a)) expected += a.amountMinor;
        for (const u of undoings(allocs)) if (termed.has(u.undoesId)) expected -= u.amountMinor;
        const [stored] = (
          await tx.execute<{ base: string }>(
            sql`select coalesce(sum(base_minor), 0)::text as base from allocation_fee
                where lease_id = ${leaseId}::uuid`,
          )
        ).rows;
        const actual = Number(stored?.base ?? 0);
        if (actual !== expected) out.push({ key: `lease:${leaseId}`, expected, actual });
      }
    }
    return out;
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
