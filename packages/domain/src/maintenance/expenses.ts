import { DomainError } from '../errors';

/**
 * Expenses (AC-03; M8 decision 8): recorded with a receipt, categorised and allocated to a property
 * or unit, and posted by P15. A job's cost is the sum of its expenses. Corrections are by reversal
 * (P21a) and a new expense; there is no approval step (quotes and limits are MI-05, P2).
 */
export const EXPENSE_CATEGORIES = [
  'repairs',
  'rates',
  'insurance',
  'utilities',
  'cleaning',
  'security',
  'legal',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  repairs: 'Repairs and maintenance',
  rates: 'Property rates',
  insurance: 'Insurance',
  utilities: 'Utilities',
  cleaning: 'Cleaning',
  security: 'Security',
  legal: 'Legal',
  other: 'Other',
};

/** P15: repairs go to 5000, everything else to 5400 (architecture section 4). */
export const expenseAccountOf = (category: ExpenseCategory): '5000' | '5400' =>
  category === 'repairs' ? '5000' : '5400';

/** Who paid: the owner from their own account (1010), the agent (1070), or nobody yet (2500). */
export const EXPENSE_PAID_BY = ['owner', 'agent', 'unpaid'] as const;
export type ExpensePaidBy = (typeof EXPENSE_PAID_BY)[number];

export const EXPENSE_STATUSES = ['unpaid', 'paid', 'reversed'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/** Checks an expense as entered: amount, supplier and date. */
export function checkExpense(input: {
  readonly amountMinor: number;
  readonly supplierName: string;
  readonly expenseDate: string;
  readonly today: string;
  readonly paidBy: ExpensePaidBy;
  readonly companyKind: 'agency' | 'landlord' | string;
}): void {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new DomainError('expense.amount', 'An expense is an amount above zero');
  const supplier = input.supplierName.trim();
  if (supplier.length < 2 || supplier.length > 120)
    throw new DomainError('expense.supplier', 'Name the supplier (up to 120 characters)');
  if (input.expenseDate > input.today)
    throw new DomainError('expense.future', 'An expense cannot be dated in the future');
  if (input.paidBy === 'agent' && input.companyKind !== 'agency')
    throw new DomainError('expense.paid_by', 'Only an agency pays expenses as the agent');
}
