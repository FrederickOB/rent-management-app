import type { OwnerStatementDetail, OwnerStatementFiguresView } from '@rent/contracts';
import {
  AGENT_CASH_IN,
  AGENT_CASH_OUT,
  COLLECTION_METHODS,
  type AgentCashIn,
  type AgentCashOut,
  type StatementCheckName,
} from '@rent/domain/reporting';
import { errorCode } from './errors';
import { bucketsOf, COLLECTION_METHOD_LABELS, ratioText } from './reporting';
import { monthLabel } from './rent-tax';

// Owner statements (AC-04; M9 decisions 5 to 7 and 15): the month in the company's time zone, a
// page per property and a summary, the agent's side, and the checks the figures must meet. Times
// are shown in the owner's time zone, named. Every figure is the API's, from the ledger.

export type StatementPage = OwnerStatementFiguresView['summary'];

export interface StatementRow {
  readonly key: string;
  readonly label: string;
  readonly amountMinor: number;
  readonly strong?: boolean;
  /** Indented under the row before it. */
  readonly part?: boolean;
}

export const STATEMENT_CHECK_LABELS: Record<StatementCheckName, string> = {
  agent_cash: 'Cash held by the agent: opening, plus money in, less money out, equals closing',
  fees_due: 'Fees due: opening, plus charged, less taken and settled, equals closing',
  rent_tax_receipts: 'Rent tax: the month’s total equals the tax on each receipt',
  rent_tax_payable:
    'Rent tax payable: opening, plus accrued, less paid and certified, equals closing',
};

export const AGENT_CASH_IN_LABELS: Record<AgentCashIn, string> = {
  collections: 'Rent and charges collected',
  owner_funding: 'Money the owner sent for bills',
  other_in: 'Other money in',
};

export const AGENT_CASH_OUT_LABELS: Record<AgentCashOut, string> = {
  expenses_paid: 'Expenses paid',
  fees_taken: 'Management fees taken',
  rent_tax_paid: 'Rent tax paid to GRA',
  vat_paid: 'VAT paid to GRA',
  refunds_paid: 'Refunds paid to tenants',
  remittances: 'Paid to the owner',
  reversals: 'Payments reversed',
  other_out: 'Other money out',
};

/** The cash section of a page: collections by method, expenses, fees and rent tax. */
export function cashRows(page: StatementPage): StatementRow[] {
  const c = page.cash;
  return [
    { key: 'collections', label: 'Collected', amountMinor: c.collectionsMinor, strong: true },
    ...COLLECTION_METHODS.filter((m) => c.collectionsByMethod[m] !== 0).map((m) => ({
      key: `collected-${m}`,
      label: COLLECTION_METHOD_LABELS[m],
      amountMinor: c.collectionsByMethod[m],
      part: true,
    })),
    { key: 'expenses', label: 'Expenses', amountMinor: c.expensesMinor, strong: true },
    ...c.expensesByCategory.map((e) => ({
      key: `expense-${e.category}`,
      label: e.category,
      amountMinor: e.amountMinor,
      part: true,
    })),
    { key: 'fees', label: 'Management fees charged', amountMinor: c.feesMinor },
    {
      key: 'tax-accrued',
      label: 'Rent tax on the month’s receipts',
      amountMinor: c.rentTaxAccruedMinor,
    },
    { key: 'tax-paid', label: 'Rent tax paid to GRA', amountMinor: c.rentTaxPaidMinor },
  ];
}

/** The accrual section of a page, at the month's end: earned, unearned, deposits and arrears. */
export function accrualRows(page: StatementPage): StatementRow[] {
  const a = page.accrual;
  return [
    { key: 'earned', label: 'Earned in the month', amountMinor: a.earnedMinor, strong: true },
    { key: 'rent-earned', label: 'Rent', amountMinor: a.rentEarnedMinor, part: true },
    {
      key: 'service-earned',
      label: 'Service charge',
      amountMinor: a.serviceChargeEarnedMinor,
      part: true,
    },
    {
      key: 'unearned',
      label: 'Paid ahead, not yet earned',
      amountMinor: a.unearnedMinor,
      strong: true,
    },
    { key: 'rent-unearned', label: 'Rent', amountMinor: a.unearnedRentMinor, part: true },
    {
      key: 'service-unearned',
      label: 'Service charge',
      amountMinor: a.unearnedServiceChargeMinor,
      part: true,
    },
    { key: 'deposits', label: 'Deposits held', amountMinor: a.depositsHeldMinor, strong: true },
    { key: 'arrears', label: 'Arrears', amountMinor: a.arrearsMinor, strong: true },
    ...bucketsOf(a.arrearsByBucket).map((b) => ({
      key: `arrears-${b.bucket}`,
      label: b.label,
      amountMinor: b.amountMinor,
      part: true,
    })),
  ];
}

/** Occupancy of a page at the month's end, in words. */
export function occupancyRows(page: StatementPage): { label: string; value: string }[] {
  const o = page.occupancy;
  return [
    { label: 'Occupied', value: `${o.occupied} of ${o.lettable} lettable (${ratioText(o.rate)})` },
    { label: 'Vacant', value: String(o.vacant) },
    { label: 'Reserved for a signed lease', value: String(o.reserved) },
    { label: 'Under repair', value: String(o.underRepair) },
    { label: 'Not lettable', value: String(o.notLettable) },
  ];
}

/** The agent's side (summary page), as rows in the order the money moved. */
export function agentRows(agent: NonNullable<OwnerStatementFiguresView['agent']>): StatementRow[] {
  return [
    {
      key: 'opening',
      label: 'Held for the owner at the start of the month',
      amountMinor: agent.openingMinor,
      strong: true,
    },
    ...AGENT_CASH_IN.filter((k) => agent.in[k] !== 0).map((k) => ({
      key: `in-${k}`,
      label: AGENT_CASH_IN_LABELS[k],
      amountMinor: agent.in[k],
      part: true,
    })),
    ...AGENT_CASH_OUT.filter((k) => agent.out[k] !== 0).map((k) => ({
      key: `out-${k}`,
      label: AGENT_CASH_OUT_LABELS[k],
      amountMinor: -agent.out[k],
      part: true,
    })),
    {
      key: 'closing',
      label: 'Held for the owner at the end of the month',
      amountMinor: agent.closingMinor,
      strong: true,
    },
    {
      key: 'fees-due',
      label: 'Management fees due at the end of the month',
      amountMinor: agent.feesDueClosingMinor,
    },
    ...(agent.rentTaxHeldBackMinor !== 0
      ? [
          {
            key: 'tax-held',
            label: 'Rent tax held back for GRA (the agency pays it)',
            amountMinor: agent.rentTaxHeldBackMinor,
          },
        ]
      : []),
    ...(agent.reserveMinor !== 0
      ? [{ key: 'reserve', label: 'Reserve kept', amountMinor: agent.reserveMinor }]
      : []),
    {
      key: 'net',
      label: 'Could be paid to the owner',
      amountMinor: agent.netRemittableMinor,
      strong: true,
    },
    {
      key: 'remitted',
      label: 'Paid to the owner in the month',
      amountMinor: agent.remittancesMadeMinor,
    },
  ];
}

/** Checks that failed, said plainly: a statement that fails one is never issued. */
export const failedChecks = (figures: Pick<OwnerStatementFiguresView, 'checks'>) =>
  figures.checks.filter((c) => !c.passed);

/** The pages in order: each property by name, then the summary. */
export function statementPages(
  detail: Pick<OwnerStatementDetail, 'figures' | 'properties'>,
): { key: string; title: string; page: StatementPage }[] {
  const names = new Map(detail.properties.map((p) => [p.id, p.name]));
  return [
    ...detail.figures.properties.map((page, index) => ({
      key: page.propertyId ?? `p${index}`,
      title: (page.propertyId && names.get(page.propertyId)) ?? 'A property',
      page,
    })),
    { key: 'summary', title: 'Summary: every property', page: detail.figures.summary },
  ];
}

/** "Issuing locks October 2026 for Ama Owner-London…": the confirmation before issuing. */
export function issueConfirmText(statement: Pick<OwnerStatementDetail, 'month' | 'owner'>): string {
  return `Issuing locks ${monthLabel(statement.month)} for ${statement.owner.name}. The figures are frozen, the PDF is fingerprinted and emailed to the owner’s contacts who agreed to email. Anything recorded later for that month lands in the open month instead, so this statement never changes.`;
}

const STATEMENT_MESSAGES: Readonly<Record<string, string>> = {
  STATEMENT_ISSUED:
    'This statement has already been issued, so it cannot be worked out again or issued twice.',
  MONTH_NOT_OVER:
    'That month is not over yet. A statement can be drafted from the 1st of the next month.',
  STATEMENT_UNBALANCED:
    'The statement’s figures do not meet their checks, so it was not issued. Look at the failing check below.',
  STATEMENT_RENDERING: 'The PDF is still being made. Try again in a moment.',
};

/** The words for a statement refusal the API named, or null for any other answer. */
export const statementMessage = (error: unknown): string | null =>
  STATEMENT_MESSAGES[errorCode(error)] ?? null;

export const isRendering = (error: unknown): boolean => errorCode(error) === 'STATEMENT_RENDERING';

/** The months a statement can be drafted for: the last `count` months before this one. */
export function draftableMonths(today: string, count = 12): string[] {
  const [y, m] = today.slice(0, 7).split('-').map(Number) as [number, number];
  const months: string[] = [];
  let year = y;
  let month = m;
  for (let i = 0; i < count; i += 1) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    months.push(`${year}-${String(month).padStart(2, '0')}`);
  }
  return months;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a check was made: a property by its name, or nothing for the owner as a whole. */
export function checkScopeText(
  check: { readonly scope: string },
  properties: readonly { readonly id: string; readonly name: string }[],
): string | null {
  if (!UUID.test(check.scope)) return null;
  return properties.find((p) => p.id === check.scope)?.name ?? 'a property';
}
