import { addDays, compareDates, parseBusinessDate, toIsoDate } from '../dates';
import { DomainError } from '../errors';
import { multiplyBps, money } from '../money/money';
import { CYCLE_MONTHS, periodStart, type LeaseTerms, type RentCycle } from '../tenancy/lease-terms';
import type { LineKind, RecurringKind, TaxKind } from './lines';

/**
 * Invoices from lease terms (BC-01; M4a plan 4.4, decisions 1, 2 and 4). Rent periods are monthly
 * whatever the cycle; an invoice bundles one cycle of them. Escalation steps are already in the
 * schedule's amounts (TL-06).
 */
export interface ScheduleRow {
  readonly id: string;
  readonly sequence: number;
  readonly chargeType: RecurringKind;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly amountMinor: number;
  readonly source: 'schedule' | 'holding_over';
}

export interface InvoiceCycle {
  /** With the lease, the invoice's key: the start of its first billed period. */
  readonly cycleStart: string;
  /** The first day of the cycle (decision 2). */
  readonly dueDate: string;
  /** When it should be issued: lead days ahead, or the day a held-over month starts. */
  readonly issueDate: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly holdingOver: boolean;
  /** Its charge periods in accrual order: period start, rent before service charge. */
  readonly rows: readonly ScheduleRow[];
}

/** Invoice lead time (decision 2): a company setting, 14 days by default. */
export const DEFAULT_INVOICE_LEAD_DAYS = 14;

const byAccrual = (a: ScheduleRow, b: ScheduleRow) =>
  a.periodStart !== b.periodStart
    ? a.periodStart < b.periodStart
      ? -1
      : 1
    : a.chargeType === b.chargeType
      ? 0
      : a.chargeType === 'rent'
        ? -1
        : 1;

/**
 * The lease's invoice cycles from its billing start (decision 1). The first invoice covers the
 * initial advance when the lease has one, then one cycle each; a held-over month is its own
 * invoice, issued the day it starts. Periods starting after `lastBillableDay` (the end, or an
 * earlier move-out) are never billed.
 */
export function invoiceCycles(input: {
  readonly cycle: RentCycle;
  readonly initialAdvanceMonths: number | null;
  readonly schedule: readonly ScheduleRow[];
  readonly billingStartDate: string;
  readonly lastBillableDay: string | null;
  readonly leadDays: number;
}): InvoiceCycle[] {
  if (!Number.isInteger(input.leadDays) || input.leadDays < 0 || input.leadDays > 60)
    throw new DomainError('billing.lead_days_invalid', 'Invoices are issued 0 to 60 days ahead');
  const months = CYCLE_MONTHS[input.cycle];
  const advance = input.initialAdvanceMonths;
  const groups = new Map<string, ScheduleRow[]>();
  for (const row of input.schedule) {
    if (row.periodStart < input.billingStartDate) continue;
    if (input.lastBillableDay !== null && row.periodStart > input.lastBillableDay) continue;
    const group =
      row.source === 'holding_over'
        ? `h${row.sequence}`
        : advance !== null && advance > 0
          ? row.sequence < advance
            ? 'c0'
            : `c${1 + Math.floor((row.sequence - advance) / months)}`
          : `c${Math.floor(row.sequence / months)}`;
    groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  const cycles: InvoiceCycle[] = [];
  for (const rows of groups.values()) {
    const sorted = [...rows].sort(byAccrual);
    const first = sorted[0] as ScheduleRow;
    const holdingOver = first.source === 'holding_over';
    cycles.push({
      cycleStart: first.periodStart,
      dueDate: first.periodStart,
      issueDate: holdingOver
        ? first.periodStart
        : toIsoDate(addDays(parseBusinessDate(first.periodStart), -input.leadDays)),
      periodFrom: first.periodStart,
      periodTo: sorted.reduce((end, r) => (r.periodEnd > end ? r.periodEnd : end), ''),
      holdingOver,
      rows: sorted,
    });
  }
  return cycles.sort((a, b) => (a.cycleStart < b.cycleStart ? -1 : 1));
}

/** Cycles due to be issued by `today` that have no invoice yet. Rerunning issues nothing new. */
export function cyclesToIssue(
  cycles: readonly InvoiceCycle[],
  today: string,
  issuedCycleStarts: ReadonlySet<string>,
): InvoiceCycle[] {
  return cycles.filter((c) => c.issueDate <= today && !issuedCycleStarts.has(c.cycleStart));
}

/** VAT and levies on commercial rent (CT-04, P32), from the rules rows as of the invoice date. */
export interface VatRates {
  readonly vatBps: number;
  readonly nhilBps: number;
  readonly getfundBps: number;
  /** `vat.applies_to_service_charge` (unverified; decision 4). */
  readonly appliesToServiceCharge: boolean;
}

export interface InvoiceLineDraft {
  readonly kind: LineKind;
  readonly chargePeriodId: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly amountMinor: number;
  readonly rateBps: number | null;
  /** For a tax line: the index of its base line in the same list. */
  readonly baseIndex: number | null;
}

/** Each rate on the line's net amount, rounded half up once per line; a zero result is no line. */
export function taxLinesOn(
  baseAmountMinor: number,
  rates: Pick<VatRates, 'vatBps' | 'nhilBps' | 'getfundBps'>,
): { readonly kind: TaxKind; readonly rateBps: number; readonly amountMinor: number }[] {
  const lines: { kind: TaxKind; rateBps: number; amountMinor: number }[] = [];
  for (const [kind, rateBps] of [
    ['vat', rates.vatBps],
    ['nhil', rates.nhilBps],
    ['getfund', rates.getfundBps],
  ] as const) {
    const amountMinor = multiplyBps(money(baseAmountMinor), rateBps).amountMinor;
    if (amountMinor > 0) lines.push({ kind, rateBps, amountMinor });
  }
  return lines;
}

/**
 * A cycle's invoice lines: each charge period's rent and service charge, with the VAT and levy
 * lines straight after the line they are charged on (decision 4).
 */
export function invoiceLinesFor(cycle: InvoiceCycle, vat: VatRates | null): InvoiceLineDraft[] {
  const lines: InvoiceLineDraft[] = [];
  for (const row of cycle.rows) {
    const baseIndex = lines.length;
    lines.push({
      kind: row.chargeType,
      chargePeriodId: row.id,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      amountMinor: row.amountMinor,
      rateBps: null,
      baseIndex: null,
    });
    if (!vat || (row.chargeType === 'service_charge' && !vat.appliesToServiceCharge)) continue;
    for (const tax of taxLinesOn(row.amountMinor, vat))
      lines.push({
        kind: tax.kind,
        chargePeriodId: null,
        periodStart: null,
        periodEnd: null,
        amountMinor: tax.amountMinor,
        rateBps: tax.rateBps,
        baseIndex,
      });
  }
  return lines;
}

export const draftTotal = (lines: readonly InvoiceLineDraft[]): number =>
  lines.reduce((sum, l) => sum + l.amountMinor, 0);

/**
 * Decision 4: for a VAT-registered owner's commercial lease, a payment that reaches beyond the
 * invoices already issued issues the invoices it pays for at once, up to the lease end, so the
 * payment is the tax point. `pending` are the term's cycles with no invoice yet, in order.
 */
export function cyclesForAdvance(input: {
  readonly pending: readonly InvoiceCycle[];
  readonly openMinor: number;
  readonly paymentMinor: number;
  readonly vat: VatRates;
}): InvoiceCycle[] {
  const chosen: InvoiceCycle[] = [];
  let covered = input.openMinor;
  for (const cycle of input.pending) {
    if (covered >= input.paymentMinor) break;
    if (cycle.holdingOver) break;
    chosen.push(cycle);
    covered += draftTotal(invoiceLinesFor(cycle, input.vat));
  }
  return chosen;
}

/**
 * Where billing starts (decision 1). An e-signed lease bills from its start. A paper lease bills
 * from the first rent period that starts on or after the day it is recorded, unless staff choose
 * another period start: an earlier one brings recent arrears in, a later one leaves out months
 * the tenant paid before the platform.
 */
export function firstPeriodStartOnOrAfter(
  terms: Pick<LeaseTerms, 'startDate' | 'periodCount'>,
  date: string,
): string {
  const start = parseBusinessDate(terms.startDate);
  const target = parseBusinessDate(date);
  let k = 0;
  while (k < terms.periodCount && compareDates(periodStart(start, k), target) < 0) k += 1;
  return toIsoDate(periodStart(start, k));
}

/** A billing start must be the start of one of the lease's rent periods, or the first held-over one. */
export function checkBillingStart(
  terms: Pick<LeaseTerms, 'startDate' | 'periodCount'>,
  date: string,
): string {
  const start = parseBusinessDate(terms.startDate);
  parseBusinessDate(date);
  for (let k = 0; k <= terms.periodCount; k += 1)
    if (toIsoDate(periodStart(start, k)) === date) return date;
  throw new DomainError(
    'billing.start_not_a_period',
    'Billing starts on the first day of one of the lease’s rent periods',
  );
}

/**
 * A deposit invoice is issued at signing, due on the start date (decision 2), unless a paper
 * lease bills from a later date: its deposit was paid before the platform and arrives with
 * opening balances (decision 1). A renewal asks only for what the carried deposit does not cover.
 */
export function depositDue(input: {
  readonly depositMinor: number | null;
  readonly startDate: string;
  readonly billingStartDate: string;
  readonly carriedDepositMinor: number;
}): number {
  if (!input.depositMinor || input.billingStartDate !== input.startDate) return 0;
  return Math.max(0, input.depositMinor - input.carriedDepositMinor);
}
