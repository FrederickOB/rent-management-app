import { schema, sql, type Tx } from '@rent/db';
import { expectedTaxMinor, lineBalance, paymentCredit, postingClassOf } from '@rent/domain/billing';
import { parseBusinessDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import { money, multiplyBps } from '@rent/domain/money';
import {
  accrueOpeningState,
  advanceFromPaidThrough,
  checkBalanceRows,
  ONBOARDING_SHEETS,
  openingLeaseFigures,
  planOpeningAdjustment,
  planOpeningLease,
  planOwnerOpening,
  type BalanceWorkbookMode,
  type OnboardingSheetKey,
  type OnboardingSheetRows,
  type OpeningItems,
  type OpeningLeaseFigures,
  type OpeningLeasePlan,
  type OpeningLeaseState,
  type OpeningLowering,
  type OwnerOpeningChange,
  type OwnerOpeningPlan,
} from '@rent/domain/onboarding';
import type { ImportIssue } from '@rent/domain/portfolio';
import { v7 as uuidv7 } from 'uuid';
import {
  lastBillableDay,
  paidUntilFloor,
  type BillingEngine,
  type LeaseState,
} from '../billing/engine';
import { dimsOf, lockCounters, lockLeases, openingPaymentOrder } from '../billing/records';
import { balance, ownerBook } from '../ledger/ledger.queries';
import { lockOwnersTax, taxItems } from '../tax/tax-records';
import type { RulesService } from '../rules/rules.service';
import {
  emptyTotals,
  openingItems,
  type OwnerSummary,
  type BalanceTotals,
  type ItemRecord,
  type SheetCounts,
} from './records';

/**
 * Step 3 of onboarding, opening balances (P25; M11 decision 3; plan 4.2), and their adjustment
 * workbook: the domain's row rules, then the facts only the database has (each lease and owner
 * exists and is billed, the periods are the lease's and not billed on the platform, what an item
 * has had paid or drawn), then the domain's plan for every lease and owner, which the preview
 * shows and the posting writes. Re-importing the same Balances workbook finds every row and
 * changes nothing; a different amount for an item already brought in is the adjustment
 * workbook's. Withholding already brought in is never lowered here (see `lowerWithholding`).
 */

export interface BalanceDeps {
  readonly engine: BillingEngine;
  readonly rules: RulesService;
}

/** What one onboarding item records, besides its entry (`onboarding_item`). */
export interface ItemMeta {
  readonly kind: ItemRecord['kind'];
  /** Signed: an adjustment that lowers is negative. */
  readonly amountMinor: number;
  readonly dueOn: string | null;
  readonly periodStart: string | null;
  readonly invoiceLineId: string | null;
  readonly paymentId: string | null;
}

/** Withholding brought in: the M5 record that awaits its certificate (TX-04). */
export interface WithholdingIn {
  readonly itemId: string;
  readonly amountMinor: number;
  readonly withheldOn: string;
  readonly periodStart: string;
  readonly rateBps: number;
  readonly rateRuleId: string;
  readonly differsFromRate: boolean;
}

export interface LeaseWork {
  readonly leaseId: string;
  readonly unitCode: string;
  readonly tenantName: string;
  readonly ownerId: string;
  readonly bookId: string;
  readonly state: LeaseState;
  readonly items: OpeningItems;
  readonly lower: OpeningLowering;
  readonly meta: Map<string, ItemMeta>;
  readonly withholding: WithholdingIn[];
  /** The lease's figures today, before the plan (an adjustment's `before`). */
  readonly before: OpeningLeaseFigures;
  readonly after: OpeningLeaseFigures;
  readonly plan: OpeningLeasePlan;
}

export interface OwnerWork {
  readonly ownerId: string;
  readonly bookId: string;
  readonly changes: OwnerOpeningChange[];
  readonly meta: Map<string, ItemMeta>;
  readonly plan: OwnerOpeningPlan;
  /**
   * The M5 rent tax items the plan writes (TX-02): one of kind `opening` for rent tax brought in,
   * with its due date (the alerts read it, a GRA payment settles it), or for a lowering one
   * owner-level reversal per opening item it lowers, latest first. With the rules rows for the
   * due and alert days as of the cut-over.
   */
  readonly rentTax: {
    readonly raise: { readonly amountMinor: number; readonly dueOn: string } | null;
    readonly lower: readonly { readonly itemId: string; readonly amountMinor: number }[];
    readonly dueRuleId: string | null;
    readonly alertRuleId: string | null;
  } | null;
  /** Agent-held cash and rent tax outstanding after the plan, with the earliest due date. */
  readonly agentCashMinor: number;
  readonly rentTaxOutstandingMinor: number;
  readonly rentTaxDueOn: string | null;
}

export interface BalanceCheck {
  readonly issues: ImportIssue[];
  readonly counts: Record<string, SheetCounts>;
  readonly totals: BalanceTotals;
  readonly leases: LeaseWork[];
  readonly owners: OwnerWork[];
  /** M11 review C2: the leases it touches and each owner's share, for the approval card. */
  readonly summary: { readonly leases: number; readonly owners: OwnerSummary[] };
}

/** Each owner's share of the plans: the items' signed amounts, by kind (review C2). */
function summaryOf(leases: readonly LeaseWork[], owners: readonly OwnerWork[]) {
  const by = new Map<string, { -readonly [K in keyof OwnerSummary]: OwnerSummary[K] }>();
  const of = (ownerId: string) => {
    const was = by.get(ownerId) ?? { ownerId, ...emptyTotals() };
    by.set(ownerId, was);
    return was;
  };
  const field: Record<ItemMeta['kind'], keyof BalanceTotals> = {
    arrears: 'arrearsMinor',
    advance: 'advancesMinor',
    deposit: 'depositsMinor',
    withholding: 'withholdingMinor',
    agent_cash: 'agentCashMinor',
    rent_tax: 'rentTaxOutstandingMinor',
  };
  for (const l of leases) {
    const o = of(l.ownerId);
    for (const m of l.meta.values()) o[field[m.kind]] += m.amountMinor;
  }
  for (const w of owners) {
    const o = of(w.ownerId);
    for (const m of w.meta.values()) o[field[m.kind]] += m.amountMinor;
  }
  return {
    leases: leases.length,
    owners: [...by.values()].sort((a, b) => (a.ownerId < b.ownerId ? -1 : 1)),
  };
}

const S = ONBOARDING_SHEETS;
/** Lease states opening balances may be brought in for: signed and not yet ended. */
const OPEN_LEASE = ['signed', 'active', 'ending', 'holding_over'];

/** A rules row in force on a date, or null when there is none (its id is recorded). */
async function ruleOrNull(
  rules: RulesService,
  tx: Tx,
  country: string,
  key: string,
  date: string,
): Promise<string | null> {
  try {
    return (await rules.resolveIn(tx, country, key, parseBusinessDate(date))).ruleId;
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}

/** The lease as the domain's plan sees it. */
export function openingState(state: LeaseState): OpeningLeaseState {
  return {
    lines: state.lines,
    allocations: state.allocations,
    payments: state.payments,
    openingPaymentIds: new Set(state.payments.filter((p) => p.opening).map((p) => p.id)),
  };
}

/**
 * A lease's figures (decision 3), as its page shows them: from its records brought to `today`,
 * the forward walk over its periods still to be invoiced, the deposit held (2100) and the
 * withholding whose certificate is still to come (1150).
 */
export function figuresOf(
  engine: BillingEngine,
  state: LeaseState,
  opening: OpeningLeaseState,
  today: string,
  extra: { readonly depositAdjustmentMinor: number; readonly withholdingMinor: number },
): OpeningLeaseFigures {
  const lastDay = lastBillableDay(state.lease);
  return openingLeaseFigures({
    state: accrueOpeningState(opening, today, lastDay),
    // Opening lines are for periods before the billing start, so they never change this list.
    scheduled: engine.scheduled(state),
    asOf: today,
    lastDay,
    floor: paidUntilFloor(state.lease),
    depositAdjustmentMinor: extra.depositAdjustmentMinor,
    withholdingOutstandingMinor: extra.withholdingMinor,
  });
}

/** 2100 beyond the deposit lines' allocations: carried in or out (P29), used at a move-out. */
async function depositAdjustment(tx: Tx, engine: BillingEngine, state: LeaseState) {
  const held = await engine.depositHeld(tx, state.lease.id);
  let onLines = 0;
  for (const line of state.lines)
    if (postingClassOf(line) === 'deposit')
      onLines += lineBalance(line, state.allocations).settledMinor;
  return { held, adjustment: held - onLines };
}

interface Existing {
  readonly arrears: Map<string, { amountMinor: number; dueOn: string | null }>;
  readonly advance: Map<string, number>;
  readonly deposit: Map<string, number>;
  readonly withholding: Map<string, number>;
  readonly agentCash: Map<string, number>;
  readonly rentTax: Map<string, { amountMinor: number; dueOn: string | null }>;
}

/** What earlier batches brought in, net of adjustments, by each row's natural key. */
function existingOf(items: readonly ItemRecord[]): Existing {
  const out: Existing = {
    arrears: new Map(),
    advance: new Map(),
    deposit: new Map(),
    withholding: new Map(),
    agentCash: new Map(),
    rentTax: new Map(),
  };
  const add = (map: Map<string, number>, key: string, amount: number) =>
    map.set(key, (map.get(key) ?? 0) + amount);
  for (const i of items) {
    if (i.kind === 'arrears') {
      const key = `${i.leaseId}|${i.periodStart}|${i.lineKind}`;
      const was = out.arrears.get(key) ?? { amountMinor: 0, dueOn: null };
      out.arrears.set(key, {
        amountMinor: was.amountMinor + i.amountMinor,
        dueOn:
          i.amountMinor > 0 && (was.dueOn === null || (i.dueOn ?? '') < was.dueOn)
            ? i.dueOn
            : was.dueOn,
      });
    } else if (i.kind === 'advance') add(out.advance, i.leaseId!, i.amountMinor);
    else if (i.kind === 'deposit') add(out.deposit, i.leaseId!, i.amountMinor);
    else if (i.kind === 'withholding')
      add(out.withholding, `${i.leaseId}|${i.periodStart}`, i.amountMinor);
    else if (i.kind === 'agent_cash') add(out.agentCash, i.ownerId!, i.amountMinor);
    else {
      const was = out.rentTax.get(i.ownerId!) ?? { amountMinor: 0, dueOn: null };
      out.rentTax.set(i.ownerId!, {
        amountMinor: was.amountMinor + i.amountMinor,
        dueOn:
          i.amountMinor > 0 && (was.dueOn === null || (i.dueOn ?? '') < was.dueOn)
            ? i.dueOn
            : was.dueOn,
      });
    }
  }
  return out;
}

/**
 * Checks a Balances or adjustment workbook and plans every lease and owner (writes nothing, unless
 * `write`: then, under the leases' billing locks and the counters, each lease is accrued for real
 * before it is planned, as on every money path, and the caller posts the plans).
 */
export async function checkBalances(
  tx: Tx,
  deps: BalanceDeps,
  input: {
    readonly companyId: string;
    readonly companyKind: string;
    readonly countryCode: string;
    readonly batchId: string;
    readonly mode: BalanceWorkbookMode;
    readonly sheets: Partial<Record<OnboardingSheetKey, OnboardingSheetRows>>;
    readonly cutOver: string;
    readonly today: string;
    readonly write?: boolean;
  },
): Promise<BalanceCheck> {
  const { mode, cutOver, today } = input;
  const adjusting = mode === 'adjustment';
  const rows = checkBalanceRows(
    {
      arrears: input.sheets.arrears,
      advances: input.sheets.advances,
      deposits: input.sheets.deposits,
      withholding: input.sheets.withholding,
      ownerItems: input.sheets.ownerItems,
    },
    { cutOverDate: cutOver, mode },
  );
  const issues: ImportIssue[] = [...rows.issues];
  const issue = (sheet: string, row: number, column: string | null, message: string) =>
    issues.push({ sheet, row, column, message });
  const counts: Record<string, SheetCounts> = {};
  const count = (sheet: string, what: keyof SheetCounts) => {
    const c = counts[sheet] ?? { create: 0, update: 0, unchanged: 0 };
    counts[sheet] = { ...c, [what]: c[what] + 1 };
  };
  for (const sheet of [S.arrears, S.advances, S.deposits, S.withholding, S.ownerItems])
    counts[sheet] = { create: 0, update: 0, unchanged: 0 };
  const totals = { ...emptyTotals() } as { -readonly [K in keyof BalanceTotals]: number };
  const existing = existingOf(await openingItems(tx));

  // The leases the rows name, by unit and start date.
  const named = new Map<string, { sheet: string; row: number }>();
  for (const [sheet, list] of [
    [S.arrears, rows.arrears],
    [S.advances, rows.advances],
    [S.deposits, rows.deposits],
    [S.withholding, rows.withholding],
  ] as const)
    for (const r of list) if (!named.has(r.leaseKey)) named.set(r.leaseKey, { sheet, row: r.row });
  const found = new Map<string, string>();
  if (named.size > 0) {
    const leaseRows = await tx.execute<{
      id: string;
      code: string;
      start_date: string;
      status: string;
    }>(
      sql`select l.id, u.code, l.start_date::text as start_date, l.status from lease l
          join unit u on u.company_id = l.company_id and u.id = l.unit_id
          where l.status = any(${`{${OPEN_LEASE.join(',')}}`}::text[])`,
    );
    for (const l of leaseRows.rows) found.set(`lease:${l.code}|${l.start_date}`, l.id);
  }
  const leaseIds = [
    ...new Set([...named.keys()].map((k) => found.get(k)).filter((x): x is string => !!x)),
  ];
  if (input.write) {
    await lockLeases(tx, input.companyId, leaseIds);
    await lockCounters(tx, input.companyId);
  }
  const states = new Map<string, LeaseState>();
  for (const id of leaseIds) {
    const state = await deps.engine.load(tx, input.companyId, id);
    if (input.write && state.book.kind === 'book') {
      await deps.engine.carryOverIfStarted(tx, state, today);
      await deps.engine.accrue(tx, state, today);
    }
    states.set(id, state);
  }
  /** The lease a row names, checked to be billed; null with an issue on the row. */
  const leaseOf = (
    sheet: string,
    r: { row: number; leaseKey: string; unitCode: string; leaseStart: string },
  ) => {
    const id = found.get(r.leaseKey);
    if (!id) {
      issue(
        sheet,
        r.row,
        'Lease start',
        `No current lease of ${r.unitCode} starts on ${r.leaseStart}; import it on the Leases sheet first`,
      );
      return null;
    }
    const state = states.get(id)!;
    if (state.book.kind !== 'book' || !state.lease.billingStartDate) {
      issue(
        sheet,
        r.row,
        'Unit',
        'This lease is not billed (its property has more than one owner, or none)',
      );
      return null;
    }
    return state;
  };

  interface Draft {
    state: LeaseState;
    items: {
      arrears: NonNullable<OpeningItems['arrears']>[number][];
      advances: NonNullable<OpeningItems['advances']>[number][];
      deposits: NonNullable<OpeningItems['deposits']>[number][];
      withholding: NonNullable<OpeningItems['withholding']>[number][];
    };
    lower: {
      arrears: NonNullable<OpeningLowering['arrears']>[number][];
      advances: NonNullable<OpeningLowering['advances']>[number][];
      deposits: NonNullable<OpeningLowering['deposits']>[number][];
    };
    meta: Map<string, ItemMeta>;
    withholding: WithholdingIn[];
    rows: { sheet: string; row: number }[];
  }
  const drafts = new Map<string, Draft>();
  const draftOf = (state: LeaseState, sheet: string, row: number): Draft => {
    let d = drafts.get(state.lease.id);
    if (!d) {
      d = {
        state,
        items: { arrears: [], advances: [], deposits: [], withholding: [] },
        lower: { arrears: [], advances: [], deposits: [] },
        meta: new Map(),
        withholding: [],
        rows: [],
      };
      drafts.set(state.lease.id, d);
    }
    d.rows.push({ sheet, row });
    return d;
  };
  /** Opening state with what earlier rows of this file already planned, in memory. */
  const inMemory = (state: LeaseState): OpeningLeaseState =>
    accrueOpeningState(openingState(state), today, lastBillableDay(state.lease));

  // Arrears.
  for (const r of rows.arrears) {
    const state = leaseOf(S.arrears, r);
    if (!state) continue;
    const leaseId = state.lease.id;
    const key = `${leaseId}|${r.periodStart}|${r.kind}`;
    const had = existing.arrears.get(key);
    if (!adjusting) {
      if (had && had.amountMinor !== 0) {
        if (had.amountMinor === r.amountMinor && had.dueOn === r.dueDate)
          count(S.arrears, 'unchanged');
        else
          issue(
            S.arrears,
            r.row,
            'Amount',
            'These arrears were brought in already with another amount or due date; change them with the adjustment workbook',
          );
        continue;
      }
    }
    const period = state.schedule.find(
      (p) => p.chargeType === r.kind && p.periodStart === r.periodStart,
    );
    if (!period) {
      issue(
        S.arrears,
        r.row,
        'Period start',
        `This is not the start of one of the lease’s ${r.kind === 'rent' ? 'rent' : 'service-charge'} periods`,
      );
      continue;
    }
    if (!(r.periodStart < state.lease.billingStartDate!)) {
      issue(
        S.arrears,
        r.row,
        'Period start',
        `The platform bills this lease from ${state.lease.billingStartDate}; arrears are for earlier periods`,
      );
      continue;
    }
    if (
      state.lines.some(
        (l) => l.opening !== true && l.kind === r.kind && l.periodStart === r.periodStart,
      )
    ) {
      issue(S.arrears, r.row, 'Period start', 'The platform already bills this period');
      continue;
    }
    // Founder 2026-11-10 (M11 review S1): a raise on a month brought in already is a second
    // opening line on the same charge period (0081 exempts opening lines from one-per-period);
    // the lowering below works across the month's opening lines, latest first.
    if (r.amountMinor > 0) {
      const d = draftOf(state, S.arrears, r.row);
      const itemId = `arrears.${leaseId}.${r.periodStart}.${r.kind}`;
      const lineId = uuidv7();
      d.items.arrears.push({
        itemId,
        lineId,
        kind: r.kind,
        periodStart: r.periodStart,
        dueDate: r.dueDate!,
        amountMinor: r.amountMinor,
      });
      d.meta.set(itemId, {
        kind: 'arrears',
        amountMinor: r.amountMinor,
        dueOn: r.dueDate,
        periodStart: r.periodStart,
        invoiceLineId: lineId,
        paymentId: null,
      });
    } else {
      // Lowering: the opening lines of the period, latest first, never below what is paid.
      const opening = inMemory(state);
      const lines = state.lines
        .filter((l) => l.opening === true && l.kind === r.kind && l.periodStart === r.periodStart)
        .sort((a, b) => b.sequence - a.sequence);
      let need = -r.amountMinor;
      const parts: { lineId: string; amountMinor: number }[] = [];
      for (const line of lines) {
        const owed = lineBalance(line, opening.allocations).outstandingMinor;
        const take = Math.min(owed, need);
        if (take > 0) parts.push({ lineId: line.id, amountMinor: take });
        need -= take;
        if (need === 0) break;
      }
      if (lines.length === 0) {
        issue(
          S.arrears,
          r.row,
          'Period start',
          'No arrears were brought in for this lease and period',
        );
        continue;
      }
      if (need > 0) {
        issue(
          S.arrears,
          r.row,
          'Amount',
          'Opening arrears cannot be lowered below what has been paid of them',
        );
        continue;
      }
      const d = draftOf(state, S.arrears, r.row);
      parts.forEach((p, i) => {
        const itemId = `arrears-.${leaseId}.${r.periodStart}.${r.kind}.${i + 1}`;
        d.lower.arrears.push({ itemId, lineId: p.lineId, amountMinor: p.amountMinor });
        d.meta.set(itemId, {
          kind: 'arrears',
          amountMinor: -p.amountMinor,
          dueOn: null,
          periodStart: r.periodStart,
          invoiceLineId: p.lineId,
          paymentId: null,
        });
      });
    }
    count(S.arrears, adjusting ? 'update' : 'create');
    totals.arrearsMinor += r.amountMinor;
  }

  // Deposits held.
  for (const r of rows.deposits) {
    const state = leaseOf(S.deposits, r);
    if (!state) continue;
    const leaseId = state.lease.id;
    const had = existing.deposit.get(leaseId) ?? 0;
    if (!adjusting) {
      if (had !== 0) {
        if (had === r.amountMinor) count(S.deposits, 'unchanged');
        else
          issue(
            S.deposits,
            r.row,
            'Amount held',
            'A deposit was brought in already with another amount; change it with the adjustment workbook',
          );
        continue;
      }
      if (state.lines.some((l) => l.kind === 'deposit' && l.opening !== true)) {
        issue(
          S.deposits,
          r.row,
          'Unit',
          'This lease’s deposit is billed on the platform; record its payment instead',
        );
        continue;
      }
    }
    if (r.amountMinor > 0) {
      const d = draftOf(state, S.deposits, r.row);
      const itemId = `deposit.${leaseId}`;
      const lineId = uuidv7();
      d.items.deposits.push({ itemId, lineId, amountMinor: r.amountMinor });
      d.meta.set(itemId, {
        kind: 'deposit',
        amountMinor: r.amountMinor,
        dueOn: null,
        periodStart: null,
        invoiceLineId: lineId,
        paymentId: null,
      });
    } else {
      // Lowering: the opening deposit lines, latest first, never below what has left 2100.
      const { held } = await depositAdjustment(tx, deps.engine, state);
      const lines = state.lines
        .filter((l) => l.kind === 'deposit' && l.opening === true)
        .sort((a, b) => b.sequence - a.sequence);
      let need = -r.amountMinor;
      const parts: { lineId: string; amountMinor: number }[] = [];
      if (need <= held)
        for (const line of lines) {
          const onLine = state.allocations
            .filter((a) => a.lineId === line.id && a.source === 'opening_balance')
            .reduce((sum, a) => sum + a.amountMinor, 0);
          const take = Math.min(onLine, need);
          if (take > 0) parts.push({ lineId: line.id, amountMinor: take });
          need -= take;
          if (need === 0) break;
        }
      if (lines.length === 0) {
        issue(S.deposits, r.row, 'Unit', 'No deposit was brought in for this lease');
        continue;
      }
      if (need > 0) {
        issue(
          S.deposits,
          r.row,
          'Amount held',
          'A deposit cannot be lowered below what has been taken from it',
        );
        continue;
      }
      const d = draftOf(state, S.deposits, r.row);
      parts.forEach((p, i) => {
        const itemId = `deposit-.${leaseId}.${i + 1}`;
        d.lower.deposits.push({ itemId, lineId: p.lineId, amountMinor: p.amountMinor });
        d.meta.set(itemId, {
          kind: 'deposit',
          amountMinor: -p.amountMinor,
          dueOn: null,
          periodStart: null,
          invoiceLineId: p.lineId,
          paymentId: null,
        });
      });
    }
    count(S.deposits, adjusting ? 'update' : 'create');
    totals.depositsMinor += r.amountMinor;
  }

  // Advances.
  for (const r of rows.advances) {
    const state = leaseOf(S.advances, r);
    if (!state) continue;
    const leaseId = state.lease.id;
    let amount = r.amountMinor;
    if (amount === null) {
      const billingStart = state.lease.billingStartDate!;
      const lastDay = lastBillableDay(state.lease);
      const periods = state.schedule
        .filter((s) => lastDay === null || s.periodStart <= lastDay)
        .map((s) => ({
          periodStart: s.periodStart,
          periodEnd: s.periodEnd,
          amountMinor: s.amountMinor,
          taxMinor: expectedTaxMinor(s, state.vatRates),
        }));
      try {
        amount = advanceFromPaidThrough({ periods, billingStart, paidThrough: r.paidThrough! });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        issue(S.advances, r.row, 'Paid through', error.message);
        continue;
      }
      if (amount === 0) {
        issue(
          S.advances,
          r.row,
          'Paid through',
          `The platform bills this lease from ${billingStart}; nothing is paid ahead of that`,
        );
        continue;
      }
    }
    const had = existing.advance.get(leaseId) ?? 0;
    if (!adjusting && had !== 0) {
      if (had === amount) count(S.advances, 'unchanged');
      else
        issue(
          S.advances,
          r.row,
          'Amount',
          'An advance was brought in already with another amount; change it with the adjustment workbook',
        );
      continue;
    }
    if (amount > 0) {
      const d = draftOf(state, S.advances, r.row);
      const itemId = `advance.${leaseId}`;
      const paymentId = uuidv7();
      d.items.advances.push({
        itemId,
        paymentId,
        order: openingPaymentOrder(cutOver, paymentId),
        amountMinor: amount,
      });
      d.meta.set(itemId, {
        kind: 'advance',
        amountMinor: amount,
        dueOn: null,
        periodStart: null,
        invoiceLineId: null,
        paymentId,
      });
    } else {
      const opening = inMemory(state);
      const payments = state.payments
        .filter((p) => p.opening)
        .sort((a, b) => (a.order < b.order ? 1 : -1));
      let need = -amount;
      const parts: { paymentId: string; amountMinor: number }[] = [];
      for (const p of payments) {
        const take = Math.min(paymentCredit(p, opening.allocations), need);
        if (take > 0) parts.push({ paymentId: p.id, amountMinor: take });
        need -= take;
        if (need === 0) break;
      }
      if (payments.length === 0) {
        issue(S.advances, r.row, 'Amount', 'No advance was brought in for this lease');
        continue;
      }
      if (need > 0) {
        issue(
          S.advances,
          r.row,
          'Amount',
          'An advance cannot be lowered below what has been drawn from it',
        );
        continue;
      }
      const d = draftOf(state, S.advances, r.row);
      parts.forEach((p, i) => {
        const itemId = `advance-.${leaseId}.${i + 1}`;
        d.lower.advances.push({ itemId, paymentId: p.paymentId, amountMinor: p.amountMinor });
        d.meta.set(itemId, {
          kind: 'advance',
          amountMinor: -p.amountMinor,
          dueOn: null,
          periodStart: null,
          invoiceLineId: null,
          paymentId: p.paymentId,
        });
      });
    }
    count(S.advances, adjusting ? 'update' : 'create');
    totals.advancesMinor += amount;
  }

  // Withholding outstanding (raising only; see the module comment).
  for (const r of rows.withholding) {
    const state = leaseOf(S.withholding, r);
    if (!state) continue;
    const leaseId = state.lease.id;
    const key = `${leaseId}|${r.periodStart}`;
    const had = existing.withholding.get(key) ?? 0;
    if (!adjusting && had !== 0) {
      if (had === r.amountMinor) count(S.withholding, 'unchanged');
      else
        issue(
          S.withholding,
          r.row,
          'Amount',
          'Withholding was brought in already for this period with another amount; add the difference with the adjustment workbook',
        );
      continue;
    }
    if (r.amountMinor < 0) {
      // The M5 withholding record awaiting its certificate never changes, and its certificate
      // posts what it records (P20): lowering 1150 under it would let the certificate clear more
      // than is held. A certificate that will never come is written off from its page (P24).
      issue(
        S.withholding,
        r.row,
        'Amount',
        'Withholding brought in cannot be lowered here: if its certificate will never come, write it off from its withholding page',
      );
      continue;
    }
    const period = state.schedule.find(
      (p) => p.chargeType === 'rent' && p.periodStart === r.periodStart,
    );
    let rule;
    try {
      rule = await deps.rules.resolveIn(
        tx,
        state.company.countryCode,
        `withholding_tax.rate.${state.lease.use}`,
        parseBusinessDate(r.withheldOn!),
      );
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      issue(
        S.withholding,
        r.row,
        'Withheld on',
        'No withholding tax rate is recorded for that date',
      );
      continue;
    }
    const rateBps = (rule.value as { bps: number }).bps;
    const d = draftOf(state, S.withholding, r.row);
    const itemId = `withholding.${leaseId}.${r.periodStart}`;
    d.items.withholding.push({ itemId, amountMinor: r.amountMinor });
    d.meta.set(itemId, {
      kind: 'withholding',
      amountMinor: r.amountMinor,
      dueOn: null,
      periodStart: r.periodStart,
      invoiceLineId: null,
      paymentId: null,
    });
    d.withholding.push({
      itemId,
      amountMinor: r.amountMinor,
      withheldOn: r.withheldOn!,
      periodStart: r.periodStart,
      rateBps,
      rateRuleId: rule.ruleId,
      differsFromRate: period
        ? multiplyBps(money(period.amountMinor), rateBps).amountMinor !== r.amountMinor
        : true,
    });
    count(S.withholding, adjusting ? 'update' : 'create');
    totals.withholdingMinor += r.amountMinor;
  }

  // Each lease's plan, in memory: its errors are the rows' (most are caught above).
  const leases: LeaseWork[] = [];
  for (const d of drafts.values()) {
    const { state } = d;
    const book = state.book.kind === 'book' ? state.book : null;
    if (!book) continue;
    const opening = inMemory(state);
    const ctx = {
      batchId: input.batchId,
      cutOver,
      today,
      bookId: book.bookId,
      lease: dimsOf(state.lease),
      schedule: state.schedule,
      billingStart: state.lease.billingStartDate!,
      lastDay: lastBillableDay(state.lease),
    };
    const deposit = await depositAdjustment(tx, deps.engine, state);
    const withholdingNow = await balance(tx, { accounts: ['1150'], leaseIds: [state.lease.id] });
    let plan: OpeningLeasePlan;
    try {
      plan = adjusting
        ? planOpeningAdjustment({
            ...ctx,
            state: opening,
            lower: d.lower,
            raise: d.items,
            depositHeldMinor: deposit.held,
          })
        : planOpeningLease({ ...ctx, state: opening, items: d.items });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      const first = d.rows[0]!;
      issue(first.sheet, first.row, null, error.message);
      continue;
    }
    const withholdingChange = d.withholding.reduce((s, w) => s + w.amountMinor, 0);
    const before = figuresOf(deps.engine, state, opening, today, {
      depositAdjustmentMinor: deposit.adjustment,
      withholdingMinor: withholdingNow,
    });
    const after = figuresOf(deps.engine, state, plan.after, today, {
      depositAdjustmentMinor: deposit.adjustment,
      withholdingMinor: withholdingNow + withholdingChange,
    });
    leases.push({
      leaseId: state.lease.id,
      unitCode: state.lease.unitCode,
      tenantName: state.lease.tenantName,
      ownerId: book.ownerId,
      bookId: book.bookId,
      state,
      items: d.items,
      lower: d.lower,
      meta: d.meta,
      withholding: d.withholding,
      before,
      after,
      plan,
    });
  }

  // Owner items.
  const owners: OwnerWork[] = [];
  const ownerIds = new Map(
    (
      await tx
        .select({
          id: schema.owner.id,
          reference: schema.owner.reference,
          archivedAt: schema.owner.archivedAt,
        })
        .from(schema.owner)
    ).map((o) => [o.reference, o]),
  );
  // Rent tax items are written under their owners' tax locks, after the leases' (M5 review 10).
  if (input.write)
    await lockOwnersTax(
      tx,
      input.companyId,
      rows.ownerItems.flatMap((r) => {
        const o = ownerIds.get(r.ownerReference);
        return o && r.rentTaxOutstandingMinor !== null ? [o.id] : [];
      }),
    );
  const dueRule = await ruleOrNull(
    deps.rules,
    tx,
    input.countryCode,
    'rent_tax.due_days_after_receipt',
    cutOver,
  );
  const alertRule = await ruleOrNull(
    deps.rules,
    tx,
    input.countryCode,
    'rent_tax.alert_days',
    cutOver,
  );
  for (const r of rows.ownerItems) {
    const owner = ownerIds.get(r.ownerReference);
    if (!owner || owner.archivedAt) {
      issue(
        S.ownerItems,
        r.row,
        'Owner reference',
        `No owner has the reference ${r.ownerReference}`,
      );
      continue;
    }
    if (r.agentCashMinor !== null && input.companyKind !== 'agency') {
      issue(
        S.ownerItems,
        r.row,
        'Agent-held cash',
        'Agent-held cash is for agencies: a landlord holds their own rent',
      );
      continue;
    }
    const bookId = await ownerBook(tx, owner.id);
    if (!bookId) {
      issue(S.ownerItems, r.row, 'Owner reference', 'This owner has no book yet');
      continue;
    }
    const cashNow = await balance(tx, { accounts: ['1070'], bookIds: [bookId] });
    const taxHad = existing.rentTax.get(owner.id) ?? { amountMinor: 0, dueOn: null };
    const cashHad = existing.agentCash.get(owner.id) ?? 0;
    const changes: OwnerOpeningChange[] = [];
    const meta = new Map<string, ItemMeta>();
    let unchanged = false;
    if (!adjusting && (cashHad !== 0 || taxHad.amountMinor !== 0)) {
      const same =
        (r.agentCashMinor ?? 0) === cashHad &&
        (r.rentTaxOutstandingMinor ?? 0) === taxHad.amountMinor &&
        (r.rentTaxOutstandingMinor === null || r.rentTaxDueOn === taxHad.dueOn);
      if (same) unchanged = true;
      else {
        issue(
          S.ownerItems,
          r.row,
          'Owner reference',
          'This owner’s items were brought in already with other amounts; change them with the adjustment workbook',
        );
        continue;
      }
    }
    if (unchanged) {
      count(S.ownerItems, 'unchanged');
      continue;
    }
    let rentTax: OwnerWork['rentTax'] = null;
    if (r.agentCashMinor !== null) {
      const itemId = `agent_cash.${owner.id}`;
      // M11 review S3: never below what the agent still holds, nor more than was brought in.
      const cashAvailable = Math.max(0, Math.min(cashHad, cashNow));
      changes.push({
        itemId,
        kind: 'agent_cash',
        amountMinor: r.agentCashMinor,
        availableMinor: cashAvailable,
      });
      meta.set(itemId, {
        kind: 'agent_cash',
        amountMinor: r.agentCashMinor,
        dueOn: null,
        periodStart: null,
        invoiceLineId: null,
        paymentId: null,
      });
      if (r.agentCashMinor < 0 && -r.agentCashMinor > cashAvailable) {
        issue(
          S.ownerItems,
          r.row,
          'Agent-held cash',
          cashAvailable < cashNow
            ? 'Agent-held cash can be lowered only by what was brought in at the cut-over'
            : 'Agent-held cash cannot be lowered below what the agent still holds',
        );
        continue;
      }
    }
    if (r.rentTaxOutstandingMinor !== null) {
      const itemId = `rent_tax.${owner.id}`;
      // What is left to lower: the owner's opening rent tax items still owed, less what GRA
      // payments settled of them (P18). An item is lowered once: by its one reversal.
      const opening = (await taxItems(tx, sql`i.owner_id = ${owner.id} and i.kind = 'opening'`))
        .filter((i) => i.correctedMinor === 0 && i.outstandingMinor > 0)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      const available = opening.reduce((sum, i) => sum + i.outstandingMinor, 0);
      const lower: { itemId: string; amountMinor: number }[] = [];
      let need = Math.max(0, -r.rentTaxOutstandingMinor);
      for (const i of opening) {
        const take = Math.min(i.outstandingMinor, need);
        if (take > 0) lower.push({ itemId: i.id, amountMinor: take });
        need -= take;
      }
      rentTax = {
        raise:
          r.rentTaxOutstandingMinor > 0
            ? { amountMinor: r.rentTaxOutstandingMinor, dueOn: r.rentTaxDueOn! }
            : null,
        lower,
        dueRuleId: dueRule,
        alertRuleId: alertRule,
      };
      changes.push({
        itemId,
        kind: 'rent_tax',
        amountMinor: r.rentTaxOutstandingMinor,
        dueOn: r.rentTaxDueOn,
        availableMinor: available,
      });
      meta.set(itemId, {
        kind: 'rent_tax',
        amountMinor: r.rentTaxOutstandingMinor,
        dueOn: r.rentTaxOutstandingMinor > 0 ? r.rentTaxDueOn : null,
        periodStart: null,
        invoiceLineId: null,
        paymentId: null,
      });
      if (r.rentTaxOutstandingMinor < 0 && -r.rentTaxOutstandingMinor > available) {
        issue(
          S.ownerItems,
          r.row,
          'Rent tax outstanding',
          'Rent tax outstanding cannot be lowered below what has been paid to GRA',
        );
        continue;
      }
    }
    let plan: OwnerOpeningPlan;
    try {
      plan = planOwnerOpening({ batchId: input.batchId, cutOver, bookId, changes });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      issue(S.ownerItems, r.row, null, error.message);
      continue;
    }
    const newDue =
      r.rentTaxOutstandingMinor && r.rentTaxOutstandingMinor > 0 ? r.rentTaxDueOn : null;
    owners.push({
      ownerId: owner.id,
      bookId,
      changes,
      meta,
      plan,
      rentTax,
      agentCashMinor: cashNow + (r.agentCashMinor ?? 0),
      rentTaxOutstandingMinor: taxHad.amountMinor + (r.rentTaxOutstandingMinor ?? 0),
      rentTaxDueOn:
        newDue !== null && (taxHad.dueOn === null || newDue < taxHad.dueOn) ? newDue : taxHad.dueOn,
    });
    count(S.ownerItems, adjusting ? 'update' : 'create');
    totals.agentCashMinor += r.agentCashMinor ?? 0;
    totals.rentTaxOutstandingMinor += r.rentTaxOutstandingMinor ?? 0;
  }

  return { issues, counts, totals, leases, owners, summary: summaryOf(leases, owners) };
}
