import { DomainError } from '../errors';
import type { PostingClass } from '../ledger/posting';

/**
 * Invoice lines and their allocations (BC-01, BC-07; architecture sections 3.4 and 6). Every
 * balance is derived from these rows: nothing here is stored as an editable figure.
 */
export const LINE_KINDS = [
  'deposit',
  'rent',
  'service_charge',
  'one_off',
  'vat',
  'nhil',
  'getfund',
] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export type RecurringKind = 'rent' | 'service_charge';
export type TaxKind = 'vat' | 'nhil' | 'getfund';

export const TAX_KINDS: readonly TaxKind[] = ['vat', 'nhil', 'getfund'];

export const LINE_KIND_LABELS: Record<LineKind, string> = {
  deposit: 'Security deposit',
  rent: 'Rent',
  service_charge: 'Service charge',
  one_off: 'Charge',
  vat: 'VAT',
  nhil: 'NHIL',
  getfund: 'GETFund levy',
};

export const isRecurring = (kind: LineKind): kind is RecurringKind =>
  kind === 'rent' || kind === 'service_charge';
export const isTax = (kind: LineKind): kind is TaxKind =>
  kind === 'vat' || kind === 'nhil' || kind === 'getfund';

export interface BillingLine {
  readonly id: string;
  readonly kind: LineKind;
  /** The line a VAT or levy line is charged on; null for every other kind. */
  readonly baseLineId: string | null;
  /** The rate a tax line was charged at, from the rules row it recorded. */
  readonly rateBps: number | null;
  readonly dueDate: string;
  /** Recurring lines only: the monthly charge period. */
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly amountMinor: number;
  /** Recurring lines: their period has started and P02 has run (or found nothing to post). */
  readonly accrued: boolean;
  /** Creation order on the lease: the last tie-breaker. */
  readonly sequence: number;
  /**
   * One-off and tax lines: the day they were charged (P01, P32: the invoice's tax point). Money
   * that arrived before it waits in prepayments and is drawn on that day (review A).
   */
  readonly chargedOn?: string | null;
}

/** Where an allocation comes from (CLAUDE.md section 4). Corrections are negative rows. */
export const ALLOCATION_SOURCES = [
  'payment',
  'deposit',
  'withholding',
  'credit_note',
  'write_off',
] as const;
export type AllocationSource = (typeof ALLOCATION_SOURCES)[number];

export interface AllocationRow {
  readonly lineId: string;
  readonly source: AllocationSource;
  /** Set for payment-sourced rows. */
  readonly paymentId: string | null;
  /** Signed: a reversal or a release is a negative row; nothing is ever updated. */
  readonly amountMinor: number;
  /** The record that wrote it (a withholding's id for source `withholding`), when known. */
  readonly recordId?: string | null;
}

/** A payment as allocation sees it. `order` sorts payments first in, first out. */
export interface PaymentRef {
  readonly id: string;
  readonly amountMinor: number;
  readonly order: string;
}

export interface LineBalance {
  /** The amount after credit notes. */
  readonly netMinor: number;
  /** Paid by payments, deposits and withholding. */
  readonly settledMinor: number;
  readonly writtenOffMinor: number;
  readonly outstandingMinor: number;
}

export function lineBalance(line: BillingLine, allocations: readonly AllocationRow[]): LineBalance {
  let credited = 0;
  let settled = 0;
  let writtenOff = 0;
  for (const a of allocations) {
    if (a.lineId !== line.id) continue;
    if (a.source === 'credit_note') credited += a.amountMinor;
    else if (a.source === 'write_off') writtenOff += a.amountMinor;
    else settled += a.amountMinor;
  }
  const netMinor = line.amountMinor - credited;
  const outstandingMinor = netMinor - settled - writtenOff;
  if (netMinor < 0 || settled < 0 || writtenOff < 0 || outstandingMinor < 0)
    throw new DomainError('billing.line_over_allocated', `Line ${line.id} is over-allocated`);
  return { netMinor, settledMinor: settled, writtenOffMinor: writtenOff, outstandingMinor };
}

/** A line's payment-sourced allocations, net, per payment (positive amounts only). */
export function paymentShares(
  lineId: string,
  allocations: readonly AllocationRow[],
): Map<string, number> {
  const shares = new Map<string, number>();
  for (const a of allocations)
    if (a.lineId === lineId && a.source === 'payment' && a.paymentId)
      shares.set(a.paymentId, (shares.get(a.paymentId) ?? 0) + a.amountMinor);
  for (const [id, amount] of shares) if (amount === 0) shares.delete(id);
  return shares;
}

/** What a payment has allocated, net of reversals and releases, across every line. */
export function paymentAllocated(paymentId: string, allocations: readonly AllocationRow[]): number {
  let allocated = 0;
  for (const a of allocations)
    if (a.source === 'payment' && a.paymentId === paymentId) allocated += a.amountMinor;
  return allocated;
}

/** A payment's credit: its unallocated remainder, held in prepayments (BC-07, invariant 7). */
export function paymentCredit(payment: PaymentRef, allocations: readonly AllocationRow[]): number {
  const credit = payment.amountMinor - paymentAllocated(payment.id, allocations);
  if (credit < 0)
    throw new DomainError(
      'billing.payment_over_allocated',
      `Payment ${payment.id} is over-allocated`,
    );
  return credit;
}

/** A payment's credit available to a lease, first in, first out. */
export interface CreditPool {
  readonly paymentId: string;
  readonly order: string;
  readonly amountMinor: number;
}

export function creditPools(
  payments: readonly PaymentRef[],
  allocations: readonly AllocationRow[],
): CreditPool[] {
  return payments
    .map((p) => ({ paymentId: p.id, order: p.order, amountMinor: paymentCredit(p, allocations) }))
    .filter((p) => p.amountMinor > 0)
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
}

/**
 * The account an allocation to this line lands in: deposits held (2100); owed (1100) once the
 * line is charged, which is at accrual for rent and service charge and at issue for one-off and
 * VAT lines; otherwise prepaid (2010).
 */
export function postingClassOf(line: BillingLine): PostingClass {
  if (line.kind === 'deposit') return 'deposit';
  if (isRecurring(line.kind) && !line.accrued) return 'prepayment';
  return 'receivable';
}

/**
 * The account an allocation to this line lands in as of `valueDate`, the day the money arrived
 * (architecture section 5, P03): deposits held (2100); owed (1100) for a period started by then, a
 * one-off or a tax line; prepaid (2010) for a period that had not started then, even if it has
 * accrued since (the late draw moves it, dated at the period start).
 */
export function postingClassAt(line: BillingLine, valueDate: string): PostingClass {
  if (line.kind === 'deposit') return 'deposit';
  const chargedFrom = isRecurring(line.kind) ? line.periodStart : (line.chargedOn ?? null);
  if (isRecurring(line.kind) && chargedFrom === null) return 'prepayment';
  if (chargedFrom !== null && chargedFrom > valueDate) return 'prepayment';
  return 'receivable';
}

/** The day a line became owed (1100): its period start once accrued, or its charge date. */
export function chargedFrom(line: BillingLine): string | null {
  if (line.kind === 'deposit') return null;
  if (isRecurring(line.kind)) return line.accrued ? line.periodStart : null;
  return line.chargedOn ?? null;
}

/** The account a line was charged to, or null if it has not been charged (P01, P02, P32). */
export function chargedAccountOf(line: BillingLine): '4000' | '4100' | '4200' | '2210' | null {
  switch (line.kind) {
    case 'deposit':
      return null;
    case 'rent':
      return line.accrued ? '4000' : null;
    case 'service_charge':
      return line.accrued ? '4100' : null;
    case 'one_off':
      return '4200';
    default:
      return '2210';
  }
}

/**
 * Within one due date: the deposit, then the charge periods month by month, then one-off charges
 * (M4b decision 9). Each month's rent comes before that month's service charge.
 */
const GROUP_RANK: Record<LineKind, number> = {
  deposit: 0,
  rent: 1,
  service_charge: 1,
  one_off: 2,
  vat: 0,
  nhil: 0,
  getfund: 0,
};
const KIND_RANK: Record<LineKind, number> = {
  deposit: 0,
  rent: 0,
  service_charge: 1,
  one_off: 0,
  vat: 0,
  nhil: 0,
  getfund: 0,
};
/** A VAT or levy line's place straight after the line it is charged on. */
const TAX_RANK: Record<LineKind, number> = {
  deposit: 0,
  rent: 0,
  service_charge: 0,
  one_off: 0,
  vat: 1,
  nhil: 2,
  getfund: 3,
};

type OrderKey = readonly (string | number)[];

function orderKey(line: BillingLine, byId: ReadonlyMap<string, BillingLine>): OrderKey {
  if (line.baseLineId) {
    const base = byId.get(line.baseLineId);
    if (!base)
      throw new DomainError('billing.base_line_missing', `Line ${line.id} has no base line`);
    return [...orderKey(base, byId).slice(0, 5), TAX_RANK[line.kind]];
  }
  return [
    line.dueDate,
    GROUP_RANK[line.kind],
    line.periodStart ?? '',
    KIND_RANK[line.kind],
    line.sequence,
    0,
  ];
}

function compareKeys(a: OrderKey, b: OrderKey): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? '';
    const y = b[i] ?? '';
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Oldest debt first (BC-07; architecture section 6): by due date, so across invoices the oldest
 * goes first. Within one due date (one invoice): the deposit, then month by month, each month's
 * rent before its service charge (M4b decision 9), then one-off charges, with each VAT or levy
 * line straight after its base line.
 */
export function inAllocationOrder(lines: readonly BillingLine[]): BillingLine[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const keyed = lines.map((line) => ({ line, key: orderKey(line, byId) }));
  keyed.sort((a, b) => compareKeys(a.key, b.key));
  return keyed.map((k) => k.line);
}

/** Accrual order (architecture section 6): period start, then rent before service charge. */
export function inAccrualOrder<T extends Pick<BillingLine, 'kind' | 'periodStart' | 'sequence'>>(
  lines: readonly T[],
): T[] {
  return lines
    .filter((l) => isRecurring(l.kind))
    .sort((a, b) =>
      (a.periodStart ?? '') !== (b.periodStart ?? '')
        ? (a.periodStart ?? '') < (b.periodStart ?? '')
          ? -1
          : 1
        : a.kind !== b.kind
          ? a.kind === 'rent'
            ? -1
            : 1
          : a.sequence - b.sequence,
    );
}

/** Recurring lines whose period has started by `date` and have not been accrued. */
export function linesToAccrue(lines: readonly BillingLine[], date: string): BillingLine[] {
  return inAccrualOrder(
    lines.filter((l) => !l.accrued && l.periodStart !== null && l.periodStart <= date),
  );
}

/** Invoice states (architecture section 7): derived from the lines, never stored. */
export const INVOICE_STATUSES = ['issued', 'part_paid', 'paid', 'voided', 'written_off'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  issued: 'Issued',
  part_paid: 'Part paid',
  paid: 'Paid',
  voided: 'Voided',
  written_off: 'Written off',
};

/**
 * An invoice's status from its lines' balances: voided when credit notes cancelled all of it,
 * otherwise paid or written off once nothing is outstanding, otherwise part paid or issued.
 * Overdue is separate: past the due date with something outstanding.
 */
export function invoiceStatusOf(balances: readonly LineBalance[]): InvoiceStatus {
  const net = balances.reduce((sum, b) => sum + b.netMinor, 0);
  const outstanding = balances.reduce((sum, b) => sum + b.outstandingMinor, 0);
  const settled = balances.reduce((sum, b) => sum + b.settledMinor, 0);
  const writtenOff = balances.reduce((sum, b) => sum + b.writtenOffMinor, 0);
  if (net === 0) return 'voided';
  if (outstanding === 0) return writtenOff > 0 ? 'written_off' : 'paid';
  return settled > 0 ? 'part_paid' : 'issued';
}
