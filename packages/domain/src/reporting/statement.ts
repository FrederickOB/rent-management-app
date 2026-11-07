import { AGE_BUCKETS, type AgeBucket } from '../billing/walk';
import { DomainError } from '../errors';
import {
  GRA_PAYERS,
  rentTaxHoldBackMinor,
  suggestRemittance,
  type GraPayer,
} from '../ledger/owner-posting';
import {
  addOccupancy,
  occupancyOf,
  type OccupancyCounts,
  type OccupancySummary,
} from './dashboard';
import { byCollectionMethod, COLLECTION_METHODS, type CollectionMethod } from './gate1';
import { reportMonth } from './measures';

/**
 * The monthly owner statement's figures (AC-04; M9 plan decisions 5 to 7; OQ-32: both sections).
 * The caller aggregates the owner's ledger and sub-ledgers for one calendar month, selected by
 * accounting date, so a regenerated statement reads the same rows. This function only arranges
 * and checks them: the output is canonical (properties, methods, categories and buckets in a fixed
 * order, duplicates merged), so the same figures always give an identical statement whatever order
 * the rows arrived in, and `flattenStatementFigures` gives the rows a regeneration compares.
 */

// Inputs.

/** Flows for the month may be negative (a reversal of an earlier month's money lands in this one). */
export interface StatementPropertyInput {
  readonly propertyId: string;
  /** Money received from tenants (payments by accounting date, net of reversals), by method. */
  readonly collections: readonly {
    readonly method: CollectionMethod;
    readonly amountMinor: number;
  }[];
  /** Expenses recorded for the property (P15: 5000 and 5400), by category. */
  readonly expenses: readonly { readonly category: string; readonly amountMinor: number }[];
  /** Management fees charged (5100, net of reversals). */
  readonly feesMinor: number;
  readonly rentTax: {
    /** Rent tax accrued (5300, net of reversals): P17 per receipt. */
    readonly accruedMinor: number;
    /** Rent tax paid to GRA (P18). */
    readonly paidMinor: number;
    /**
     * Each receipt's P17 item with an accounting date in the month, net of its reversals
     * (invariant 6). When given, the accrued figure is checked against their sum (AC-04 ★).
     */
    readonly receiptItemsMinor?: readonly number[];
  };
  /** Rent and service charge earned in the month (4000 and 4100, net of credit notes). */
  readonly rentEarnedMinor: number;
  readonly serviceChargeEarnedMinor: number;
  /**
   * At the month's end (M9 review; the dashboard splits 2010 by the same words): AR-03's rent share
   * of prepayments, money allocated to rent lines whose period has not started; the same for
   * service charge; and the rest of 2010, money held for the tenant and applied to no line (credit).
   * The three add up to 2010.
   */
  readonly unearnedRentMinor: number;
  readonly unearnedServiceChargeMinor?: number;
  readonly creditMinor?: number;
  /** At the month's end: deposits held (2100). */
  readonly depositsHeldMinor: number;
  /** At the month's end: arrears by age (BC-08). */
  readonly arrears: readonly { readonly bucket: AgeBucket; readonly amountMinor: number }[];
  /** At the month's end: the property's units by shown status. */
  readonly occupancy: OccupancyCounts;
}

/** Movements of the owner's cash held by the agent (1070), each as a positive amount. */
export const AGENT_CASH_IN = ['collections', 'owner_funding', 'other_in'] as const;
export type AgentCashIn = (typeof AGENT_CASH_IN)[number];

export const AGENT_CASH_OUT = [
  'expenses_paid',
  'fees_taken',
  'rent_tax_paid',
  'vat_paid',
  'refunds_paid',
  'remittances',
  'reversals',
  'other_out',
] as const;
export type AgentCashOut = (typeof AGENT_CASH_OUT)[number];

/** One journal entry's net effect on the owner's agent-held cash (1070) and fees due (2300). */
export interface AgentCashEntry {
  readonly rule: string;
  /** For a reversal (P21): the rule of the entry it reverses. */
  readonly reversedRule?: string | null;
  /** The entry's 1070 lines, net: positive is money into the agent's hands. */
  readonly cashMinor: number;
  /** The entry's 2300 lines, net. */
  readonly feesMinor: number;
}

export interface AgentCashMovements {
  readonly in: readonly { readonly kind: AgentCashIn; readonly amountMinor: number }[];
  readonly out: readonly { readonly kind: AgentCashOut; readonly amountMinor: number }[];
  /** Fees the provider paid the agent from a settlement split at source (P22, Dr 2300). */
  readonly settledAtSourceMinor: number;
  /**
   * Entries that moved agent cash in a way the statement has no line for (a rule it does not know
   * moves 1070, or a movement the wrong way for its rule). They are left out of money in and out,
   * so the `agent_cash` identity, checked against the 1070 balances themselves, fails and names it.
   */
  readonly unexplained: readonly AgentCashEntry[];
}

/** Rules whose money into 1070 is rent and other money from tenants (P03 to P10 as received). */
const COLLECTION_RULES: ReadonlySet<string> = new Set([
  'P03',
  'P04',
  'P05',
  'P06',
  'P07',
  'P08',
  'P10',
  'P22',
  'P23',
  'P28',
]);

/** Rules whose money out of 1070 is a payment the agent made for the owner. */
const PAYMENT_OUT: Readonly<Record<string, AgentCashOut>> = {
  P15: 'expenses_paid',
  P18: 'rent_tax_paid',
  P33: 'vat_paid',
  P12: 'refunds_paid',
  P13: 'refunds_paid',
  P31: 'refunds_paid',
};

/**
 * The agent's money in and out for the month (decision 6; M9 review: the `agent_cash` identity
 * must be able to fail). Each entry's net 1070 movement is put on the line its rule names, in the
 * direction the rule moves money: collections (in; a provider or collector taking money back, out
 * as a reversal), owner funding (P30, in), payments for the owner (P15, P18, P33, P12, P13, P31,
 * out), opening balances (P25, other), reversals by the rule they reverse (of money in: out as a
 * reversal; of a payment out: money back in), and remittances with the fees retained (P16 and
 * their reversals, split apart and netted over the month; a month whose corrections outweigh its
 * remittances shows the difference as money back in). Anything else is unexplained.
 */
export function agentCashMovements(entries: readonly AgentCashEntry[]): AgentCashMovements {
  const cashIn = new Map<AgentCashIn, number>();
  const cashOut = new Map<AgentCashOut, number>();
  const add = <K>(map: Map<K, number>, key: K, amount: number) =>
    map.set(key, (map.get(key) ?? 0) + amount);
  const unexplained: AgentCashEntry[] = [];
  let feesTaken = 0;
  let remitted = 0;
  let settledAtSource = 0;
  for (const e of entries) {
    const cash = whole(e.cashMinor, 'Agent cash moved');
    const fees = whole(e.feesMinor, 'Fees due moved');
    if (e.rule === 'P22' && fees > 0) settledAtSource += fees;
    if (cash === 0) continue;
    const reversed = e.rule === 'P21' ? (e.reversedRule ?? null) : null;
    if (e.rule === 'P16' || reversed === 'P16') {
      feesTaken += fees;
      remitted += -cash - fees;
    } else if (COLLECTION_RULES.has(e.rule)) {
      if (cash > 0) add(cashIn, 'collections', cash);
      else add(cashOut, 'reversals', -cash);
    } else if (e.rule === 'P30' && cash > 0) add(cashIn, 'owner_funding', cash);
    else if (PAYMENT_OUT[e.rule] && cash < 0) add(cashOut, PAYMENT_OUT[e.rule]!, -cash);
    else if (e.rule === 'P25') {
      if (cash > 0) add(cashIn, 'other_in', cash);
      else add(cashOut, 'other_out', -cash);
    } else if (
      reversed !== null &&
      cash < 0 &&
      (COLLECTION_RULES.has(reversed) || reversed === 'P30' || reversed === 'P25')
    )
      add(cashOut, 'reversals', -cash);
    else if (reversed !== null && cash > 0 && (PAYMENT_OUT[reversed] || reversed === 'P25'))
      add(cashIn, 'other_in', cash);
    else unexplained.push(e);
  }
  if (feesTaken >= 0) add(cashOut, 'fees_taken', feesTaken);
  else add(cashIn, 'other_in', -feesTaken);
  if (remitted >= 0) add(cashOut, 'remittances', remitted);
  else add(cashIn, 'other_in', -remitted);
  return {
    in: [...cashIn].map(([kind, amountMinor]) => ({ kind, amountMinor })),
    out: [...cashOut].map(([kind, amountMinor]) => ({ kind, amountMinor })),
    settledAtSourceMinor: settledAtSource,
    unexplained,
  };
}

/**
 * The agent's side, for an agency-managed owner, at the owner's level: settlements, remittances
 * and funding carry no property, so this is on the summary page only.
 */
export interface StatementAgentInput {
  readonly cash: {
    /** 1070 at the end of the month before, and at this month's end. */
    readonly openingMinor: number;
    readonly closingMinor: number;
    /**
     * In: collections (P22 nets, P28 transfers and P07 cash handed in), owner funding (P30).
     * Out: expenses the agent paid (P15), fees it took (P16), rent tax and VAT it paid (P18, P33),
     * refunds (P12, P13), the net of remittances (P16), and money a reversal took back (P21).
     */
    readonly in: readonly { readonly kind: AgentCashIn; readonly amountMinor: number }[];
    readonly out: readonly { readonly kind: AgentCashOut; readonly amountMinor: number }[];
  };
  readonly feesDue: {
    /** 2300, as positive amounts: fees charged and not yet taken. */
    readonly openingMinor: number;
    readonly closingMinor: number;
    /** Fees the provider paid the agent from a settlement split at source (P22). */
    readonly settledAtSourceMinor?: number;
  };
  /** Held back from the net remittable for other bills the agent will pay; zero by default. */
  readonly reserveMinor?: number;
  /**
   * Who pays the owner's rent tax to GRA, from the management agreement (founder decision,
   * 2026-11-05). When the agency does, the net remittable holds back the rent tax payable at the
   * month's end, so the statement needs `rentTaxPayable`. Omitted, nothing is held back.
   */
  readonly graPaidBy?: GraPayer;
  /**
   * Withholding tax receivable at the month's end (1150, as a positive amount): tax a tenant
   * withheld, waiting for its certificate (P19, P20). It is in the rent tax payable (2200) too, but
   * the agency never pays it to GRA, so it is not held back (M9 review #9; architecture worked
   * example B): the hold-back is max(0, rent tax payable − withholding pending).
   */
  readonly withholdingPendingMinor?: number;
}

export interface OwnerStatementInput {
  readonly ownerId: string;
  /** `YYYY-MM`, a calendar month in the company's time zone (decision 5). */
  readonly month: string;
  readonly properties: readonly StatementPropertyInput[];
  /** Payment processing fees the owner bore (5200: OQ-07), at the owner's level. */
  readonly processingFeesMinor?: number;
  /**
   * The owner's rent tax payable (2200, as positive amounts) at the end of the month before and at
   * this month's end, and what withholding certificates settled in the month (P20). When given,
   * it is checked against the month's rent tax accrued and paid.
   */
  readonly rentTaxPayable?: {
    readonly openingMinor: number;
    readonly closingMinor: number;
    readonly certifiedMinor?: number;
  };
  /** Null for an owner whose rent the agent does not hold (a self-managing landlord). */
  readonly agent: StatementAgentInput | null;
}

// Output.

export interface StatementCashSection {
  readonly collectionsByMethod: Readonly<Record<CollectionMethod, number>>;
  readonly collectionsMinor: number;
  readonly expensesByCategory: readonly {
    readonly category: string;
    readonly amountMinor: number;
  }[];
  readonly expensesMinor: number;
  readonly feesMinor: number;
  readonly rentTaxAccruedMinor: number;
  readonly rentTaxPaidMinor: number;
}

export interface StatementAccrualSection {
  readonly rentEarnedMinor: number;
  readonly serviceChargeEarnedMinor: number;
  readonly earnedMinor: number;
  readonly unearnedRentMinor: number;
  readonly unearnedServiceChargeMinor: number;
  /** Money held for tenants and applied to no month: the rest of 2010. */
  readonly creditMinor: number;
  /** All of 2010: unearned rent + unearned service charge + credit. */
  readonly unearnedMinor: number;
  readonly depositsHeldMinor: number;
  readonly arrearsByBucket: Readonly<Record<AgeBucket, number>>;
  readonly arrearsMinor: number;
}

/** A page: one property, or the summary (propertyId null). */
export interface StatementPage {
  readonly propertyId: string | null;
  readonly cash: StatementCashSection;
  readonly accrual: StatementAccrualSection;
  readonly occupancy: OccupancySummary;
}

export interface StatementAgentSection {
  readonly openingMinor: number;
  readonly in: Readonly<Record<AgentCashIn, number>>;
  readonly out: Readonly<Record<AgentCashOut, number>>;
  readonly inMinor: number;
  readonly outMinor: number;
  readonly closingMinor: number;
  readonly feesDueOpeningMinor: number;
  readonly feesChargedMinor: number;
  readonly feesTakenMinor: number;
  readonly feesSettledAtSourceMinor: number;
  readonly feesDueClosingMinor: number;
  readonly reserveMinor: number;
  /** Null when the statement was not told who pays GRA. */
  readonly graPaidBy: GraPayer | null;
  /**
   * When the agency pays GRA, the owner's rent tax payable at the month's end less the withholding
   * pending its certificate (1150), never below zero; otherwise zero (M9 review #9).
   */
  readonly rentTaxHeldBackMinor: number;
  /**
   * What the agent could remit at the month's end: cash held, less the rent tax held back, any
   * reserve and the fees due.
   */
  readonly netRemittableMinor: number;
  /** The net of remittances paid to the owner in the month. */
  readonly remittancesMadeMinor: number;
}

export const STATEMENT_CHECKS = [
  'agent_cash',
  'fees_due',
  'rent_tax_receipts',
  'rent_tax_payable',
] as const;
export type StatementCheckName = (typeof STATEMENT_CHECKS)[number];

/** An identity the figures must satisfy: `expected` is what the other figures imply. */
export interface StatementCheck {
  readonly name: StatementCheckName;
  /** `owner`, or the property it was checked on. */
  readonly scope: string;
  readonly expectedMinor: number;
  readonly actualMinor: number;
  readonly passed: boolean;
}

/** The owner's rent tax payable (2200) rolled forward through the month. */
export interface StatementRentTaxPayable {
  readonly openingMinor: number;
  readonly accruedMinor: number;
  readonly paidMinor: number;
  readonly certifiedMinor: number;
  readonly closingMinor: number;
}

export interface OwnerStatementFigures {
  readonly ownerId: string;
  readonly month: string;
  readonly firstDay: string;
  readonly lastDay: string;
  /** One page per property, in property-id order. */
  readonly properties: readonly StatementPage[];
  readonly summary: StatementPage;
  readonly processingFeesMinor: number;
  readonly rentTaxPayable: StatementRentTaxPayable | null;
  readonly agent: StatementAgentSection | null;
  readonly checks: readonly StatementCheck[];
}

// Building.

const whole = (amount: number, what: string): number => {
  if (!Number.isSafeInteger(amount))
    throw new DomainError('statement.bad_amount', `${what} must be a whole number of pesewas`);
  return amount;
};

const atLeastZero = (amount: number, what: string): number => {
  if (whole(amount, what) < 0)
    throw new DomainError('statement.bad_amount', `${what} cannot be below zero`);
  return amount;
};

const total = (values: readonly number[]): number => values.reduce((sum, v) => sum + v, 0);

/** Totals keyed by a fixed list, every key present, in the list's order. */
function keyedTotals<K extends string>(
  keys: readonly K[],
  rows: readonly { readonly key: K; readonly amountMinor: number }[],
  what: string,
  check: (amount: number, what: string) => number,
): Record<K, number> {
  const totals = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const row of rows) {
    if (!keys.includes(row.key))
      throw new DomainError('statement.bad_key', `${what} has no line ${String(row.key)}`);
    totals[row.key] += check(row.amountMinor, what);
  }
  return totals;
}

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function expensesByCategory(
  rows: readonly { readonly category: string; readonly amountMinor: number }[],
): { category: string; amountMinor: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.category.trim() === '')
      throw new DomainError('statement.bad_category', 'An expense needs a category');
    totals.set(
      row.category,
      (totals.get(row.category) ?? 0) + whole(row.amountMinor, 'An expense'),
    );
  }
  return [...totals]
    .sort(([a], [b]) => byCode(a, b))
    .map(([category, amountMinor]) => ({ category, amountMinor }));
}

function propertyPage(input: StatementPropertyInput): StatementPage {
  for (const c of input.collections) whole(c.amountMinor, 'A collection');
  const collectionsByMethod = byCollectionMethod(input.collections);
  const expenses = expensesByCategory(input.expenses);
  const arrearsByBucket = keyedTotals(
    AGE_BUCKETS,
    input.arrears.map((a) => ({ key: a.bucket, amountMinor: a.amountMinor })),
    'Arrears',
    atLeastZero,
  );
  const rentEarnedMinor = whole(input.rentEarnedMinor, 'Rent earned');
  const serviceChargeEarnedMinor = whole(input.serviceChargeEarnedMinor, 'Service charge earned');
  const unearnedRentMinor = atLeastZero(input.unearnedRentMinor, 'Unearned rent');
  const unearnedServiceChargeMinor = atLeastZero(
    input.unearnedServiceChargeMinor ?? 0,
    'Unearned service charge',
  );
  const creditMinor = atLeastZero(input.creditMinor ?? 0, 'Credit held for tenants');
  return {
    propertyId: input.propertyId,
    cash: {
      collectionsByMethod,
      collectionsMinor: total(COLLECTION_METHODS.map((m) => collectionsByMethod[m])),
      expensesByCategory: expenses,
      expensesMinor: total(expenses.map((e) => e.amountMinor)),
      feesMinor: whole(input.feesMinor, 'Fees'),
      rentTaxAccruedMinor: whole(input.rentTax.accruedMinor, 'Rent tax accrued'),
      rentTaxPaidMinor: whole(input.rentTax.paidMinor, 'Rent tax paid'),
    },
    accrual: {
      rentEarnedMinor,
      serviceChargeEarnedMinor,
      earnedMinor: rentEarnedMinor + serviceChargeEarnedMinor,
      unearnedRentMinor,
      unearnedServiceChargeMinor,
      creditMinor,
      unearnedMinor: unearnedRentMinor + unearnedServiceChargeMinor + creditMinor,
      depositsHeldMinor: atLeastZero(input.depositsHeldMinor, 'Deposits held'),
      arrearsByBucket,
      arrearsMinor: total(AGE_BUCKETS.map((b) => arrearsByBucket[b])),
    },
    occupancy: occupancyOf(input.occupancy),
  };
}

/** The summary page: every property page added up. */
function summaryPage(
  pages: readonly StatementPage[],
  occupancy: readonly OccupancyCounts[],
): StatementPage {
  const sum = (f: (p: StatementPage) => number) => total(pages.map(f));
  const collectionsByMethod = Object.fromEntries(
    COLLECTION_METHODS.map((m) => [m, sum((p) => p.cash.collectionsByMethod[m])]),
  ) as Record<CollectionMethod, number>;
  const expenses = expensesByCategory(pages.flatMap((p) => p.cash.expensesByCategory));
  const arrearsByBucket = Object.fromEntries(
    AGE_BUCKETS.map((b) => [b, sum((p) => p.accrual.arrearsByBucket[b])]),
  ) as Record<AgeBucket, number>;
  return {
    propertyId: null,
    cash: {
      collectionsByMethod,
      collectionsMinor: sum((p) => p.cash.collectionsMinor),
      expensesByCategory: expenses,
      expensesMinor: sum((p) => p.cash.expensesMinor),
      feesMinor: sum((p) => p.cash.feesMinor),
      rentTaxAccruedMinor: sum((p) => p.cash.rentTaxAccruedMinor),
      rentTaxPaidMinor: sum((p) => p.cash.rentTaxPaidMinor),
    },
    accrual: {
      rentEarnedMinor: sum((p) => p.accrual.rentEarnedMinor),
      serviceChargeEarnedMinor: sum((p) => p.accrual.serviceChargeEarnedMinor),
      earnedMinor: sum((p) => p.accrual.earnedMinor),
      unearnedRentMinor: sum((p) => p.accrual.unearnedRentMinor),
      unearnedServiceChargeMinor: sum((p) => p.accrual.unearnedServiceChargeMinor),
      creditMinor: sum((p) => p.accrual.creditMinor),
      unearnedMinor: sum((p) => p.accrual.unearnedMinor),
      depositsHeldMinor: sum((p) => p.accrual.depositsHeldMinor),
      arrearsByBucket,
      arrearsMinor: sum((p) => p.accrual.arrearsMinor),
    },
    occupancy: occupancyOf(addOccupancy(occupancy)),
  };
}

function agentSection(
  agent: StatementAgentInput,
  feesChargedMinor: number,
  rentTaxPayable: StatementRentTaxPayable | null,
): StatementAgentSection {
  const graPaidBy = agent.graPaidBy ?? null;
  if (graPaidBy !== null && !GRA_PAYERS.includes(graPaidBy))
    throw new DomainError('statement.bad_gra_payer', 'The agency or the owner pays GRA');
  if (graPaidBy === 'agency' && rentTaxPayable === null)
    throw new DomainError(
      'statement.rent_tax_payable_missing',
      'When the agency pays GRA, the statement needs the rent tax payable',
    );
  // M9 review #9: tax a tenant withheld (1150, pending its certificate) is in 2200 but is never
  // paid to GRA by the agency, so only the rest of the payable is held back.
  const withholdingPendingMinor = whole(
    agent.withholdingPendingMinor ?? 0,
    'Withholding pending its certificate',
  );
  const rentTax =
    graPaidBy === null
      ? null
      : {
          graPaidBy,
          payableMinor: Math.max(0, (rentTaxPayable?.closingMinor ?? 0) - withholdingPendingMinor),
        };
  const cashIn = keyedTotals(
    AGENT_CASH_IN,
    agent.cash.in.map((m) => ({ key: m.kind, amountMinor: m.amountMinor })),
    'Agent cash in',
    atLeastZero,
  );
  const cashOut = keyedTotals(
    AGENT_CASH_OUT,
    agent.cash.out.map((m) => ({ key: m.kind, amountMinor: m.amountMinor })),
    'Agent cash out',
    atLeastZero,
  );
  const closingMinor = whole(agent.cash.closingMinor, 'Agent cash at the end');
  const feesDueClosingMinor = whole(agent.feesDue.closingMinor, 'Fees due at the end');
  const reserveMinor = atLeastZero(agent.reserveMinor ?? 0, 'The reserve');
  return {
    openingMinor: whole(agent.cash.openingMinor, 'Agent cash at the start'),
    in: cashIn,
    out: cashOut,
    inMinor: total(AGENT_CASH_IN.map((k) => cashIn[k])),
    outMinor: total(AGENT_CASH_OUT.map((k) => cashOut[k])),
    closingMinor,
    feesDueOpeningMinor: whole(agent.feesDue.openingMinor, 'Fees due at the start'),
    feesChargedMinor,
    feesTakenMinor: cashOut.fees_taken,
    feesSettledAtSourceMinor: atLeastZero(
      agent.feesDue.settledAtSourceMinor ?? 0,
      'Fees settled at source',
    ),
    feesDueClosingMinor,
    reserveMinor,
    graPaidBy,
    rentTaxHeldBackMinor: rentTaxHoldBackMinor(rentTax),
    netRemittableMinor: suggestRemittance({
      agentHeldMinor: closingMinor,
      feesDueMinor: feesDueClosingMinor,
      reserveMinor,
      rentTax,
    }).netMinor,
    remittancesMadeMinor: cashOut.remittances,
  };
}

const check = (
  name: StatementCheckName,
  scope: string,
  expectedMinor: number,
  actualMinor: number,
): StatementCheck => ({
  name,
  scope,
  expectedMinor,
  actualMinor,
  passed: expectedMinor === actualMinor,
});

/**
 * The identities a statement must satisfy:
 * - `agent_cash`: opening agent-held cash, plus money in, less money out, is the closing balance;
 * - `fees_due`: fees due at the start, plus fees charged in the month, less fees taken and fees
 *   settled at source, are the fees due at the end;
 * - `rent_tax_receipts` (AC-04 ★, invariant 6): rent tax accrued is the sum of each receipt's tax,
 *   on every property whose receipt items are given, and for the owner;
 * - `rent_tax_payable`: rent tax payable at the start, plus tax accrued, less tax paid to GRA and
 *   settled by certificates, is the rent tax payable at the end, which is what the agent holds
 *   back when it pays GRA.
 */
function statementChecks(
  inputs: readonly StatementPropertyInput[],
  pages: readonly StatementPage[],
  agent: StatementAgentSection | null,
  rentTaxPayable: StatementRentTaxPayable | null,
): StatementCheck[] {
  const checks: StatementCheck[] = [];
  if (agent) {
    checks.push(
      check(
        'agent_cash',
        'owner',
        agent.openingMinor + agent.inMinor - agent.outMinor,
        agent.closingMinor,
      ),
      check(
        'fees_due',
        'owner',
        agent.feesDueOpeningMinor +
          agent.feesChargedMinor -
          agent.feesTakenMinor -
          agent.feesSettledAtSourceMinor,
        agent.feesDueClosingMinor,
      ),
    );
  }
  const itemised = inputs.filter((i) => i.rentTax.receiptItemsMinor !== undefined);
  const items = (i: StatementPropertyInput) =>
    total((i.rentTax.receiptItemsMinor ?? []).map((t) => whole(t, 'A receipt tax item')));
  for (const input of itemised) {
    const page = pages.find((p) => p.propertyId === input.propertyId) as StatementPage;
    checks.push(
      check('rent_tax_receipts', input.propertyId, items(input), page.cash.rentTaxAccruedMinor),
    );
  }
  if (itemised.length > 0 && itemised.length === inputs.length)
    checks.push(
      check(
        'rent_tax_receipts',
        'owner',
        total(itemised.map(items)),
        total(pages.map((p) => p.cash.rentTaxAccruedMinor)),
      ),
    );
  if (rentTaxPayable)
    checks.push(
      check(
        'rent_tax_payable',
        'owner',
        rentTaxPayable.openingMinor +
          rentTaxPayable.accruedMinor -
          rentTaxPayable.paidMinor -
          rentTaxPayable.certifiedMinor,
        rentTaxPayable.closingMinor,
      ),
    );
  return checks;
}

/** Arranges and checks one owner's statement figures for one month. */
export function ownerStatementFigures(input: OwnerStatementInput): OwnerStatementFigures {
  const month = reportMonth(input.month);
  const seen = new Set<string>();
  for (const p of input.properties) {
    if (p.propertyId.trim() === '')
      throw new DomainError('statement.bad_property', 'Each page names its property');
    if (seen.has(p.propertyId))
      throw new DomainError(
        'statement.duplicate_property',
        `Property ${p.propertyId} is listed twice`,
      );
    seen.add(p.propertyId);
  }
  const inputs = [...input.properties].sort((a, b) => byCode(a.propertyId, b.propertyId));
  const pages = inputs.map(propertyPage);
  const summary = summaryPage(
    pages,
    inputs.map((i) => i.occupancy),
  );
  const rentTaxPayable: StatementRentTaxPayable | null = input.rentTaxPayable
    ? {
        openingMinor: whole(input.rentTaxPayable.openingMinor, 'Rent tax payable at the start'),
        accruedMinor: summary.cash.rentTaxAccruedMinor,
        paidMinor: summary.cash.rentTaxPaidMinor,
        certifiedMinor: atLeastZero(
          input.rentTaxPayable.certifiedMinor ?? 0,
          'Rent tax settled by certificates',
        ),
        closingMinor: whole(input.rentTaxPayable.closingMinor, 'Rent tax payable at the end'),
      }
    : null;
  const agent = input.agent
    ? agentSection(input.agent, summary.cash.feesMinor, rentTaxPayable)
    : null;
  return {
    ownerId: input.ownerId,
    month: month.month,
    firstDay: month.firstDay,
    lastDay: month.lastDay,
    properties: pages,
    summary,
    processingFeesMinor: whole(input.processingFeesMinor ?? 0, 'Processing fees'),
    rentTaxPayable,
    agent,
    checks: statementChecks(inputs, pages, agent, rentTaxPayable),
  };
}

/** The checks that failed; a statement is issued only when there are none. */
export const failedStatementChecks = (figures: OwnerStatementFigures): StatementCheck[] =>
  figures.checks.filter((c) => !c.passed);

/** Refuses figures that break an identity, naming each break. */
export function assertStatementChecks(figures: OwnerStatementFigures): void {
  const failed = failedStatementChecks(figures);
  if (failed.length > 0)
    throw new DomainError(
      'statement.identity_failed',
      `The statement does not add up: ${failed
        .map((c) => `${c.name} (${c.scope}): expected ${c.expectedMinor}, found ${c.actualMinor}`)
        .join('; ')}`,
    );
}

// Regeneration (decision 7, invariant 10).

/** One figure as `owner_statement_figure` stores it: a stable key and an integer. */
export interface StatementFigureRow {
  readonly key: string;
  readonly value: number;
}

function pageRows(prefix: string, page: StatementPage): StatementFigureRow[] {
  const rows: StatementFigureRow[] = [];
  const add = (key: string, value: number) => rows.push({ key: `${prefix}.${key}`, value });
  for (const m of COLLECTION_METHODS)
    add(`cash.collections.${m}`, page.cash.collectionsByMethod[m]);
  add('cash.collections', page.cash.collectionsMinor);
  for (const e of page.cash.expensesByCategory) add(`cash.expenses.${e.category}`, e.amountMinor);
  add('cash.expenses', page.cash.expensesMinor);
  add('cash.fees', page.cash.feesMinor);
  add('cash.rent_tax_accrued', page.cash.rentTaxAccruedMinor);
  add('cash.rent_tax_paid', page.cash.rentTaxPaidMinor);
  add('accrual.rent_earned', page.accrual.rentEarnedMinor);
  add('accrual.service_charge_earned', page.accrual.serviceChargeEarnedMinor);
  add('accrual.earned', page.accrual.earnedMinor);
  add('accrual.unearned_rent', page.accrual.unearnedRentMinor);
  add('accrual.unearned_service_charge', page.accrual.unearnedServiceChargeMinor);
  add('accrual.credit', page.accrual.creditMinor);
  add('accrual.unearned', page.accrual.unearnedMinor);
  add('accrual.deposits_held', page.accrual.depositsHeldMinor);
  for (const b of AGE_BUCKETS) add(`accrual.arrears.${b}`, page.accrual.arrearsByBucket[b]);
  add('accrual.arrears', page.accrual.arrearsMinor);
  const o = page.occupancy;
  add('occupancy.units', o.units);
  add('occupancy.lettable', o.lettable);
  add('occupancy.occupied', o.occupied);
  add('occupancy.vacant', o.vacant);
  add('occupancy.available', o.available);
  add('occupancy.reserved', o.reserved);
  add('occupancy.under_repair', o.underRepair);
  add('occupancy.not_lettable', o.notLettable);
  return rows;
}

/**
 * Every figure of the statement as key and value, in a fixed order: what issuing stores and what
 * a regeneration is compared against. Shares are left out: they follow from the counts.
 */
export function flattenStatementFigures(figures: OwnerStatementFigures): StatementFigureRow[] {
  const rows: StatementFigureRow[] = [];
  for (const page of figures.properties)
    rows.push(...pageRows(`property.${page.propertyId as string}`, page));
  rows.push(...pageRows('summary', figures.summary));
  rows.push({ key: 'owner.processing_fees', value: figures.processingFeesMinor });
  const tax = figures.rentTaxPayable;
  if (tax)
    for (const [key, value] of [
      ['opening', tax.openingMinor],
      ['accrued', tax.accruedMinor],
      ['paid', tax.paidMinor],
      ['certified', tax.certifiedMinor],
      ['closing', tax.closingMinor],
    ] as const)
      rows.push({ key: `owner.rent_tax_payable.${key}`, value });
  const a = figures.agent;
  if (a) {
    const add = (key: string, value: number) => rows.push({ key: `agent.${key}`, value });
    add('cash.opening', a.openingMinor);
    for (const k of AGENT_CASH_IN) add(`cash.in.${k}`, a.in[k]);
    for (const k of AGENT_CASH_OUT) add(`cash.out.${k}`, a.out[k]);
    add('cash.in', a.inMinor);
    add('cash.out', a.outMinor);
    add('cash.closing', a.closingMinor);
    add('fees_due.opening', a.feesDueOpeningMinor);
    add('fees_due.charged', a.feesChargedMinor);
    add('fees_due.taken', a.feesTakenMinor);
    add('fees_due.settled_at_source', a.feesSettledAtSourceMinor);
    add('fees_due.closing', a.feesDueClosingMinor);
    add('rent_tax_held_back', a.rentTaxHeldBackMinor);
    add('reserve', a.reserveMinor);
    add('net_remittable', a.netRemittableMinor);
    add('remittances_made', a.remittancesMadeMinor);
  }
  return rows;
}

export interface StatementFigureDifference {
  readonly key: string;
  readonly issued: number | null;
  readonly regenerated: number | null;
}

/**
 * Compares a regeneration with the figures as issued (decision 7: a reissue must match). Empty
 * when every figure is identical; otherwise each key that differs, appears or disappears, in key
 * order.
 */
export function diffStatementFigures(
  issued: readonly StatementFigureRow[],
  regenerated: readonly StatementFigureRow[],
): StatementFigureDifference[] {
  const index = (rows: readonly StatementFigureRow[], what: string) => {
    const map = new Map<string, number>();
    for (const row of rows) {
      if (map.has(row.key))
        throw new DomainError('statement.duplicate_figure', `${what} has ${row.key} twice`);
      map.set(row.key, row.value);
    }
    return map;
  };
  const before = index(issued, 'The issued statement');
  const after = index(regenerated, 'The regeneration');
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort(byCode);
  return keys.flatMap((key) => {
    const a = before.get(key) ?? null;
    const b = after.get(key) ?? null;
    return a === b ? [] : [{ key, issued: a, regenerated: b }];
  });
}
