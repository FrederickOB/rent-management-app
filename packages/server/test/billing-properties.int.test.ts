import { schema, sql, withCompany } from '@rent/db';
import {
  creditPools,
  cyclesForAdvance,
  cyclesToIssue,
  depositDue,
  expectedTaxMinor,
  invoiceCycles,
  invoiceLinesFor,
  isTax,
  lineBalance,
  paymentCredit,
  postingClassOf,
  type InvoiceCycle,
  type VatRates,
} from '@rent/domain/billing';
import {
  LeaseLedgerModel,
  moveOutDay,
  operationArbitrary,
  receivedOn,
  type Operation,
} from '@rent/domain/billing/testing';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { INCOME_ACCOUNTS, type AccountCode, type CashAccount } from '@rent/domain/ledger';
import { checkLeaseTerms, rentSchedule, type RentCycle } from '@rent/domain/tenancy';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServerTest, type ServerTestContext } from './support';
import {
  approvedCash,
  approvedTransfer,
  billedLease,
  billingServices,
  journalSum,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { propertyWithUnits, tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * The integration half of the four property tests (M4a plan section 6): the same random sequence
 * of days, payments, reversals, credit notes and write-offs runs through the reference model
 * (packages/domain/src/billing/testing/lease-ledger.ts) and through the real services against the
 * database, and after every step the two agree on every line, payment and account of the lease.
 * The database's own sub-ledger check passes at the end. Run counts are modest because CI runs the
 * integration suites together; M4A_PROPERTY_RUNS raises them locally.
 */
const RUNS = Number(process.env.M4A_PROPERTY_RUNS ?? 24);
const VAT: VatRates = { vatBps: 1500, nhilBps: 250, getfundBps: 250, appliesToServiceCharge: true };
const ACCOUNTS: readonly AccountCode[] = [
  '1100',
  '2010',
  '2100',
  '4000',
  '4100',
  '2210',
  '5900',
  '1050',
  '1060',
  '1010',
  '1070',
];
const DAY = 86_400_000;

let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let base: Date;
let today: string;

interface DiffLease {
  readonly startOffset: number;
  readonly months: number;
  readonly shortFinalDays: number;
  readonly rent: number;
  readonly serviceCharge: number | null;
  readonly cycle: RentCycle;
  readonly advanceExtra: number | null;
  readonly deposit: number | null;
  readonly vat: boolean;
}

/** Leases that start today or within the month, so every date the run visits is in the future. */
const leaseArbitrary: fc.Arbitrary<DiffLease> = fc.record({
  startOffset: fc.integer({ min: 0, max: 30 }),
  months: fc.integer({ min: 1, max: 14 }),
  shortFinalDays: fc.integer({ min: 0, max: 20 }),
  rent: fc.integer({ min: 100, max: 2_000_000 }),
  serviceCharge: fc.option(fc.integer({ min: 100, max: 200_000 }), { nil: null }),
  cycle: fc.constantFrom<RentCycle>('monthly', 'quarterly', 'six_monthly', 'annual'),
  advanceExtra: fc.option(fc.integer({ min: 0, max: 12 }), { nil: null }),
  deposit: fc.option(fc.integer({ min: 100, max: 2_000_000 }), { nil: null }),
  vat: fc.boolean(),
});

const operations = (withCorrections: boolean) =>
  fc.array(operationArbitrary(withCorrections), { minLength: 4, maxLength: 18 });

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));

/** Lease terms the domain accepts, or null (as the domain's own scenarios filter them). */
function termsOf(l: DiffLease) {
  const start = plusDays(today, l.startOffset);
  const end = plusDays(
    toIsoDate(addMonths(parseBusinessDate(start), l.months)),
    -1 - l.shortFinalDays,
  );
  try {
    const probe = checkLeaseTerms({
      startDate: start,
      endDate: end,
      monthlyRentMinor: l.rent,
      cycle: 'monthly',
      noticeDays: 30,
      use: 'residential',
    });
    const months = { monthly: 1, quarterly: 3, six_monthly: 6, annual: 12 };
    const cycle: RentCycle = months[l.cycle] <= probe.periodCount ? l.cycle : 'monthly';
    const advance =
      l.advanceExtra === null ? null : Math.min(months[cycle] + l.advanceExtra, probe.periodCount);
    return checkLeaseTerms({
      startDate: start,
      endDate: end,
      monthlyRentMinor: l.rent,
      cycle,
      initialAdvanceMonths: advance,
      depositMinor: l.deposit,
      serviceChargeMonthlyMinor: l.serviceCharge,
      noticeDays: 30,
      use: l.vat ? 'commercial' : 'residential',
    });
  } catch {
    return null;
  }
}

/** One run: a fresh agency, owner, property and lease, the model beside it. */
async function runOne(
  lease: DiffLease,
  ops: readonly Operation[],
  check: (r: Run) => Promise<void>,
) {
  const terms = termsOf(lease);
  if (!terms) return;
  ctx.clock.set(base);
  const agency = await moneyCompany(
    ctx,
    s,
    'agency',
    `Diff ${Math.random().toString(36).slice(2, 8)}`,
  );
  const owner = (
    await s.owners.create(agency.admin, {
      kind: 'individual',
      displayName: 'Diff Owner',
      vatRegistered: lease.vat,
    })
  ).id;
  const property = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: 'DIF',
    ownerId: owner,
    use: lease.vat ? 'commercial' : 'residential',
    units: [
      lease.vat ? { unitType: 'shop', count: 1 } : { unitType: 'apartment', count: 1, bedrooms: 2 },
    ],
  });
  const tenant = (
    await s.tenants.create(agency.manager, { kind: 'individual', displayName: 'Diff Tenant' })
  ).tenant.id;
  const dbLease = await billedLease(ctx, s, b, agency.manager, {
    unitId: Object.values(property.units)[0]!,
    tenantId: tenant,
    startDate: terms.startDate,
    endDate: terms.endDate,
    monthlyRentMinor: terms.monthlyRentMinor,
    cycle: terms.cycle,
    initialAdvanceMonths: terms.initialAdvanceMonths,
    depositMinor: terms.depositMinor,
    serviceChargeMonthlyMinor: terms.serviceChargeMonthlyMinor,
    use: terms.use,
    signedOn: today,
    billingStartDate: terms.startDate,
  });
  // The model, set up as the services set the lease up at signing.
  const model = new LeaseLedgerModel(today);
  const schedule = rentSchedule(terms).map((p) => ({
    id: `cp-${p.chargeType}-${p.sequence}`,
    sequence: p.sequence,
    chargeType: p.chargeType,
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    amountMinor: p.amountMinor,
    source: 'schedule' as const,
  }));
  model.scheduled = schedule.map(({ sequence: _s, source: _src, ...p }) => ({
    ...p,
    taxMinor: expectedTaxMinor(p, lease.vat ? VAT : null),
  }));
  const cycles: InvoiceCycle[] = invoiceCycles({
    cycle: terms.cycle,
    initialAdvanceMonths: terms.initialAdvanceMonths,
    schedule,
    billingStartDate: terms.startDate,
    lastBillableDay: null,
    leadDays: 14,
  });
  const issued = new Set<string>();
  const vat = lease.vat ? VAT : null;
  const deposit = depositDue({
    depositMinor: terms.depositMinor,
    startDate: terms.startDate,
    billingStartDate: terms.startDate,
    carriedDepositMinor: 0,
  });
  if (deposit > 0)
    model.issue(
      [
        {
          kind: 'deposit',
          chargePeriodId: null,
          periodStart: null,
          periodEnd: null,
          amountMinor: deposit,
          rateBps: null,
          baseIndex: null,
        },
      ],
      terms.startDate,
      'deposit',
    );
  const issue = (cycle: InvoiceCycle, taxPoint?: string) => {
    model.issue(invoiceLinesFor(cycle, vat), cycle.dueDate, cycle.cycleStart, taxPoint);
    issued.add(cycle.cycleStart);
  };
  const tick = () => {
    const last = model.lastDay;
    const due = last === null ? cycles : cycles.filter((c) => c.cycleStart <= last);
    for (const cycle of cyclesToIssue(due, model.today, issued)) issue(cycle);
    model.accrueTo(model.today);
  };
  tick();
  const run: Run = {
    agency,
    leaseId: dbLease.id,
    model,
    paymentIds: [],
    async apply(op) {
      await apply(this, op, {
        cycles,
        issued,
        issue,
        tick,
        vat,
        startDate: terms.startDate,
        endDate: terms.endDate,
      });
    },
  };
  await check(run);
  for (const op of ops) {
    await run.apply(op);
    await check(run);
  }
  const result = await b.subledger.check(agency.companyId, { alert: false });
  expect(result.mismatches).toEqual([]);
  ctx.clock.set(base);
}

interface Run {
  readonly agency: Awaited<ReturnType<typeof moneyCompany>>;
  readonly leaseId: string;
  readonly model: LeaseLedgerModel;
  /** The database's payment ids, in the order the model made its payments. */
  readonly paymentIds: string[];
  apply(op: Operation): Promise<void>;
}

const cashLocation = {
  '1050': 'provider',
  '1060': 'collector',
  '1010': 'owner_account',
  '1070': 'agency_account',
} as const;

async function apply(
  run: Run,
  op: Operation,
  m: {
    cycles: InvoiceCycle[];
    issued: Set<string>;
    issue: (c: InvoiceCycle, taxPoint?: string) => void;
    tick: () => void;
    vat: VatRates | null;
    startDate: string;
    endDate: string;
  },
): Promise<void> {
  const { model, agency } = run;
  const companyId = agency.companyId;
  switch (op.kind) {
    case 'days': {
      for (let i = 0; i < op.days; i += 1) {
        model.nextDay();
        m.tick();
      }
      ctx.clock.advance(op.days * DAY);
      await b.invoicing.withLease(companyId, run.leaseId, model.today, async (tx, state) => {
        await b.engine.generate(tx, state, model.today);
        await b.engine.accrue(tx, state, model.today);
      });
      return;
    }
    case 'pay': {
      // Received up to 45 days before it is recorded, never before signing (review 2).
      const valueDate = receivedOn(model.today, op.daysBack, today);
      // Decision 4, as the services apply it: a payment beyond what is open issues the invoices
      // it pays for, charged on its own value date (review A, D2).
      if (m.vat) {
        const live = model.payments.filter((p) => !p.reversed);
        const open = model.lines.reduce(
          (sum, l) => sum + lineBalance(l, model.allocations).outstandingMinor,
          0,
        );
        const credit = creditPools(live, model.allocations).reduce(
          (sum, p) => sum + p.amountMinor,
          0,
        );
        if (op.amountMinor > open)
          for (const cycle of cyclesForAdvance({
            pending: m.cycles.filter(
              (c) =>
                !m.issued.has(c.cycleStart) &&
                (model.lastDay === null || c.cycleStart <= model.lastDay),
            ),
            openMinor: open - credit,
            paymentMinor: op.amountMinor,
            vat: m.vat,
          }))
            m.issue(cycle, valueDate);
      }
      model.pay(op.amountMinor, op.cash, valueDate);
      run.paymentIds.push(await payInDatabase(run, op.amountMinor, op.cash, valueDate));
      return;
    }
    case 'reverse': {
      const live = model.payments.filter((p) => !p.reversed);
      if (live.length === 0) return;
      const target = live[op.pick % live.length]!;
      const index = model.payments.indexOf(target);
      model.reverse(target.id);
      const requestId = await b.money.requestReversal(agency.manager, run.paymentIds[index]!, {
        reason: 'wrong_entry',
        note: 'Recorded against the wrong lease',
        moneyNowIn: cashLocation[target.cash],
      });
      await s.approvals.decide(agency.admin, requestId, { decision: 'approve' });
      return;
    }
    case 'credit': {
      const bases = model.lines.filter((l) => !isTax(l.kind));
      if (bases.length === 0) return;
      const line = bases[op.pick % bases.length]!;
      const balance = lineBalance(line, model.allocations);
      const creditable =
        line.kind === 'deposit'
          ? balance.outstandingMinor
          : balance.netMinor - balance.writtenOffMinor;
      const amount = Math.floor((creditable * op.percent) / 100);
      if (amount <= 0) return;
      const index = model.lines.indexOf(line);
      model.creditNote(line.id, amount, `${line.id}-${model.allocations.length}`);
      const lines = await dbLines(run);
      const requestId = await b.money.requestCreditNote(agency.manager, lines[index]!.id, {
        amountMinor: amount,
        reason: 'A random correction',
      });
      await s.approvals.decide(agency.admin, requestId, { decision: 'approve' });
      return;
    }
    case 'move_out': {
      // The tenant left up to 60 days ago, recorded today (review 14).
      // Within the term only: the model does not hold a lease over past its end (M3 does).
      if (model.today > m.endDate) return;
      const day = moveOutDay(model.today, op.daysBack, m.startDate, model.lastDay);
      if (!day) return;
      await s.lifecycle.runTransitions(companyId, model.today);
      await s.lifecycle.recordMoveOut(agency.manager, run.leaseId, { moveOutDate: day });
      await b.invoicing.onLeaseEnded(companyId, run.leaseId);
      model.moveOut(day);
      return;
    }
    case 'write_off': {
      const owed = model.lines.filter(
        (l) =>
          postingClassOf(l) === 'receivable' &&
          lineBalance(l, model.allocations).outstandingMinor > 0,
      );
      if (owed.length === 0) return;
      const line = owed[op.pick % owed.length]!;
      const amount = Math.floor(
        (lineBalance(line, model.allocations).outstandingMinor * op.percent) / 100,
      );
      if (amount <= 0) return;
      const index = model.lines.indexOf(line);
      model.writeOff(line.id, amount, `${line.id}-${model.allocations.length}`);
      const lines = await dbLines(run);
      const requestId = await b.money.requestWriteOff(agency.manager, lines[index]!.id, {
        amountMinor: amount,
        reason: 'A random write-off',
      });
      await s.approvals.decide(agency.admin, requestId, { decision: 'approve' });
      return;
    }
  }
}

async function payInDatabase(
  run: Run,
  amountMinor: number,
  cash: CashAccount,
  valueDate: string,
): Promise<string> {
  const { agency } = run;
  const companyId = agency.companyId;
  switch (cash) {
    case '1050':
      return (
        await b.money.recordProviderPayment(companyId, {
          leaseId: run.leaseId,
          amountMinor,
          receivedOn: valueDate,
        })
      ).paymentId;
    case '1060': {
      const recorded = await approvedCash(ctx, s, b, agency.manager, agency.admin, {
        leaseId: run.leaseId,
        amountMinor,
        receivedOn: valueDate,
      });
      return sourcePayment(companyId, recorded.cashRecordId);
    }
    default: {
      const recorded = await approvedTransfer(ctx, s, b, agency.manager, agency.admin, {
        leaseId: run.leaseId,
        receivedInto: cash === '1010' ? 'owner_account' : 'agency_account',
        amountMinor,
        receivedOn: valueDate,
      });
      return sourcePayment(companyId, recorded.directReceiptId);
    }
  }
}

async function sourcePayment(companyId: string, sourceId: string): Promise<string> {
  const [row] = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .select({ id: schema.payment.id })
      .from(schema.payment)
      .where(sql`${schema.payment.sourceId} = ${sourceId}`),
  );
  return row!.id;
}

async function dbState(run: Run) {
  return withCompany(
    ctx.database,
    { companyId: run.agency.companyId, actorKind: 'system' },
    async (tx) => {
      const state = await b.engine.load(tx, run.agency.companyId, run.leaseId);
      return { state, walk: b.engine.walk(state) };
    },
  );
}

const dbLines = async (run: Run) => (await dbState(run)).state.lines;

/** The model and the database agree on every line, payment and account of the lease. */
async function agree(run: Run): Promise<void> {
  const { model } = run;
  // The model's walk also brings its lines' accrued flags up to date.
  const expected = model.walk();
  const { state, walk } = await dbState(run);
  expect(state.lines.map((l) => [l.kind, l.amountMinor, l.dueDate, l.periodStart])).toEqual(
    model.lines.map((l) => [l.kind, l.amountMinor, l.dueDate, l.periodStart]),
  );
  state.lines.forEach((line, i) => {
    const mine = model.lines[i]!;
    expect(line.accrued, `line ${i} accrued`).toBe(mine.accrued);
    expect(lineBalance(line, state.allocations), `line ${i}`).toEqual(
      lineBalance(mine, model.allocations),
    );
  });
  model.payments.forEach((p, i) => {
    const db = state.payments.find((x) => x.id === run.paymentIds[i]);
    if (p.reversed) expect(db, `payment ${i} reversed`).toBeUndefined();
    else
      expect(db && paymentCredit(db, state.allocations), `payment ${i} credit`).toBe(
        paymentCredit(p, model.allocations),
      );
  });
  for (const account of ACCOUNTS) {
    const actual = await journalSum(
      ctx,
      run.agency.companyId,
      `l.lease_id = $1 and l.account_code = $2`,
      [run.leaseId, account],
    );
    expect(actual, `account ${account}`).toBe(
      model.balance(account, { leaseId: model.lease.leaseId }),
    );
  }
  expect({
    paidUntil: walk.paidUntil,
    partial: walk.partial,
    unearnedRentMinor: walk.unearnedRentMinor,
    unearnedServiceChargeMinor: walk.unearnedServiceChargeMinor,
    creditLeftMinor: walk.creditLeftMinor,
  }).toEqual({
    paidUntil: expected.paidUntil,
    partial: expected.partial,
    unearnedRentMinor: expected.unearnedRentMinor,
    unearnedServiceChargeMinor: expected.unearnedServiceChargeMinor,
    creditLeftMinor: expected.creditLeftMinor,
  });
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  base = ctx.clock.now();
  today = toIsoDate(businessDateOf(instantFrom(base), 'Africa/Accra'));
});

afterAll(async () => {
  await ctx?.close();
});

const settings = { numRuns: RUNS, endOnFailure: true };

describe('AC-01 the ledger balances', () => {
  it('agrees with the reference model step by step, and the database’s checks hold (invariants 1 to 4, 7)', async () => {
    await fc.assert(
      fc.asyncProperty(leaseArbitrary, operations(true), (lease, ops) => runOne(lease, ops, agree)),
      settings,
    );
  }, 600_000);
});

describe('BC-07 allocation never exceeds what is owed', () => {
  it('no line is allocated beyond it and no payment beyond itself, against the database (invariants 2, 3, 7)', async () => {
    await fc.assert(
      fc.asyncProperty(leaseArbitrary, operations(true), (lease, ops) =>
        runOne(lease, ops, async (run) => {
          const { state } = await dbState(run);
          for (const line of state.lines) {
            const balance = lineBalance(line, state.allocations);
            expect(balance.outstandingMinor).toBeGreaterThanOrEqual(0);
            expect(balance.settledMinor + balance.writtenOffMinor).toBeLessThanOrEqual(
              balance.netMinor,
            );
          }
          for (const p of state.payments)
            expect(paymentCredit(p, state.allocations)).toBeGreaterThanOrEqual(0);
          await agree(run);
        }),
      ),
      settings,
    );
  }, 600_000);
});

describe('BC-11 deposits never reach income', () => {
  it('income is what was charged and 2100 what deposits received, in the database (invariant 4)', async () => {
    await fc.assert(
      fc.asyncProperty(
        leaseArbitrary.filter((l) => (l.deposit ?? 0) > 0),
        operations(true),
        (lease, ops) =>
          runOne(lease, ops, async (run) => {
            const { state } = await dbState(run);
            const companyId = run.agency.companyId;
            let income = 0;
            for (const code of INCOME_ACCOUNTS)
              income += await journalSum(
                ctx,
                companyId,
                `l.lease_id = $1 and l.account_code = $2`,
                [run.leaseId, code],
              );
            const charged = state.lines
              .filter(
                (l) =>
                  (l.accrued && (l.kind === 'rent' || l.kind === 'service_charge')) ||
                  l.kind === 'one_off',
              )
              .reduce((sum, l) => sum + lineBalance(l, state.allocations).netMinor, 0);
            expect(0 - income).toBe(charged);
            const received = state.lines
              .filter((l) => l.kind === 'deposit')
              .reduce((sum, l) => sum + lineBalance(l, state.allocations).settledMinor, 0);
            expect(
              0 -
                (await journalSum(ctx, companyId, `l.lease_id = $1 and l.account_code = '2100'`, [
                  run.leaseId,
                ])),
            ).toBe(received);
            // Money leaves 2100 only by reversing the payment that paid it.
            const leaving = await withCompany(
              ctx.database,
              { companyId, actorKind: 'system' },
              (tx) =>
                tx.execute<{ rule: string }>(
                  sql`select distinct e.rule from journal_line l join journal_entry e on e.id = l.entry_id
                    where l.lease_id = ${run.leaseId} and l.account_code = '2100' and l.amount_minor > 0`,
                ),
            );
            expect(leaving.rows.every((r) => r.rule === 'P21')).toBe(true);
          }),
      ),
      settings,
    );
  }, 600_000);
});

describe('AR-01 recognition plus prepayments equal what was prepaid', () => {
  it('holds in the database for any lease with no reversal or credit note (invariant 5)', async () => {
    await fc.assert(
      fc.asyncProperty(leaseArbitrary, operations(false), (lease, ops) =>
        runOne(lease, ops, async (run) => {
          const companyId = run.agency.companyId;
          const rows = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
            tx.execute<{ rule: string; total: number }>(
              sql`select e.rule, sum(l.amount_minor)::bigint as total from journal_line l
                  join journal_entry e on e.id = l.entry_id
                  where l.lease_id = ${run.leaseId} and l.account_code = '2010' group by e.rule`,
            ),
          );
          let prepaid = 0;
          let recognised = 0;
          for (const r of rows.rows) {
            if (['P03', 'P06', 'P28'].includes(r.rule)) prepaid += -Number(r.total);
            else if (r.rule === 'P02') recognised += Number(r.total);
            else throw new Error(`2010 moved by ${r.rule}`);
          }
          const held =
            0 -
            (await journalSum(ctx, companyId, `l.lease_id = $1 and l.account_code = '2010'`, [
              run.leaseId,
            ]));
          expect(recognised + held).toBe(prepaid);
          await agree(run);
        }),
      ),
      settings,
    );
  }, 600_000);
});
