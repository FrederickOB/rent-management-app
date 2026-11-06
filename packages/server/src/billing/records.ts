import { and, asc, eq, inArray, schema, sql, type Tx } from '@rent/db';
import type {
  AllocationRow,
  AllocationSource,
  BillingLine,
  LineKind,
  PaymentRef,
} from '@rent/domain/billing';
import type { LeaseDimensions } from '@rent/domain/ledger';
import { businessDateOf, instantFrom, toIsoDate } from '@rent/domain/dates';
import type { Clock } from '../core/clock';
import { conflict } from '../core/errors';
import { companyBook, entryValueDates, ownerBook } from '../ledger/ledger.queries';
import { ownersOn } from '../portfolio/ownership';
import type { BillingLease } from '../tenancy/billing-facts';

/**
 * A lease's money as the domain sees it (M4a plan 4.5 to 4.7), loaded from billing's own tables:
 * its invoice lines with their accrual, the allocations to them and of its payments, and the
 * payments whose credit sits on the lease. Every balance is computed from these rows.
 */
export interface LineRecord extends BillingLine {
  readonly invoiceId: string;
  readonly invoiceNumber: number;
  readonly invoiceKind: 'cycle' | 'deposit' | 'one_off';
  readonly issueDate: string;
  readonly leaseId: string;
  readonly propertyId: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly bookId: string;
  readonly chargePeriodId: string | null;
  readonly ruleId: string | null;
  /** The accrual's value and accounting dates, once the line's period has started. */
  readonly accruedOn: string | null;
  readonly accruedAccounting: string | null;
}

export interface AllocationRecord extends AllocationRow {
  readonly id: string;
  readonly leaseId: string;
  readonly valueDate: string;
  readonly accountingDate: string;
  readonly recordType: string;
  readonly recordId: string;
  readonly entryId: string | null;
  readonly createdAt: Date;
}

export interface PaymentRecord extends PaymentRef {
  readonly row: typeof schema.payment.$inferSelect;
  /** The lease the payment pays: its own, or the one it was matched to. */
  readonly leaseId: string | null;
  /** The lease its credit sits on now: the lease it pays, or the renewal it was carried to. */
  readonly creditLeaseId: string | null;
  readonly matchAccountingDate: string | null;
  readonly reversedAccountingDate: string | null;
  /**
   * M5 (AR-04, P13): refunded to the tenant at an early end, out of the payment's credit. Its
   * `amountMinor` is what is left for allocation: the amount received less this.
   */
  readonly refundedMinor: number;
}

export const isoNow = (clock: Clock, timeZone: string): string =>
  toIsoDate(businessDateOf(instantFrom(clock.now()), timeZone));

export const formatInvoiceNumber = (n: number) => `INV-${String(n).padStart(6, '0')}`;
export const formatReceiptNumber = (n: number) => `RC-${String(n).padStart(6, '0')}`;

export const dimsOf = (lease: {
  readonly propertyId: string;
  readonly unitId: string;
  readonly id: string;
  readonly tenantId: string;
}): LeaseDimensions => ({
  propertyId: lease.propertyId,
  unitId: lease.unitId,
  leaseId: lease.id,
  tenantId: lease.tenantId,
});

/** The FIFO order of payments: when the money arrived, then which arrived first that day. */
export const paymentOrder = (receivedOn: string, id: string) => `${receivedOn}#${id}`;

export async function loadLines(tx: Tx, leaseIds: readonly string[]): Promise<LineRecord[]> {
  if (leaseIds.length === 0) return [];
  const rows = await tx
    .select({
      line: schema.invoiceLine,
      number: schema.invoice.number,
      invoiceKind: schema.invoice.kind,
      issueDate: schema.invoice.issueDate,
      ownerId: schema.invoice.ownerId,
      bookId: schema.invoice.bookId,
      accruedOn: schema.invoiceLineAccrual.valueDate,
      accruedAccounting: schema.invoiceLineAccrual.accountingDate,
    })
    .from(schema.invoiceLine)
    .innerJoin(
      schema.invoice,
      and(
        eq(schema.invoice.companyId, schema.invoiceLine.companyId),
        eq(schema.invoice.id, schema.invoiceLine.invoiceId),
      ),
    )
    .leftJoin(
      schema.invoiceLineAccrual,
      and(
        eq(schema.invoiceLineAccrual.companyId, schema.invoiceLine.companyId),
        eq(schema.invoiceLineAccrual.invoiceLineId, schema.invoiceLine.id),
      ),
    )
    .where(inArray(schema.invoiceLine.leaseId, [...leaseIds]))
    .orderBy(asc(schema.invoice.number), asc(schema.invoiceLine.position));
  // One-off and tax lines are owed from their charge (P01, P32), dated at its tax point.
  const charged = rows.filter((r) => r.line.kind === 'one_off' || r.line.baseLineId !== null);
  const charges = await entryValueDates(tx, [
    ...new Set(
      charged.map((r) => `${r.line.kind === 'one_off' ? 'P01' : 'P32'}:${r.line.invoiceId}`),
    ),
  ]);
  const chargedOnOf = (r: (typeof rows)[number]) =>
    r.line.kind === 'one_off'
      ? (charges.get(`P01:${r.line.invoiceId}`) ?? r.issueDate)
      : r.line.baseLineId !== null
        ? (charges.get(`P32:${r.line.invoiceId}`) ?? r.issueDate)
        : null;
  return rows.map((r, index) => ({
    id: r.line.id,
    kind: r.line.kind as LineKind,
    baseLineId: r.line.baseLineId,
    rateBps: r.line.rateBps,
    dueDate: r.line.dueDate,
    periodStart: r.line.periodStart,
    periodEnd: r.line.periodEnd,
    amountMinor: r.line.amountMinor,
    accrued: r.accruedOn !== null,
    sequence: index + 1,
    chargedOn: chargedOnOf(r),
    invoiceId: r.line.invoiceId,
    invoiceNumber: r.number,
    invoiceKind: r.invoiceKind as LineRecord['invoiceKind'],
    issueDate: r.issueDate,
    leaseId: r.line.leaseId,
    propertyId: r.line.propertyId,
    tenantId: r.line.tenantId,
    ownerId: r.ownerId,
    bookId: r.bookId,
    chargePeriodId: r.line.chargePeriodId,
    ruleId: r.line.ruleId,
    accruedOn: r.accruedOn,
    accruedAccounting: r.accruedAccounting,
  }));
}

/** Payments with their lease, the lease their credit sits on, and when they were matched or reversed. */
async function paymentRecords(tx: Tx, where: ReturnType<typeof sql>): Promise<PaymentRecord[]> {
  const rows = await tx.execute<{ id: string }>(
    sql`select p.id from payment p
        left join payment_match m on m.company_id = p.company_id and m.payment_id = p.id
        where ${where}`,
  );
  return paymentsByIds(
    tx,
    rows.rows.map((r) => r.id),
  );
}

export async function paymentsByIds(tx: Tx, ids: readonly string[]): Promise<PaymentRecord[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({
      payment: schema.payment,
      matchLeaseId: schema.paymentMatch.leaseId,
      matchAccounting: schema.paymentMatch.accountingDate,
      reversedAccounting: schema.paymentReversal.accountingDate,
      carriedTo: sql<string | null>`(select c.lease_id from credit_carry_over c
        where c.company_id = ${schema.payment.companyId} and c.payment_id = ${schema.payment.id}
          and c.kind = 'credit' order by c.created_at desc, c.id desc limit 1)`,
      // M5's early-termination refunds and M8's move-out credit refunds (P13 approved).
      refunded: sql<string>`(select coalesce(sum(r.amount_minor), 0)::bigint from early_termination_refund_part r
        where r.company_id = ${schema.payment.companyId} and r.payment_id = ${schema.payment.id})
        + (select coalesce(sum(m.amount_minor), 0)::bigint from move_out_refund_part m
        where m.company_id = ${schema.payment.companyId} and m.payment_id = ${schema.payment.id})`,
    })
    .from(schema.payment)
    .leftJoin(
      schema.paymentMatch,
      and(
        eq(schema.paymentMatch.companyId, schema.payment.companyId),
        eq(schema.paymentMatch.paymentId, schema.payment.id),
      ),
    )
    .leftJoin(
      schema.paymentReversal,
      and(
        eq(schema.paymentReversal.companyId, schema.payment.companyId),
        eq(schema.paymentReversal.paymentId, schema.payment.id),
      ),
    )
    .where(inArray(schema.payment.id, [...ids]));
  return rows
    .map((r) => {
      const leaseId = r.payment.leaseId ?? r.matchLeaseId ?? null;
      const refunded = Number(r.refunded ?? 0);
      return {
        id: r.payment.id,
        amountMinor: r.payment.amountMinor - refunded,
        refundedMinor: refunded,
        order: paymentOrder(r.payment.receivedOn, r.payment.id),
        row: r.payment,
        leaseId,
        creditLeaseId: r.carriedTo ?? leaseId,
        matchAccountingDate: r.matchAccounting ?? null,
        reversedAccountingDate: r.reversedAccounting ?? null,
      };
    })
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
}

/** Live payments whose credit sits on the lease: its pools, first in, first out (BC-07). */
export async function poolPayments(tx: Tx, leaseId: string): Promise<PaymentRecord[]> {
  const candidates = await paymentRecords(
    tx,
    sql`(p.lease_id = ${leaseId} or m.lease_id = ${leaseId}
         or exists (select 1 from credit_carry_over c where c.company_id = p.company_id
                    and c.payment_id = p.id and c.lease_id = ${leaseId}))`,
  );
  return candidates.filter((p) => p.reversedAccountingDate === null && p.creditLeaseId === leaseId);
}

export async function loadAllocations(
  tx: Tx,
  input: { readonly leaseIds: readonly string[]; readonly paymentIds: readonly string[] },
): Promise<AllocationRecord[]> {
  const conditions = [];
  if (input.leaseIds.length > 0)
    conditions.push(inArray(schema.allocation.leaseId, [...input.leaseIds]));
  if (input.paymentIds.length > 0)
    conditions.push(inArray(schema.allocation.paymentId, [...input.paymentIds]));
  if (conditions.length === 0) return [];
  const rows = await tx
    .select()
    .from(schema.allocation)
    .where(conditions.length === 1 ? conditions[0] : sql`(${conditions[0]} or ${conditions[1]})`)
    .orderBy(asc(schema.allocation.createdAt), asc(schema.allocation.id));
  return rows.map(allocationRecord);
}

export const allocationRecord = (r: typeof schema.allocation.$inferSelect): AllocationRecord => ({
  id: r.id,
  lineId: r.invoiceLineId,
  source: r.source as AllocationSource,
  paymentId: r.paymentId,
  amountMinor: r.amountMinor,
  leaseId: r.leaseId,
  valueDate: r.valueDate,
  accountingDate: r.accountingDate,
  recordType: r.recordType,
  recordId: r.recordId,
  entryId: r.entryId,
  createdAt: r.createdAt,
});

/** Where a lease is billed: its owner's book (decision 5). */
export type LeaseBook =
  | { readonly kind: 'book'; readonly bookId: string; readonly ownerId: string }
  | { readonly kind: 'not_billed'; readonly reason: 'joint_owners' | 'no_owner' };

/**
 * The book a lease posts to. Once it has an invoice, the book its invoices name (a lease is billed
 * in one book; the database refuses a second). Before that, the book of the property's single
 * owner on the date; a property with more than one owner is not billed (decision 5).
 */
export async function leaseBookOf(
  tx: Tx,
  lease: Pick<BillingLease, 'id' | 'propertyId'>,
  date: string,
): Promise<LeaseBook> {
  const [invoiced] = await tx
    .select({ bookId: schema.invoice.bookId, ownerId: schema.invoice.ownerId })
    .from(schema.invoice)
    .where(eq(schema.invoice.leaseId, lease.id))
    .orderBy(asc(schema.invoice.number))
    .limit(1);
  if (invoiced) return { kind: 'book', bookId: invoiced.bookId, ownerId: invoiced.ownerId };
  const [paid] = await tx
    .select({ bookId: schema.payment.bookId, ownerId: schema.payment.ownerId })
    .from(schema.payment)
    .where(and(eq(schema.payment.leaseId, lease.id), sql`${schema.payment.ownerId} is not null`))
    .limit(1);
  if (paid?.ownerId) return { kind: 'book', bookId: paid.bookId, ownerId: paid.ownerId };
  const owners = await ownersOn(tx, lease.propertyId, date);
  if (owners.length === 0) return { kind: 'not_billed', reason: 'no_owner' };
  if (owners.length > 1 || owners[0]!.shareBps !== 10_000)
    return { kind: 'not_billed', reason: 'joint_owners' };
  const ownerId = owners[0]!.ownerId;
  const bookId = await ownerBook(tx, ownerId);
  if (!bookId) return { kind: 'not_billed', reason: 'no_owner' };
  return { kind: 'book', bookId, ownerId };
}

export function requireBook(book: LeaseBook): { bookId: string; ownerId: string } {
  if (book.kind === 'book') return book;
  throw conflict(
    book.reason,
    book.reason === 'joint_owners'
      ? 'This property has more than one owner, so it is not billed. Record joint owners as one owner (PR-07 splits their statements later).'
      : 'This property has no owner on record, so it cannot be billed',
  );
}

/** The company book: unmatched money in the agency's account waits here (P23). */
export async function companyBookId(tx: Tx): Promise<string> {
  const book = await companyBook(tx);
  if (!book) throw new Error('The company has no company book');
  return book;
}

/** An owner's book. */
export async function ownerBookId(tx: Tx, ownerId: string): Promise<string> {
  const book = await ownerBook(tx, ownerId);
  if (!book) throw new Error(`Owner ${ownerId} has no book`);
  return book;
}

/** Takes the per-lease billing lock for each lease, in one order, before reading their money. */
export async function lockLeases(
  tx: Tx,
  companyId: string,
  leaseIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(leaseIds)].sort();
  for (const id of ids)
    await tx.execute(sql`select app.lock_lease_billing(${companyId}::uuid, ${id}::uuid)`);
  // Then their properties' owner locks: an invoice may be issued, and a same-day owner correction
  // takes the same lock. The single order is lease(s), property owner, collector cash, counters,
  // audit chain head (second review B); the invoice trigger takes it again, re-entrantly.
  if (ids.length === 0) return;
  const properties = await tx.execute<{ property_id: string }>(
    sql`select distinct property_id from lease where id = any(${`{${ids.join(',')}}`}::uuid[])
        order by property_id`,
  );
  for (const row of properties.rows)
    await tx.execute(
      sql`select app.lock_property_owner(${companyId}::uuid, ${row.property_id}::uuid)`,
    );
}

export async function lockCollectorCash(
  tx: Tx,
  companyId: string,
  collectorId: string,
  bookId: string,
): Promise<void> {
  await tx.execute(
    sql`select app.lock_collector_cash(${companyId}::uuid, ${collectorId}::uuid, ${bookId}::uuid)`,
  );
}

/**
 * Takes the company's number counters (receipts and invoices) for the rest of the transaction,
 * before anything audited is written, so every path locks in one order: the lease(s), the
 * collector's cash, the counters, then the audit chain head (review 3).
 */
export async function lockCounters(tx: Tx, companyId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`counters:${companyId}`}, 17))`,
  );
}

/**
 * One transaction at a time works on a payment that is not matched yet: matching it and reversing
 * it take this lock first, before any lease (review 5).
 */
export async function lockPayment(tx: Tx, companyId: string, paymentId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`payment:${companyId}:${paymentId}`}, 19))`,
  );
}

/**
 * A lease with the lease it renews and its started renewal: money on one can move to another
 * (P29), so they are locked together, in one order (review 10, 11).
 */
export async function leaseGroup(tx: Tx, leaseId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(
    sql`select ${leaseId}::uuid as id
        union select renews_lease_id from lease where id = ${leaseId} and renews_lease_id is not null
        union select id from lease where renews_lease_id = ${leaseId}
          and status in ('active', 'ending', 'holding_over', 'ended', 'terminated')`,
  );
  return rows.rows.map((r) => r.id).sort();
}

/** A collector's cash in one owner's book: the key of cash on hand and of banking waiting. */
export const cashKey = (collectorId: string, bookId: string): string => `${collectorId}|${bookId}`;

/**
 * Banking waiting for approval (P07), per collector and book (`cashKey`). It still counts as held
 * until it is approved, so a new banking may ask only for the rest (`bankableMinor`). Read through
 * a narrow database function, so a scoped collector counts banking someone else asked for on their
 * cash without seeing that request (second review C).
 */
export async function pendingBanking(
  tx: Tx,
  companyId: string,
  collectorIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const collectorId of new Set(collectorIds)) {
    const rows = await tx.execute<{ book_id: string; amount_minor: number }>(
      sql`select book_id, amount_minor from app.pending_banking(${companyId}::uuid, ${collectorId}::uuid)`,
    );
    for (const r of rows.rows) out.set(cashKey(collectorId, r.book_id), Number(r.amount_minor));
  }
  return out;
}

/**
 * What a new banking may ask for (BC-05, P07): what the collector holds in the book, less banking
 * already waiting for approval, so two requests can never ask for the same cash. The request
 * checks it and the cash-on-hand screen shows it; approval checks again against what is held.
 */
export function bankableMinor(heldMinor: number, pendingMinor: number): number {
  return Math.max(0, heldMinor - pendingMinor);
}

/**
 * The next number of a per-company sequence (plan 4.10), from its counter row, locked until the
 * transaction ends: a failed transaction rolls the number back with it, so there are no gaps.
 */
export async function nextNumber(
  tx: Tx,
  companyId: string,
  name: 'receipt' | 'invoice',
): Promise<number> {
  await lockCounters(tx, companyId);
  const result = await tx.execute<{ value: number }>(
    sql`insert into company_counter (company_id, name, value) values (${companyId}, ${name}, 1)
        on conflict (company_id, name) do update set value = company_counter.value + 1
        returning value`,
  );
  return Number(result.rows[0]!.value);
}
