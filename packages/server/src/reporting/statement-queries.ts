import { sql, type Tx } from '@rent/db';
import { ageBucket, type AgeBucket } from '@rent/domain/billing';
import {
  addDays,
  addMonths,
  instantToDate,
  parseBusinessDate,
  startOfDay,
  toIsoDate,
} from '@rent/domain/dates';
import type { AccountCode, GraPayer } from '@rent/domain/ledger';
import type { DisplayStatus } from '@rent/domain/portfolio';
import {
  agentCashMovements,
  isCollectionMethod,
  ownerStatementFigures,
  reportMonth,
  type CollectionMethod,
  type OccupancyCounts,
  type OwnerStatementFigures,
  type OwnerStatementInput,
  type StatementAgentInput,
  type StatementPropertyInput,
} from '@rent/domain/reporting';
import { sumLines, type BalanceFilter, type BalanceRow } from '../ledger/ledger.queries';
import { prepaymentSplitAt, prepaymentSplitByProperty } from './prepayment-split';

/**
 * The owner statement's queries (AC-04; M9 plan 4.3, decisions 5 to 7). Every figure is read from
 * the owner's book or its sub-ledgers by accounting date, for a calendar month in the company's
 * time zone, with properties as a dimension, so a statement regenerated for a locked month reads
 * exactly the rows it read when it was issued: anything recorded later carries an accounting date
 * in the open month (CLAUDE.md section 4). Occupancy, which the ledger does not hold, is read from
 * the units' append-only status history as it stood at the end of the month's last day, and only
 * what had been recorded by then. Read in the caller's transaction, which must see the whole
 * owner (the service has applied the reader's scope first, decision 15). Nothing is written.
 */

export interface StatementScope {
  readonly ownerId: string;
  readonly bookId: string;
  /** `YYYY-MM`. */
  readonly month: string;
  /** An agency holds the owner's money (1070), so the statement has the agent's section. */
  readonly agency: boolean;
  /** The company's time zone: the month is a calendar month there (decision 5). */
  readonly timeZone: string;
}

/** A payment counted in the month's collections, for the PDF's list (times in the owner's zone). */
export interface StatementPaymentRow {
  readonly paymentId: string;
  readonly propertyId: string;
  readonly unitCode: string;
  /** `received`: posted to the lease; `matched`: unmatched money matched to it; `reversed`. */
  readonly kind: 'received' | 'matched' | 'reversed';
  readonly method: CollectionMethod;
  readonly receivedOn: string;
  /** When it was recorded (received, matched or reversed): an instant, UTC. */
  readonly recordedAt: Date;
  /** Negative for a reversal. */
  readonly amountMinor: number;
}

/** An expense of the month (M8 F3: flagged when it has no receipt); a reversal is negative. */
export interface StatementExpenseRow {
  readonly id: string;
  readonly propertyId: string;
  readonly category: string;
  readonly supplierName: string;
  readonly expenseDate: string;
  readonly amountMinor: number;
  readonly noReceipt: boolean;
}

export interface StatementComputation {
  readonly input: OwnerStatementInput;
  readonly figures: OwnerStatementFigures;
  readonly payments: readonly StatementPaymentRow[];
  readonly expenses: readonly StatementExpenseRow[];
}

const num = (value: unknown): number => Number(value ?? 0);

/** Balances keyed `<property>|<group>` from rows grouped by property and one other dimension. */
function keyed(rows: readonly BalanceRow[], other: 'accountCode' | 'rule' | null) {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.propertyId) continue;
    const key = other ? `${r.propertyId}|${r[other] ?? ''}` : r.propertyId;
    out.set(key, (out.get(key) ?? 0) + r.balanceMinor);
  }
  return out;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The month's dates: its first and last days, the day before, and the instant it ended. */
export function statementDates(month: string, timeZone: string) {
  const m = reportMonth(month);
  const first = parseBusinessDate(m.firstDay);
  return {
    month: m.month,
    firstDay: m.firstDay,
    lastDay: m.lastDay,
    /** Balances "at the start" are as of the day before the month. */
    dayBefore: toIsoDate(addDays(first, -1)),
    /** The first instant of the next month in the company's zone: history up to here counts. */
    endsAt: instantToDate(startOfDay(addMonths(first, 1), timeZone)),
  };
}

/** Works out one owner's statement for one month from the ledger and its sub-ledgers. */
export async function computeOwnerStatement(
  tx: Tx,
  scope: StatementScope,
): Promise<StatementComputation> {
  const d = statementDates(scope.month, scope.timeZone);
  const book = scope.bookId;
  const inMonth = {
    bookIds: [book],
    accountingDateFrom: d.firstDay,
    accountingDateTo: d.lastDay,
  } satisfies Omit<BalanceFilter, 'accounts'>;
  const atEnd = { bookIds: [book], accountingDateTo: d.lastDay };
  const atStart = { bookIds: [book], accountingDateTo: d.dayBefore };

  // Income, fees and rent tax of the month, by property (4000, 4100, 5100, 5300; P18 on 2200).
  const flows = keyed(
    await sumLines(tx, { ...inMonth, accounts: ['4000', '4100', '5100', '5300'] }, [
      'propertyId',
      'accountCode',
    ]),
    'accountCode',
  );
  const taxPaid = keyed(
    await sumLines(tx, { ...inMonth, accounts: ['2200'], rules: ['P18'] }, ['propertyId']),
    null,
  );
  // Deposits at the month's end, by property (2100).
  const held = keyed(
    await sumLines(tx, { ...atEnd, accounts: ['2100'] }, ['propertyId', 'accountCode']),
    'accountCode',
  );
  // Prepayments (2010) at the month's end, split as the dashboard splits them (M9 review).
  const prepaid = prepaymentSplitByProperty(
    (await prepaymentSplitAt(tx, { bookIds: [book], asOf: d.lastDay })).values(),
  );

  const arrears = await arrearsAtEnd(tx, book, d.lastDay);
  const taxItems = await rentTaxItems(tx, book, d.firstDay, d.lastDay);
  const payments = await collectedPayments(tx, book, d.firstDay, d.lastDay);
  const expenseTotals = await expensesByCategory(tx, book, d.firstDay, d.lastDay);
  const expenses = await expenseRows(tx, book, d.firstDay, d.lastDay);

  const propertyIds = new Set<string>([
    ...(await propertiesOf(tx, scope.ownerId, book, d.firstDay, d.lastDay, d.endsAt)),
    ...[...flows.keys(), ...[...held].flatMap(([k, v]) => (v === 0 ? [] : [k]))].map(
      (k) => k.split('|')[0] as string,
    ),
    ...taxPaid.keys(),
    ...arrears.keys(),
    ...[...prepaid].flatMap(([k, v]) =>
      v.prepaymentsMinor === 0 && v.unearnedRentMinor === 0 && v.unearnedServiceChargeMinor === 0
        ? []
        : [k],
    ),
    ...taxItems.keys(),
    ...payments.map((p) => p.propertyId),
    ...expenseTotals.keys(),
  ]);
  const ids = [...propertyIds].sort();
  const occupancy = await occupancyAtEnd(tx, ids, d.endsAt);

  const flow = (propertyId: string, account: string) => flows.get(`${propertyId}|${account}`) ?? 0;
  const properties: StatementPropertyInput[] = ids.map((propertyId) => {
    const split = prepaid.get(propertyId);
    const byMethod = new Map<CollectionMethod, number>();
    for (const p of payments)
      if (p.propertyId === propertyId)
        byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amountMinor);
    return {
      propertyId,
      collections: [...byMethod].map(([method, amountMinor]) => ({ method, amountMinor })),
      expenses: expenseTotals.get(propertyId) ?? [],
      feesMinor: flow(propertyId, '5100'),
      rentTax: {
        accruedMinor: flow(propertyId, '5300'),
        paidMinor: taxPaid.get(propertyId) ?? 0,
        receiptItemsMinor: taxItems.get(propertyId) ?? [],
      },
      rentEarnedMinor: 0 - flow(propertyId, '4000'),
      serviceChargeEarnedMinor: 0 - flow(propertyId, '4100'),
      // AR-03, with the dashboard's definitions: money allocated to rent and to service-charge
      // lines not started by the month's end, and the rest of 2010 as credit.
      unearnedRentMinor: split?.unearnedRentMinor ?? 0,
      unearnedServiceChargeMinor: split?.unearnedServiceChargeMinor ?? 0,
      creditMinor: split?.creditMinor ?? 0,
      depositsHeldMinor: 0 - (held.get(`${propertyId}|2100`) ?? 0),
      arrears: arrears.get(propertyId) ?? [],
      occupancy: occupancy.get(propertyId) ?? {},
    };
  });

  const ownerLevel = await sumLines(tx, { ...inMonth, accounts: ['5200', '2200'] }, [
    'accountCode',
    'rule',
  ]);
  const processingFeesMinor = ownerLevel
    .filter((r) => r.accountCode === '5200')
    .reduce((s, r) => s + r.balanceMinor, 0);
  const certifiedMinor = ownerLevel
    .filter((r) => r.accountCode === '2200' && r.rule === 'P20')
    .reduce((s, r) => s + r.balanceMinor, 0);
  const payable = async (filter: typeof atEnd) =>
    0 -
    (await sumLines(tx, { ...filter, accounts: ['2200'] })).reduce((s, r) => s + r.balanceMinor, 0);

  const input: OwnerStatementInput = {
    ownerId: scope.ownerId,
    month: d.month,
    properties,
    processingFeesMinor,
    // Always given (founder decision, 2026-11-05: required when the agency pays GRA).
    rentTaxPayable: {
      openingMinor: await payable(atStart),
      closingMinor: await payable(atEnd),
      certifiedMinor,
    },
    agent: scope.agency
      ? await agentSide(tx, {
          ownerId: scope.ownerId,
          book,
          firstDay: d.firstDay,
          lastDay: d.lastDay,
          dayBefore: d.dayBefore,
        })
      : null,
  };
  return { input, figures: ownerStatementFigures(input), payments, expenses };
}

/**
 * BC-08 at the month's end, as the accrual section shows it: what tenants owed (1100, by invoice
 * line, by accounting date) on lines past their due date, aged by days past due. Months of an
 * annual invoice not started yet are not owed in the ledger, so they are not arrears here.
 */
async function arrearsAtEnd(
  tx: Tx,
  book: string,
  lastDay: string,
): Promise<Map<string, { bucket: AgeBucket; amountMinor: number }[]>> {
  const rows = await tx.execute<{ property_id: string; due_date: string; amount: string }>(
    sql`select l.property_id, il.due_date::text as due_date, sum(l.amount_minor)::bigint as amount
        from journal_line l
        join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
        join invoice_line il on il.company_id = l.company_id and il.id = l.invoice_line_id
        where l.book_id = ${book}::uuid and l.account_code = '1100'
          and l.property_id is not null and e.accounting_date <= ${lastDay}::date
        group by l.invoice_line_id, l.property_id, il.due_date
        having sum(l.amount_minor) > 0`,
  );
  const out = new Map<string, { bucket: AgeBucket; amountMinor: number }[]>();
  for (const r of rows.rows) {
    const bucket = ageBucket(r.due_date, lastDay);
    if (bucket) push(out, r.property_id, { bucket, amountMinor: num(r.amount) });
  }
  return out;
}

/** Each rent tax item reported in the month, net of its reversals (TX-01; invariant 6). */
async function rentTaxItems(
  tx: Tx,
  book: string,
  firstDay: string,
  lastDay: string,
): Promise<Map<string, number[]>> {
  const rows = await tx.execute<{ property_id: string; tax_minor: string }>(
    sql`select i.property_id, i.tax_minor from rent_tax_item i
        where i.book_id = ${book}::uuid
          and i.accounting_date between ${firstDay}::date and ${lastDay}::date
        order by i.accounting_date, i.created_at, i.id`,
  );
  const out = new Map<string, number[]>();
  for (const r of rows.rows) push(out, r.property_id, num(r.tax_minor));
  return out;
}

/**
 * Money received from tenants in the month (decision 6): payments posted to a lease of the owner,
 * unmatched money matched to one, and reversals of either, each by its own accounting date.
 */
async function collectedPayments(
  tx: Tx,
  book: string,
  firstDay: string,
  lastDay: string,
): Promise<StatementPaymentRow[]> {
  const rows = await tx.execute<{
    kind: StatementPaymentRow['kind'];
    payment_id: string;
    method: string;
    property_id: string;
    unit_code: string | null;
    received_on: string;
    recorded_at: Date | string;
    amount_minor: string;
  }>(
    sql`select 'received' as kind, p.id as payment_id, p.method, p.property_id, u.code as unit_code,
          p.received_on::text as received_on, p.created_at as recorded_at, p.amount_minor
        from payment p left join unit u on u.company_id = p.company_id and u.id = p.unit_id
        where p.book_id = ${book}::uuid and p.property_id is not null
          and p.accounting_date between ${firstDay}::date and ${lastDay}::date
        union all
        select 'matched', p.id, p.method, m.property_id, u.code, p.received_on::text, m.created_at,
          p.amount_minor
        from payment_match m
        join payment p on p.company_id = m.company_id and p.id = m.payment_id
        left join unit u on u.company_id = m.company_id and u.id = m.unit_id
        where m.book_id = ${book}::uuid
          and m.accounting_date between ${firstDay}::date and ${lastDay}::date
        union all
        select 'reversed', p.id, p.method, coalesce(m.property_id, p.property_id), u.code,
          p.received_on::text, r.created_at, -p.amount_minor
        from payment_reversal r
        join payment p on p.company_id = r.company_id and p.id = r.payment_id
        left join payment_match m on m.company_id = p.company_id and m.payment_id = p.id
        left join unit u on u.company_id = p.company_id and u.id = coalesce(m.unit_id, p.unit_id)
        where coalesce(m.book_id, p.book_id) = ${book}::uuid
          and coalesce(m.property_id, p.property_id) is not null
          and r.accounting_date between ${firstDay}::date and ${lastDay}::date
        order by received_on, recorded_at, payment_id, kind`,
  );
  return rows.rows.flatMap((r) =>
    isCollectionMethod(r.method)
      ? [
          {
            paymentId: r.payment_id,
            propertyId: r.property_id,
            unitCode: r.unit_code ?? '',
            kind: r.kind,
            method: r.method,
            receivedOn: r.received_on,
            recordedAt: r.recorded_at instanceof Date ? r.recorded_at : new Date(r.recorded_at),
            amountMinor: num(r.amount_minor),
          },
        ]
      : [],
  );
}

/** Expenses of the month by category and property (P15 on 5000 and 5400, net of reversals). */
async function expensesByCategory(
  tx: Tx,
  book: string,
  firstDay: string,
  lastDay: string,
): Promise<Map<string, { category: string; amountMinor: number }[]>> {
  const rows = await tx.execute<{ property_id: string; category: string; amount: string }>(
    sql`select l.property_id, coalesce(x.category, xr.category, 'other') as category,
          sum(l.amount_minor)::bigint as amount
        from journal_line l
        join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
        left join expense x on x.company_id = e.company_id and x.entry_id = e.id
        left join expense_reversal r on r.company_id = e.company_id and r.entry_id = e.id
        left join expense xr on xr.company_id = r.company_id and xr.id = r.expense_id
        where l.book_id = ${book}::uuid and l.account_code in ('5000', '5400')
          and l.property_id is not null
          and e.accounting_date between ${firstDay}::date and ${lastDay}::date
        group by 1, 2
        having sum(l.amount_minor) <> 0`,
  );
  const out = new Map<string, { category: string; amountMinor: number }[]>();
  for (const r of rows.rows)
    push(out, r.property_id, { category: r.category, amountMinor: num(r.amount) });
  return out;
}

/**
 * The month's expenses one by one (choice 12: recorded in the month, paid or not), with their
 * receipt flag. One recorded and reversed in the same month is left out; a reversal in a later
 * month shows there, negative.
 */
async function expenseRows(
  tx: Tx,
  book: string,
  firstDay: string,
  lastDay: string,
): Promise<StatementExpenseRow[]> {
  const rows = await tx.execute<{
    id: string;
    property_id: string;
    category: string;
    supplier_name: string;
    expense_date: string;
    amount_minor: string;
    no_receipt: boolean;
  }>(
    sql`select x.id, x.property_id, x.category, x.supplier_name, x.expense_date::text as expense_date,
          x.amount_minor, x.receipt_document_id is null as no_receipt
        from expense x
        where x.book_id = ${book}::uuid
          and x.accounting_date between ${firstDay}::date and ${lastDay}::date
          and not exists (select 1 from expense_reversal r where r.company_id = x.company_id
                          and r.expense_id = x.id
                          and r.accounting_date between ${firstDay}::date and ${lastDay}::date)
        union all
        select x.id, x.property_id, x.category, x.supplier_name, x.expense_date::text,
          -x.amount_minor, x.receipt_document_id is null
        from expense_reversal r
        join expense x on x.company_id = r.company_id and x.id = r.expense_id
        where x.book_id = ${book}::uuid
          and r.accounting_date between ${firstDay}::date and ${lastDay}::date
          and not (x.accounting_date between ${firstDay}::date and ${lastDay}::date)
        order by expense_date, id`,
  );
  return rows.rows.map((r) => ({
    id: r.id,
    propertyId: r.property_id,
    category: r.category,
    supplierName: r.supplier_name,
    expenseDate: r.expense_date,
    amountMinor: num(r.amount_minor),
    noReceipt: r.no_receipt,
  }));
}

/**
 * The properties a statement has a page for: those with money in the owner's book in the month or
 * a balance at its end, and those the owner held at its end, as recorded by then (decision 15:
 * the statement belongs to the owner's book, whatever happens to a property later).
 */
async function propertiesOf(
  tx: Tx,
  ownerId: string,
  book: string,
  firstDay: string,
  lastDay: string,
  endsAt: Date,
): Promise<string[]> {
  const rows = await tx.execute<{ property_id: string }>(
    sql`select distinct l.property_id from journal_line l
        join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
        where l.book_id = ${book}::uuid and l.property_id is not null
          and e.accounting_date between ${firstDay}::date and ${lastDay}::date
        union
        select b.property_id from (
          select l.property_id, l.account_code from journal_line l
          join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
          where l.book_id = ${book}::uuid and l.property_id is not null
            and l.account_code in ('1100', '2010', '2100', '2200')
            and e.accounting_date <= ${lastDay}::date
          group by l.property_id, l.account_code
          having sum(l.amount_minor) <> 0) b
        union
        select o.property_id from (
          select po.property_id, po.owner_id, po.effective_from,
            max(po.effective_from) over (partition by po.property_id) as latest
          from property_ownership po
          join property p on p.company_id = po.company_id and p.id = po.property_id
          where po.effective_from <= ${lastDay}::date and po.created_at < ${endsAt}
            and (p.archived_at is null or p.archived_at >= ${endsAt})
            and not exists (select 1 from property_ownership_correction c
                            where c.company_id = po.company_id and c.ownership_id = po.id
                              and c.created_at < ${endsAt})) o
        where o.effective_from = o.latest and o.owner_id = ${ownerId}::uuid`,
  );
  return rows.rows.map((r) => r.property_id);
}

/**
 * Units by the status shown for each (PR-06) at the end of the month: the latest occupancy and
 * availability in each unit's history recorded before then. A unit with no history by then did
 * not exist yet; one archived before then is left out.
 */
async function occupancyAtEnd(
  tx: Tx,
  propertyIds: readonly string[],
  endsAt: Date,
): Promise<Map<string, OccupancyCounts>> {
  if (propertyIds.length === 0) return new Map();
  const rows = await tx.execute<{
    property_id: string;
    occupancy: string | null;
    availability: string | null;
  }>(
    sql`select u.property_id,
          (select e.to_value from unit_status_event e
           where e.company_id = u.company_id and e.unit_id = u.id and e.kind = 'occupancy'
             and e.occurred_at < ${endsAt}
           order by e.occurred_at desc, e.id desc limit 1) as occupancy,
          (select e.to_value from unit_status_event e
           where e.company_id = u.company_id and e.unit_id = u.id and e.kind = 'availability'
             and e.occurred_at < ${endsAt}
           order by e.occurred_at desc, e.id desc limit 1) as availability
        from unit u
        where u.property_id = any(${`{${propertyIds.join(',')}}`}::uuid[])
          and (u.archived_at is null or u.archived_at >= ${endsAt})`,
  );
  const out = new Map<string, Partial<Record<DisplayStatus, number>>>();
  for (const r of rows.rows) {
    if (r.occupancy === null && r.availability === null) continue;
    // Occupancy from leases wins; otherwise the availability set by hand (PR-06).
    const status: DisplayStatus =
      r.occupancy === 'occupied' || r.occupancy === 'reserved'
        ? r.occupancy
        : r.availability === 'reserved' ||
            r.availability === 'under_repair' ||
            r.availability === 'not_lettable'
          ? r.availability
          : 'vacant';
    const counts = out.get(r.property_id) ?? {};
    counts[status] = (counts[status] ?? 0) + 1;
    out.set(r.property_id, counts);
  }
  return out;
}

/**
 * The agent's side (decision 6; choices 8 to 10): the owner's money in the agency's account (1070)
 * at the start and end of the month and every movement between, by kind; the fees due (2300); and
 * who pays GRA under the management agreement in force at the month's end (none: the owner).
 */
async function agentSide(
  tx: Tx,
  input: {
    readonly ownerId: string;
    readonly book: string;
    readonly firstDay: string;
    readonly lastDay: string;
    readonly dayBefore: string;
  },
): Promise<StatementAgentInput> {
  const { book, firstDay, lastDay } = input;
  const total = async (account: AccountCode, to: string) =>
    (await sumLines(tx, { bookIds: [book], accounts: [account], accountingDateTo: to }))
      .map((r) => r.balanceMinor)
      .reduce((s, v) => s + v, 0);
  const entries = await tx.execute<{
    rule: string;
    reversed_rule: string | null;
    cash: string | null;
    fees: string | null;
  }>(
    sql`select e.rule, o.rule as reversed_rule,
          sum(l.amount_minor) filter (where l.account_code = '1070')::bigint as cash,
          sum(l.amount_minor) filter (where l.account_code = '2300')::bigint as fees
        from journal_line l
        join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
        left join journal_entry o on o.company_id = e.company_id and o.id = e.reverses_entry_id
        where l.book_id = ${book}::uuid and l.account_code in ('1070', '2300')
          and e.accounting_date between ${firstDay}::date and ${lastDay}::date
        group by l.entry_id, e.rule, o.rule`,
  );
  // In and out by kind, entry by entry, from the 1070 lines the categories name; the balances
  // above are the 1070 lines themselves, so the identity fails on anything unnamed (M9 review).
  const movements = agentCashMovements(
    entries.rows.map((e) => ({
      rule: e.rule,
      reversedRule: e.reversed_rule,
      cashMinor: num(e.cash),
      feesMinor: num(e.fees),
    })),
  );
  const [terms] = (
    await tx.execute<{ gra_paid_by: GraPayer }>(
      sql`select gra_paid_by from management_fee_terms
          where owner_id = ${input.ownerId}::uuid and effective_from <= ${lastDay}::date
          order by effective_from desc, created_at desc, id desc limit 1`,
    )
  ).rows;
  return {
    cash: {
      openingMinor: await total('1070', input.dayBefore),
      closingMinor: await total('1070', lastDay),
      in: movements.in,
      out: movements.out,
    },
    feesDue: {
      openingMinor: 0 - (await total('2300', input.dayBefore)),
      closingMinor: 0 - (await total('2300', lastDay)),
      settledAtSourceMinor: movements.settledAtSourceMinor,
    },
    reserveMinor: 0,
    graPaidBy: terms?.gra_paid_by ?? 'owner',
    // Tax a tenant withheld, waiting for its certificate: in 2200, never paid to GRA by the agency.
    withholdingPendingMinor: await total('1150', lastDay),
  };
}
