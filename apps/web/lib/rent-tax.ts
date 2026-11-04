import { addDays, addMonths, daysBetween, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import {
  settleOldestFirst,
  TAX_ITEM_STATUS_LABELS,
  TAX_ITEM_STATUSES,
  type TaxItemKind,
  type TaxItemStatus,
} from '@rent/domain/tax';
import type { ApiClient } from '@rent/contracts/client';
import type { ReceivingAccount } from './billing-format';
import { formatBusinessDate } from './business-dates';
import { amountMinorOf, pastDateProblem, type Parsed } from './payment-form';
import { TAX_LIMITS } from './tax-limits';
import { formatMinor } from './tenancy-format';

// The rent tax screens (TX-01 to TX-03, TX-08; M5 plan 5.1, 5.3 and 5.8). The API works out every
// figure from the ledger: each receipt's base, rate, tax and due date, with the rule versions it
// used, and what GRA payments have settled. These helpers say it, order the due list, and turn
// the GRA payment form into the API's input. Amounts stay integer pesewas (CLAUDE.md section 4).

/**
 * A rent tax item's status (plan 5.1), derived by the API from what settled or reversed it: the
 * domain's statuses and words, so the screen says what the report's PDF and CSV say. A
 * `correction` is a reversal of earlier tax (a payment reversed, or tax replaced by withholding).
 */
export type RentTaxStatus = TaxItemStatus;
export const RENT_TAX_STATUSES = TAX_ITEM_STATUSES;
export const RENT_TAX_STATUS_LABELS: Record<RentTaxStatus, string> = TAX_ITEM_STATUS_LABELS;

/** What an item is the tax on (P17, P19, P21, P29), for a row that is not a plain receipt. */
export const TAX_ITEM_KIND_LABELS: Record<TaxItemKind, string> = {
  receipt: 'Rent received',
  carry_over: 'Credit carried to a renewal',
  withholding: 'Withheld by the tenant',
  reversal: 'Payment reversed',
  withholding_offset: 'Replaced by withholding',
};

/**
 * What an item is the tax on, in words. A receipt's item that names a withholding is the tax on
 * cash the withholding released and the payment then put on another month (M5 review).
 */
export function taxItemLabel(item: {
  readonly kind: TaxItemKind;
  readonly withholdingId?: string | null;
}): string {
  if (item.kind === 'receipt' && item.withholdingId)
    return 'Tax on rent this payment now covers, after the withholding moved it';
  return TAX_ITEM_KIND_LABELS[item.kind];
}

/** The days the items' rules rows hold (`rent_tax.due_days_after_receipt`, `rent_tax.alert_days`). */
export interface DueRuleFacts {
  readonly dueDays?: number | null;
  readonly alertDays?: readonly number[];
}

const dayList = (days: readonly number[]): string => {
  const sorted = [...new Set(days)].sort((a, b) => a - b).map(String);
  return sorted.length <= 1
    ? (sorted[0] ?? '')
    : `${sorted.slice(0, -1).join(', ')} and ${sorted.at(-1)}`;
};

/**
 * The due rule in words, from the items' own rules rows, never a value written in the code
 * (CLAUDE.md section 7): `due 30 days after the rent was received` and `at 21 and 28 days`. Items
 * under different rule versions are named together; with none known, each item's date speaks.
 */
export function dueRuleText(items: readonly DueRuleFacts[]): {
  readonly due: string;
  readonly alerts: string | null;
} {
  const dueDays = [
    ...new Set(items.flatMap((i) => (typeof i.dueDays === 'number' ? [i.dueDays] : []))),
  ];
  const alertSets = [
    ...new Set(items.flatMap((i) => (i.alertDays?.length ? [dayList(i.alertDays)] : []))),
  ];
  const due =
    dueDays.length === 0
      ? 'due by the date shown on each item'
      : `due ${dayList(dueDays)} days after the rent was received`;
  const alerts =
    alertSets.length === 0
      ? null
      : alertSets.length === 1
        ? `at ${alertSets[0]} days`
        : `${alertSets.map((set) => `at ${set} days`).join(' or ')}, by each item’s rule`;
  return { due, alerts };
}

/** Why a receipt's rent tax was not assessed (TX-08), as the API names the reason. */
export const NOT_ASSESSED_REASON_LABELS: Record<'rule_missing' | 'rule_unsupported', string> = {
  rule_missing: 'No rules row was in force for it',
  rule_unsupported: 'Its rules row holds a value this version cannot apply',
};

/** What was not assessed: money received, credit carried to a renewal, or tax withheld. */
export const NOT_ASSESSED_EVENT_LABELS: Record<'receipt' | 'carry_over' | 'withholding', string> = {
  receipt: 'Rent received',
  carry_over: 'Credit carried to a renewal',
  withholding: 'Withheld by the tenant',
};

/** Still owed to GRA by the owner: an item withheld by the tenant is the tenant's to pay (P19). */
const OWED: ReadonlySet<RentTaxStatus> = new Set(['open', 'part_paid']);
export const isOwed = (status: RentTaxStatus): boolean => OWED.has(status);

/** What a due date needs to be read: the item's dates and status, as the API sends them. */
export interface DueItem {
  readonly status: RentTaxStatus;
  /** The day the rent was received: tax is due a set number of days after it (TX-02). */
  readonly valueDate: string;
  /** None on a correction, which is never owed. */
  readonly dueDate: string | null;
  /**
   * TX-02: the alert days (21, 28 by the rule version the item used) it has reached by today, as
   * the due list's API reads them; absent where the API does not say (a report's items).
   */
  readonly alertsReached?: readonly number[];
}

export type DueState =
  /** Paid, withheld by the tenant or reversed: nothing to alert (TX-02). */
  | { readonly kind: 'none' }
  | { readonly kind: 'upcoming'; readonly daysLeft: number }
  /** An alert day has come: `day` days after the rent was received. */
  | { readonly kind: 'alert'; readonly day: number; readonly daysLeft: number }
  | { readonly kind: 'overdue'; readonly daysOver: number };

const days = (from: string, to: string): number =>
  daysBetween(parseBusinessDate(from), parseBusinessDate(to));

/** Where an item stands on `today` (TX-02): due, past an alert day its rule sets, or overdue. */
export function dueState(item: DueItem, today: string): DueState {
  if (!isOwed(item.status) || item.dueDate === null) return { kind: 'none' };
  const daysLeft = days(today, item.dueDate);
  if (daysLeft < 0) return { kind: 'overdue', daysOver: -daysLeft };
  // The latest alert the API says the item has reached (the domain's `rentTaxAlertsReached`).
  const reached = item.alertsReached ?? [];
  if (reached.length === 0) return { kind: 'upcoming', daysLeft };
  return { kind: 'alert', day: Math.max(...reached), daysLeft };
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

function whenDue(daysLeft: number, dueDate: string): string {
  if (daysLeft === 0) return `due today, ${formatBusinessDate(dueDate)}`;
  return `due ${formatBusinessDate(dueDate)}, in ${plural(daysLeft, 'day')}`;
}

/** The due state in words, for the due list and the report. */
export function dueLabel(item: DueItem, today: string): string {
  const state = dueState(item, today);
  const dueDate = item.dueDate ?? '';
  switch (state.kind) {
    case 'none':
      return RENT_TAX_STATUS_LABELS[item.status];
    case 'upcoming': {
      const text = whenDue(state.daysLeft, dueDate);
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
    case 'alert':
      return `${state.day}-day alert: ${whenDue(state.daysLeft, dueDate)}`;
    case 'overdue':
      return `Overdue by ${plural(state.daysOver, 'day')}: it was due ${formatBusinessDate(dueDate)}`;
  }
}

/** The tone of a due state, for its badge. */
export function dueTone(state: DueState): 'green' | 'blue' | 'amber' | 'red' | 'dark' {
  switch (state.kind) {
    case 'none':
      return 'dark';
    case 'upcoming':
      return 'blue';
    case 'alert':
      return 'amber';
    case 'overdue':
      return 'red';
  }
}

/** An item as the due list and the GRA payment form need it. */
export interface OwedItem extends DueItem {
  readonly id: string;
  readonly receiptNumber: string | null;
  readonly taxMinor: number;
  /** What is still to pay to GRA on it. */
  readonly outstandingMinor: number;
}

/** A receipt's rent tax as the screens show it: what it was worked out on, and where it stands. */
export interface TaxItemRow extends OwedItem {
  readonly kind?: TaxItemKind;
  /** On a receipt: the withholding that released the cash this tax is on (M5 review). */
  readonly withholdingId?: string | null;
  /** A rule the item used is not verified (the API's flag): the row says so (section 7). */
  readonly warning?: boolean;
  /** The payment taxed; none on tax withheld by the tenant without a payment. */
  readonly paymentId: string | null;
  readonly ownerId: string;
  readonly unitCode: string;
  readonly tenantName: string;
  /** The rent (and service charge, while the rule says so) the receipt newly covers. */
  readonly baseMinor: number;
  readonly rateBps: number;
}

/**
 * Oldest first: by due date, then id (time-ordered), the order the domain's `settleOldestFirst`
 * takes, so the items a GRA payment ticks by default are always the first ones listed.
 */
export function oldestFirst<T extends OwedItem>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** The due list (TX-02): items still owed to GRA, oldest first. Withheld items are not on it. */
export function dueList<T extends OwedItem>(items: readonly T[]): T[] {
  return oldestFirst(items.filter((item) => isOwed(item.status) && item.outstandingMinor > 0));
}

/** How many items are overdue or alerted on `today`, for the list's heading. */
export function dueCounts(
  items: readonly OwedItem[],
  today: string,
): { readonly overdue: number; readonly alerted: number } {
  let overdue = 0;
  let alerted = 0;
  for (const item of dueList(items)) {
    const state = dueState(item, today);
    if (state.kind === 'overdue') overdue += 1;
    if (state.kind === 'alert') alerted += 1;
  }
  return { overdue, alerted };
}

// Recording a GRA payment (P18, TX-03) --------------------------------------------------------

export interface Settlement {
  readonly itemId: string;
  readonly amountMinor: number;
}

export interface SettlementPlan {
  /** What each chosen item takes, oldest first; the last may be part paid. */
  readonly lines: readonly Settlement[];
  /** Left over when the chosen items owe less than the amount. */
  readonly unappliedMinor: number;
}

/**
 * Applies a GRA payment to the items it settles, oldest first (plan 5.3), by the domain's own rule
 * (`settleOldestFirst`), so the screen offers what the API would choose. With no choice made
 * (`chosen` null) the items follow the amount: the oldest items owed, as many as it pays. Once
 * someone ticks items, only those take the amount, still oldest first. An amount beyond what they
 * owe settles them all and says what is left over, rather than refusing as the API does.
 */
export function settlementPlan(
  items: readonly OwedItem[],
  amountMinor: number,
  chosen: readonly string[] | null,
): SettlementPlan {
  const ticked = chosen === null ? null : new Set(chosen);
  // An item owed to GRA always has a due date; a correction never reaches this list.
  const open = dueList(items)
    .filter((item) => !ticked || ticked.has(item.id))
    .map((item) => ({ ...item, dueDate: item.dueDate ?? '' }));
  const owed = open.reduce((sum, item) => sum + item.outstandingMinor, 0);
  if (amountMinor <= 0 || open.length === 0)
    return { lines: [], unappliedMinor: Math.max(0, amountMinor) };
  if (amountMinor > owed)
    return {
      lines: settleOldestFirst(open, owed),
      unappliedMinor: amountMinor - owed,
    };
  return { lines: settleOldestFirst(open, amountMinor), unappliedMinor: 0 };
}

/** The items ticked on screen: the person's own choice, or those the amount pays, oldest first. */
export function tickedItems(
  items: readonly OwedItem[],
  amountMinor: number | null,
  chosen: readonly string[] | null,
): string[] {
  if (chosen !== null) return [...chosen];
  if (amountMinor === null) return [];
  return settlementPlan(items, amountMinor, null).lines.map((line) => line.itemId);
}

/** The total still owed on the ticked items: what a payment for them all would be. */
export function owedOn(items: readonly OwedItem[], ids: readonly string[]): number {
  const set = new Set(ids);
  return dueList(items)
    .filter((item) => set.has(item.id))
    .reduce((sum, item) => sum + item.outstandingMinor, 0);
}

export interface GraPaymentDraft {
  readonly paidOn: string;
  readonly amount: string;
  readonly graReceiptNumber: string;
  /** Where the money came from: the owner's own account (1010) or the agency's (1070). */
  readonly paidFrom: ReceivingAccount | '';
  readonly note: string;
  /** The items ticked by hand, or null while they follow the amount. */
  readonly chosen: readonly string[] | null;
}

export type GraPaymentField = Exclude<keyof GraPaymentDraft, 'chosen'> | 'items';

export const emptyGraPayment = (today: string, agency: boolean): GraPaymentDraft => ({
  paidOn: today,
  amount: '',
  graReceiptNumber: '',
  // A landlord pays from their own account; an agency says which.
  paidFrom: agency ? '' : 'owner_account',
  note: '',
  chosen: null,
});

/** A GRA payment as `POST /gra-payments` takes it, without the receipt, which is uploaded first. */
export type GraPaymentInput = Omit<
  Parameters<ApiClient['rentTax']['recordGraPayment']>[0],
  'receiptUploadId'
>;

/** The longest GRA receipt number and note the forms take: the contract's, which the API checks. */
export const GRA_LIMITS = {
  receiptNumberMax: TAX_LIMITS.graReceiptNumberMax,
  noteMax: TAX_LIMITS.noteMax,
} as const;

/**
 * The GRA payment form (P18; plan 5.3): the date, amount and GRA receipt number, where it was
 * paid from, and the items it settles, oldest first unless ticked otherwise. The amount must be
 * taken up in full by the items chosen; the API checks every figure again.
 */
export function graPaymentForm(
  draft: GraPaymentDraft,
  context: { readonly ownerId: string | null; readonly items: readonly OwedItem[] },
  today: string,
): Parsed<GraPaymentInput, GraPaymentField> & {
  /** The amount typed, once it reads as one; the ticks follow it until someone ticks by hand. */
  readonly amountMinor: number | null;
  readonly plan: SettlementPlan | null;
} {
  const errors: Partial<Record<GraPaymentField, string>> = {};
  const amount = amountMinorOf(draft.amount);
  if (amount.problem) errors.amount = amount.problem;
  const date = pastDateProblem(draft.paidOn, today, 'it was paid to GRA');
  if (date) errors.paidOn = date;
  const receipt = draft.graReceiptNumber.trim();
  if (!receipt) errors.graReceiptNumber = 'Enter the number on the GRA receipt';
  else if (receipt.length > GRA_LIMITS.receiptNumberMax)
    errors.graReceiptNumber = `Use at most ${GRA_LIMITS.receiptNumberMax} characters`;
  if (!draft.paidFrom) errors.paidFrom = 'Choose the account it was paid from';
  if (draft.note.trim().length > GRA_LIMITS.noteMax)
    errors.note = `Use at most ${GRA_LIMITS.noteMax} characters`;
  const plan =
    amount.value === null ? null : settlementPlan(context.items, amount.value, draft.chosen);
  if (!context.ownerId) errors.items = 'Choose the owner first';
  else if (dueList(context.items).length === 0)
    errors.items = 'Nothing is owed to GRA for this owner';
  else if (plan && plan.lines.length === 0)
    errors.items = 'Tick the tax items this payment settles';
  else if (plan && plan.unappliedMinor > 0)
    errors.items = `The items ticked owe ${formatMinor((amount.value ?? 0) - plan.unappliedMinor)}, less than the payment. Tick more items, or check the amount.`;
  if (
    Object.keys(errors).length ||
    !context.ownerId ||
    amount.value === null ||
    !plan ||
    !draft.paidFrom
  )
    return { input: null, errors, amountMinor: amount.value, plan };
  return {
    input: {
      ownerId: context.ownerId,
      paidOn: draft.paidOn,
      amountMinor: amount.value,
      graReceiptNumber: receipt,
      paidFrom: draft.paidFrom,
      note: draft.note.trim() || null,
      items: [...plan.lines],
    },
    errors: {},
    amountMinor: amount.value,
    plan,
  };
}

// The report's period (TX-03) ------------------------------------------------------------------

export interface Period {
  readonly from: string;
  readonly to: string;
}

const ISO_MONTH = /^(\d{4})-(\d{2})$/;

/** The first and last day of a month such as `2026-11`, or null for anything else. */
export function monthPeriod(month: string): Period | null {
  const match = ISO_MONTH.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const m = Number(match[2]);
  if (m < 1 || m > 12) return null;
  const from = parseBusinessDate(`${match[1]}-${match[2]}-01`);
  const to = addDays(addMonths(from, 1), -1);
  if (to.year !== year) return null;
  return { from: toIsoDate(from), to: toIsoDate(to) };
}

/** The month a business date falls in, as `2026-11`. */
export const monthOf = (date: string): string => date.slice(0, 7);

/** The month before the one `today` falls in: a return is usually filed for the month gone. */
export function previousMonth(today: string): string {
  return toIsoDate(addMonths(parseBusinessDate(today), -1)).slice(0, 7);
}

/** `November 2026`. */
export function monthLabel(month: string): string {
  const period = monthPeriod(month);
  if (!period) return month;
  return parseBusinessDate(period.from).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
}

/** A period in words: a whole month by its name, otherwise from and to. */
export function periodWords(period: Period): string {
  const month = monthOf(period.from);
  const whole = monthPeriod(month);
  if (whole && whole.from === period.from && whole.to === period.to) return monthLabel(month);
  return `${formatBusinessDate(period.from)} to ${formatBusinessDate(period.to)}`;
}

/** A period read from the address, or null: `from` and `to` as dates, `from` not after `to`. */
export function parsePeriod(from: string | null, to: string | null): Period | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !iso.test(from) || !iso.test(to)) return null;
  try {
    parseBusinessDate(from);
    parseBusinessDate(to);
  } catch {
    return null;
  }
  return from <= to ? { from, to } : null;
}
