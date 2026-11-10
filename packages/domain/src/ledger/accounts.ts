/**
 * The chart of accounts (architecture section 4; ADR-003). Each journal line belongs to a book,
 * and each account may appear only in the kinds of book listed for it.
 */
export const BOOK_KINDS = ['owner', 'company', 'platform'] as const;
export type BookKind = (typeof BOOK_KINDS)[number];

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface LedgerAccount {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly books: readonly BookKind[];
}

const account = (
  code: string,
  name: string,
  type: AccountType,
  books: readonly BookKind[],
): LedgerAccount => ({ code, name, type, books });

export const ACCOUNTS = [
  account('1010', 'Own bank and MoMo accounts', 'asset', ['owner', 'company', 'platform']),
  account('1050', 'Payment provider clearing', 'asset', ['owner', 'company', 'platform']),
  account('1060', 'Undeposited cash and cheques', 'asset', ['owner']),
  account('1070', 'Cash held by managing agent', 'asset', ['owner', 'company']),
  account('1100', 'Tenant receivables', 'asset', ['owner', 'platform']),
  account('1150', 'Withholding tax receivable', 'asset', ['owner']),
  account('1160', 'Withholding tax credits', 'asset', ['owner']),
  account('2010', 'Tenant prepayments', 'liability', ['owner']),
  account('2020', 'Deferred subscription revenue', 'liability', ['platform']),
  account('2090', 'Unmatched receipts', 'liability', ['owner', 'company']),
  account('2100', 'Security deposits held', 'liability', ['owner']),
  account('2200', 'Rent tax payable', 'liability', ['owner']),
  // M10 decision 10: VAT on subscription invoices, when charged, lands in the platform book.
  account('2210', 'VAT and levies payable', 'liability', ['owner', 'platform']),
  account('2300', 'Due to managing agent', 'liability', ['owner']),
  account('2400', 'Refunds payable to tenants', 'liability', ['owner']),
  account('2500', 'Supplier payables', 'liability', ['owner']),
  account('3900', 'Opening balances', 'equity', ['owner']),
  account('4000', 'Rent income', 'income', ['owner']),
  account('4100', 'Service charge income', 'income', ['owner']),
  account('4200', 'Other tenant charges', 'income', ['owner']),
  account('4300', 'Deposit deductions retained', 'income', ['owner']),
  account('4600', 'Subscription revenue', 'income', ['platform']),
  account('5000', 'Repairs and maintenance', 'expense', ['owner']),
  account('5100', 'Management fees', 'expense', ['owner']),
  account('5200', 'Payment processing fees', 'expense', ['owner', 'company', 'platform']),
  account('5300', 'Rent tax', 'expense', ['owner']),
  account('5400', 'Other property expenses', 'expense', ['owner']),
  account('5900', 'Bad debts written off', 'expense', ['owner']),
] as const satisfies readonly LedgerAccount[];

export type AccountCode = (typeof ACCOUNTS)[number]['code'];

const BY_CODE: ReadonlyMap<string, LedgerAccount> = new Map(ACCOUNTS.map((a) => [a.code, a]));

export const isAccountCode = (code: string): code is AccountCode => BY_CODE.has(code);

export function accountOf(code: AccountCode): LedgerAccount {
  return BY_CODE.get(code) as LedgerAccount;
}

export const accountAllowedIn = (code: AccountCode, kind: BookKind): boolean =>
  accountOf(code).books.includes(kind);

/** Income accounts: deposit money must never reach one (BC-11, invariant 4). */
export const INCOME_ACCOUNTS: readonly AccountCode[] = ACCOUNTS.filter(
  (a) => a.type === 'income',
).map((a) => a.code);

/**
 * Where money a tenant paid sits now: with a provider (1050), in a collector's hand (1060), in
 * the owner's own account (1010) or with the managing agent (1070). "The cash side" of an entry.
 */
export const CASH_ACCOUNTS = ['1050', '1060', '1010', '1070'] as const;
export type CashAccount = (typeof CASH_ACCOUNTS)[number];
