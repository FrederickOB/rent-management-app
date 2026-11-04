import { addDays, parseBusinessDate, toIsoDate } from '../dates';
import { DomainError } from '../errors';

/**
 * Rent tax items as staff see them (TX-01 to TX-03; M5 plan 5.1 and 5.3). An item is one event's
 * tax: a receipt, credit carried to a renewal and applied to rent, tax withheld by the tenant, or a
 * reversal of earlier tax (a payment reversed, or tax on cash replaced by withholding). Its status
 * is derived from what settled it and what reversed it, never stored.
 */
export const TAX_ITEM_KINDS = [
  'receipt',
  'carry_over',
  'withholding',
  'reversal',
  'withholding_offset',
] as const;
export type TaxItemKind = (typeof TAX_ITEM_KINDS)[number];

export const TAX_ITEM_STATUSES = [
  'open',
  'part_paid',
  'paid',
  'withheld',
  'reversed',
  'correction',
] as const;
export type TaxItemStatus = (typeof TAX_ITEM_STATUSES)[number];

export const TAX_ITEM_STATUS_LABELS: Record<TaxItemStatus, string> = {
  open: 'Open',
  part_paid: 'Part paid',
  paid: 'Paid to GRA',
  withheld: 'Withheld by the tenant',
  reversed: 'Reversed',
  correction: 'Correction',
};

/**
 * Items the owner pays GRA: tax on money received, and tax a tenant withheld whose certificate
 * never came and was written off (P24): the owner pays that tax after all.
 */
export const isPayableKind = (kind: TaxItemKind, withholdingWrittenOff = false): boolean =>
  kind === 'receipt' || kind === 'carry_over' || (kind === 'withholding' && withholdingWrittenOff);

/**
 * An item's status: a correction (a reversal or an offset) is itself only a correction; tax the
 * tenant withheld is "withheld" (until its certificate is written off); tax on money received is
 * reversed once corrections take it to nothing, else paid, part paid or open by what GRA payments
 * settled.
 */
export function taxItemStatus(input: {
  readonly kind: TaxItemKind;
  readonly taxMinor: number;
  /** Corrections of this item so far (negative or zero): offsets and reversals. */
  readonly correctedMinor: number;
  /** Settled by GRA payments. */
  readonly paidMinor: number;
  readonly withholdingWrittenOff?: boolean;
}): TaxItemStatus {
  if (input.kind === 'reversal' || input.kind === 'withholding_offset') return 'correction';
  if (input.kind === 'withholding' && !input.withholdingWrittenOff) return 'withheld';
  const net = input.taxMinor + input.correctedMinor;
  if (input.correctedMinor < 0 && net <= 0) return 'reversed';
  if (input.paidMinor <= 0) return net <= 0 ? 'paid' : 'open';
  return input.paidMinor >= net ? 'paid' : 'part_paid';
}

/** What is still to pay GRA on an item: its tax, net of corrections, less GRA payments. */
export function taxItemOutstanding(input: {
  readonly kind: TaxItemKind;
  readonly taxMinor: number;
  readonly correctedMinor: number;
  readonly paidMinor: number;
  readonly withholdingWrittenOff?: boolean;
}): number {
  if (!isPayableKind(input.kind, input.withholdingWrittenOff)) return 0;
  return Math.max(0, input.taxMinor + input.correctedMinor - input.paidMinor);
}

/**
 * TX-02: the alert days reached by `today` for an item received on `valueDate`, each once. An item
 * withheld by the tenant, reversed or paid raises none (the caller passes only open items).
 */
export function rentTaxAlertsReached(
  valueDate: string,
  alertDays: readonly number[],
  today: string,
): number[] {
  const start = parseBusinessDate(valueDate);
  return [...new Set(alertDays)]
    .filter((d) => Number.isInteger(d) && d >= 0)
    .sort((a, b) => a - b)
    .filter((d) => toIsoDate(addDays(start, d)) <= today);
}

/**
 * Settles GRA payment amounts against open items, oldest due first (TX-03; plan 5.3: "oldest first
 * by default, adjustable"). Chosen amounts are checked against what each item still owes.
 */
export function settleOldestFirst(
  items: readonly {
    readonly id: string;
    readonly dueDate: string;
    readonly outstandingMinor: number;
  }[],
  amountMinor: number,
): { readonly itemId: string; readonly amountMinor: number }[] {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
    throw new DomainError('tax.bad_amount', 'A GRA payment is an amount above zero');
  const owed = items.reduce((s, i) => s + Math.max(0, i.outstandingMinor), 0);
  if (amountMinor > owed)
    throw new DomainError(
      'tax.payment_too_large',
      'The payment is more than the rent tax still owed on the items chosen',
    );
  let left = amountMinor;
  const out: { itemId: string; amountMinor: number }[] = [];
  for (const item of [...items].sort((a, b) =>
    a.dueDate !== b.dueDate ? (a.dueDate < b.dueDate ? -1 : 1) : a.id < b.id ? -1 : 1,
  )) {
    if (left === 0) break;
    const take = Math.min(left, Math.max(0, item.outstandingMinor));
    if (take > 0) out.push({ itemId: item.id, amountMinor: take });
    left -= take;
  }
  return out;
}

/** Checks amounts chosen per item: each above zero and within what the item still owes. */
export function checkChosenSettlement(
  items: ReadonlyMap<string, number>,
  chosen: readonly { readonly itemId: string; readonly amountMinor: number }[],
): number {
  if (chosen.length === 0)
    throw new DomainError('tax.no_items', 'Choose the rent tax items the payment settles');
  const seen = new Set<string>();
  let total = 0;
  for (const c of chosen) {
    if (seen.has(c.itemId)) throw new DomainError('tax.repeated_item', 'Each item is listed once');
    seen.add(c.itemId);
    const owed = items.get(c.itemId);
    if (owed === undefined)
      throw new DomainError('tax.unknown_item', 'An item chosen is not open for this owner');
    if (!Number.isSafeInteger(c.amountMinor) || c.amountMinor <= 0 || c.amountMinor > owed)
      throw new DomainError(
        'tax.bad_item_amount',
        'Each amount is above zero and no more than the item still owes',
      );
    total += c.amountMinor;
  }
  return total;
}

/**
 * CSV as RFC 4180 writes it: every field quoted, quotes doubled, records ended by CRLF. The same
 * rows always give the same bytes, so a report regenerated for a locked month is identical.
 */
export function toCsv(rows: readonly (readonly (string | number | null)[])[]): string {
  return rows
    .map(
      (row) =>
        row
          .map((field) => `"${(field === null ? '' : String(field)).replace(/"/g, '""')}"`)
          .join(',') + '\r\n',
    )
    .join('');
}
