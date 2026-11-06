import type { ExpenseRow } from '@rent/contracts';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_PAID_BY,
  EXPENSE_STATUSES,
  type ExpenseCategory,
  type ExpensePaidBy,
  type ExpenseStatus,
} from '@rent/domain/maintenance';
import { amountMinorOf, pastDateProblem } from './payment-form';

// Expenses (AC-03; M8 decision 8): recorded with a receipt on a property or unit, optionally for a
// job, and posted by P15. A job's cost is the sum of its expenses. Corrections are by reversal and
// a new expense; there is no approval step (MI-05 is P2).

export const CATEGORY_OPTIONS = EXPENSE_CATEGORIES.map((c) => ({
  value: c,
  label: EXPENSE_CATEGORY_LABELS[c],
}));

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  unpaid: 'Not paid yet',
  paid: 'Paid',
  reversed: 'Reversed',
};

/** Who paid, in words; an agency's own account only for an agency (P15: 1070). */
export const PAID_BY_LABELS: Record<ExpensePaidBy, string> = {
  owner: 'The owner paid it',
  agent: 'The agency paid it',
  unpaid: 'Not paid yet: it is owed to the supplier',
};

export const paidByOptions = (agency: boolean) =>
  EXPENSE_PAID_BY.filter((p) => agency || p !== 'agent').map((p) => ({
    value: p,
    label: PAID_BY_LABELS[p],
  }));

export const expenseCategoryOf = (value: string): ExpenseCategory | null =>
  EXPENSE_CATEGORIES.find((c) => c === value) ?? null;
export const expenseStatusOf = (value: string): ExpenseStatus | null =>
  EXPENSE_STATUSES.find((s) => s === value) ?? null;
export const paidByOf = (value: string): ExpensePaidBy | null =>
  EXPENSE_PAID_BY.find((p) => p === value) ?? null;

export interface ExpenseDraft {
  readonly propertyId: string;
  readonly unitId: string;
  readonly category: ExpenseCategory | '';
  readonly supplierName: string;
  readonly amount: string;
  readonly expenseDate: string;
  readonly paidBy: ExpensePaidBy | '';
  readonly jobId: string;
  readonly note: string;
}

export const emptyExpense = (
  today: string,
  jobId = '',
  propertyId = '',
  unitId = '',
): ExpenseDraft => ({
  propertyId,
  unitId,
  category: jobId ? 'repairs' : '',
  supplierName: '',
  amount: '',
  expenseDate: today,
  paidBy: '',
  jobId,
  note: '',
});

export type ExpenseField = keyof ExpenseDraft;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExpenseInput {
  propertyId: string;
  unitId: string | null;
  category: ExpenseCategory;
  supplierName: string;
  amountMinor: number;
  expenseDate: string;
  paidBy: ExpensePaidBy;
  jobId: string | null;
  note: string | null;
}

/** An expense as the API takes it (without the receipt the page adds), or the problems. */
export function expenseInput(
  draft: ExpenseDraft,
  today: string,
  agency: boolean,
): { readonly input: ExpenseInput | null; readonly errors: Partial<Record<ExpenseField, string>> } {
  const errors: Partial<Record<ExpenseField, string>> = {};
  if (!UUID.test(draft.propertyId)) errors.propertyId = 'Choose the property';
  if (draft.unitId && !UUID.test(draft.unitId)) errors.unitId = 'Choose a unit from the list';
  if (!draft.category) errors.category = 'Choose the category';
  const supplier = draft.supplierName.trim();
  if (supplier.length < 2) errors.supplierName = 'Enter who was paid, or is owed';
  else if (supplier.length > 120) errors.supplierName = 'Use at most 120 characters';
  const amount = amountMinorOf(draft.amount);
  if (amount.problem) errors.amount = amount.problem;
  const date = pastDateProblem(draft.expenseDate, today, 'of the expense');
  if (date) errors.expenseDate = date;
  if (!draft.paidBy) errors.paidBy = 'Choose who paid';
  else if (draft.paidBy === 'agent' && !agency)
    errors.paidBy = 'Only an agency pays from its own account';
  if (draft.jobId && !UUID.test(draft.jobId)) errors.jobId = 'Choose a job from the list';
  if (draft.note.trim().length > 500) errors.note = 'Use at most 500 characters';
  if (Object.keys(errors).length > 0 || !draft.category || !draft.paidBy || amount.value === null)
    return { input: null, errors };
  return {
    input: {
      propertyId: draft.propertyId,
      unitId: draft.unitId || null,
      category: draft.category,
      supplierName: supplier,
      amountMinor: amount.value,
      expenseDate: draft.expenseDate,
      paidBy: draft.paidBy,
      jobId: draft.jobId || null,
      note: draft.note.trim() || null,
    },
    errors: {},
  };
}

/** Paying a payable later (P15: Dr 2500): the date, the account and an optional reference. */
export function payInput(
  draft: { readonly paidOn: string; readonly paidFrom: string; readonly reference: string },
  expense: Pick<ExpenseRow, 'expenseDate'>,
  today: string,
): {
  readonly input: {
    paidOn: string;
    paidFrom: 'owner_account' | 'agency_account';
    reference: string | null;
  } | null;
  readonly errors: Partial<Record<'paidOn' | 'paidFrom' | 'reference', string>>;
} {
  const errors: Partial<Record<'paidOn' | 'paidFrom' | 'reference', string>> = {};
  const date = pastDateProblem(draft.paidOn, today, 'it was paid');
  if (date) errors.paidOn = date;
  else if (draft.paidOn < expense.expenseDate)
    errors.paidOn = 'It cannot be paid before the expense date';
  const paidFrom =
    draft.paidFrom === 'owner_account' || draft.paidFrom === 'agency_account'
      ? draft.paidFrom
      : null;
  if (!paidFrom) errors.paidFrom = 'Choose the account it was paid from';
  const reference = draft.reference.trim();
  if (reference.length > 120) errors.reference = 'Use at most 120 characters';
  if (Object.keys(errors).length > 0 || !paidFrom) return { input: null, errors };
  return { input: { paidOn: draft.paidOn, paidFrom, reference: reference || null }, errors: {} };
}

/** The total of expenses in force (not reversed), as a job's cost is worked out (decision 8). */
export const expensesTotal = (
  rows: readonly Pick<ExpenseRow, 'amountMinor' | 'status'>[],
): number => rows.filter((r) => r.status !== 'reversed').reduce((sum, r) => sum + r.amountMinor, 0);

export interface ExpenseFilters {
  readonly propertyId: string;
  readonly status: ExpenseStatus | '';
  readonly category: ExpenseCategory | '';
  readonly from: string;
  readonly to: string;
  readonly jobId: string;
}

export const DEFAULT_EXPENSE_FILTERS: ExpenseFilters = {
  propertyId: '',
  status: '',
  category: '',
  from: '',
  to: '',
  jobId: '',
};

/** The list call for the filters chosen: only what is set, and dates the right way round. */
export function expenseQuery(filters: ExpenseFilters): {
  propertyId?: string;
  status?: ExpenseStatus;
  category?: ExpenseCategory;
  from?: string;
  to?: string;
  jobId?: string;
} {
  const query: ReturnType<typeof expenseQuery> = {};
  if (UUID.test(filters.propertyId)) query.propertyId = filters.propertyId;
  if (filters.status) query.status = filters.status;
  if (filters.category) query.category = filters.category;
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const from = iso.test(filters.from) ? filters.from : '';
  const to = iso.test(filters.to) ? filters.to : '';
  if (from && to && from > to) {
    query.from = to;
    query.to = from;
  } else {
    if (from) query.from = from;
    if (to) query.to = to;
  }
  if (UUID.test(filters.jobId)) query.jobId = filters.jobId;
  return query;
}

/**
 * F3 (M8 review): a receipt is optional, and an expense without one is flagged "No receipt" on
 * the list (M9 carries the flag onto the owner statement). The API decides the flag
 * (`noReceipt`); a reversed expense is not flagged here, as it no longer counts.
 */
export const NO_RECEIPT = 'No receipt';
export const needsReceiptFlag = (row: Pick<ExpenseRow, 'noReceipt' | 'status'>): boolean =>
  row.noReceipt && row.status !== 'reversed';
