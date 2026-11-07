import { schema, sql, withCompany, type Tx } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { reportMonth } from '@rent/domain/reporting';
import { InMemoryAlert } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DASHBOARD_TEMPLATE } from '../src/reporting/dashboard.service';
import { prepaymentSplitAt } from '../src/reporting/prepayment-split';
import {
  METRICS_REFRESH_EVENT,
  PREPAYMENT_SPLIT_ALERT,
  ReportingRollupService,
} from '../src/reporting/rollup.service';
import { asSuperuser, startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  journalSum,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { outboxOf } from './support/maintenance';
import { platform } from './support/messaging';
import {
  reportingDashboardServices,
  snapshotOf,
  type ReportingDashboardServices,
} from './support/reporting-dashboard';
import { taxServices } from './support/tax';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * The M9 review's dashboard and Gate 1 findings against the real database with RLS on:
 * - the dashboard splits 2010 as the statement does (the invoice basis, founder 2026-11-07), and
 *   the three parts add up to the ledger's 2010 for every lease;
 * - arrears are 1100 past due, with an annual invoice's months not started kept apart;
 * - the collection rate counts rent in the month it covers (F2);
 * - Gate 1 finalises past months, freezes them, and settles open windows;
 * - refresh is for those who manage leases, the live figures say when they were read, the expiry
 *   pipeline counts holding over, compliance items carry stable ids, and a negative credit alerts.
 * Dates are relative to the test clock's day, so the file passes on any date.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let r: ReportingDashboardServices;
let today: string;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const endAfter = (from: string, months: number) => plusDays(plusMonths(from, months), -1);
const system = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId, actorKind: 'system' }, fn);
const prepaid = async (companyId: string, leaseId: string) =>
  0 -
  (await journalSum(ctx, companyId, `l.account_code = '2010' and l.lease_id = $1::uuid`, [
    leaseId,
  ]));

let tenantCount = 0;
async function lease(
  actor: Parameters<TenancyServices['leases']['recordPaper']>[0],
  unitId: string,
  input: {
    start: string;
    months?: number;
    rentMinor: number;
    cycle?: 'monthly' | 'annual';
    depositMinor?: number;
    serviceChargeMinor?: number;
  },
) {
  tenantCount += 1;
  const tenantId = (
    await s.tenants.create(actor, {
      kind: 'individual',
      displayName: `Review Tenant ${tenantCount}`,
    })
  ).tenant.id;
  return billedLease(ctx, s, b, actor, {
    unitId,
    tenantId,
    startDate: input.start,
    endDate: endAfter(input.start, input.months ?? 12),
    monthlyRentMinor: input.rentMinor,
    serviceChargeMonthlyMinor: input.serviceChargeMinor ?? null,
    cycle: input.cycle ?? 'monthly',
    depositMinor: input.depositMinor ?? null,
    signedOn: plusDays(input.start, -1),
    billingStartDate: input.start,
  });
}

/** How many of a lease's lines of a kind have a charge period started by today. */
async function startedLines(companyId: string, leaseId: string, kind: string) {
  const [row] = await system(companyId, (tx) =>
    tx.execute<{ n: number }>(
      sql`select count(*)::int as n from invoice_line
          where lease_id = ${leaseId} and kind = ${kind} and period_start <= ${today}::date`,
    ),
  ).then((x) => x.rows);
  return Number(row!.n);
}

/**
 * The split agency: one owner, four flats.
 * - M: monthly, started a month ago, paid a deposit and seven months today (as DA-01's A2).
 * - A: an annual invoice with service charge, started two months ago, paid in full plus 50,000.
 * - U: an annual invoice started two months ago, never paid.
 * - H: a monthly lease that ended a month ago and is holding over.
 */
let split: Awaited<ReturnType<typeof splitAgency>>;
async function splitAgency() {
  const c = await moneyCompany(ctx, s, 'agency', 'Split Agency');
  const ownerId = (await s.owners.create(c.admin, { kind: 'individual', displayName: 'Split O' }))
    .id;
  const place = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: 'SPL',
    ownerId,
    units: [{ unitType: 'apartment', count: 4, bedrooms: 2 }],
  });
  const [u1, u2, u3, u4] = Object.values(place.units) as [string, string, string, string];
  const M = await lease(c.manager, u1, {
    start: plusMonths(today, -1),
    rentMinor: 150_000,
    depositMinor: 300_000,
  });
  const A = await lease(c.manager, u2, {
    start: plusMonths(today, -2),
    rentMinor: 100_000,
    serviceChargeMinor: 20_000,
    cycle: 'annual',
  });
  const U = await lease(c.manager, u3, {
    start: plusMonths(today, -2),
    rentMinor: 80_000,
    cycle: 'annual',
  });
  const H = await lease(c.manager, u4, { start: plusMonths(today, -13), rentMinor: 50_000 });
  await s.lifecycle.runTransitions(c.companyId, today);
  await b.money.recordProviderPayment(c.companyId, {
    leaseId: M.id,
    amountMinor: 300_000 + 7 * 150_000,
    receivedOn: today,
  });
  await b.money.recordProviderPayment(c.companyId, {
    leaseId: A.id,
    amountMinor: 12 * (100_000 + 20_000) + 50_000,
    receivedOn: today,
  });
  await r.rollup.run(c.companyId);
  return {
    ...c,
    ownerId,
    propertyId: place.propertyId,
    leases: { M: M.id, A: A.id, U: U.id, H: H.id },
  };
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  taxServices(ctx, s, b);
  r = reportingDashboardServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  split = await splitAgency();
});

afterAll(async () => {
  await ctx?.close();
});

describe('DA-01 AR-03 the dashboard splits 2010 by invoices, as the statement does', () => {
  it('shows A2’s seven months paid ahead as credit: none of it is allocated to a month not started', async () => {
    const rows = await snapshotOf(ctx, split.companyId, today);
    const m = rows.find((x) => x.leaseId === split.leases.M)!;
    // A deposit and two started months settled; five months' rent waits as surplus.
    expect(m).toMatchObject({
      unearnedRentMinor: 0,
      unearnedServiceChargeMinor: 0,
      creditMinor: 750_000,
    });
    expect(await prepaid(split.companyId, split.leases.M)).toBe(750_000);
  });

  it('counts money allocated to an annual invoice’s months not started as unearned rent and service charge, exactly', async () => {
    const rows = await snapshotOf(ctx, split.companyId, today);
    const a = rows.find((x) => x.leaseId === split.leases.A)!;
    const started = await startedLines(split.companyId, split.leases.A, 'rent');
    expect(await startedLines(split.companyId, split.leases.A, 'service_charge')).toBe(started);
    expect(started).toBeGreaterThanOrEqual(2);
    expect(a).toMatchObject({
      unearnedRentMinor: (12 - started) * 100_000,
      unearnedServiceChargeMinor: (12 - started) * 20_000,
      creditMinor: 50_000,
    });
    // The same as the allocations on its rent lines not started, read straight from the table.
    const [allocated] = await system(split.companyId, (tx) =>
      tx.execute<{ rent: number; service: number }>(
        sql`select coalesce(sum(a.amount_minor) filter (where l.kind = 'rent'), 0)::bigint as rent,
              coalesce(sum(a.amount_minor) filter (where l.kind = 'service_charge'), 0)::bigint as service
            from allocation a join invoice_line l on l.company_id = a.company_id and l.id = a.invoice_line_id
            where a.lease_id = ${split.leases.A} and l.period_start > ${today}::date`,
      ),
    ).then((x) => x.rows);
    expect(Number(allocated!.rent)).toBe(a.unearnedRentMinor);
    expect(Number(allocated!.service)).toBe(a.unearnedServiceChargeMinor);
  });

  it('adds up to each lease’s 2010 exactly, and the dashboard to the ledger and the statement’s reader', async () => {
    const rows = await snapshotOf(ctx, split.companyId, today);
    for (const row of rows)
      expect(
        row.unearnedRentMinor + row.unearnedServiceChargeMinor + row.creditMinor,
        row.leaseId,
      ).toBe(await prepaid(split.companyId, row.leaseId));
    const view = await r.dashboard.get(split.admin);
    const whole = -(await journalSum(ctx, split.companyId, `l.account_code = '2010'`));
    expect(view.unearnedRentMinor + view.unearnedServiceChargeMinor + view.creditMinor).toBe(whole);
    // The owner statement reads the same function, by accounting date, for its month's last day.
    const statementSplit = await system(split.companyId, (tx) =>
      prepaymentSplitAt(tx, { leaseIds: Object.values(split.leases), asOf: today }),
    );
    const sum = (f: 'unearnedRentMinor' | 'unearnedServiceChargeMinor' | 'creditMinor') =>
      [...statementSplit.values()].reduce((t, x) => t + x[f], 0);
    expect({
      unearnedRentMinor: view.unearnedRentMinor,
      unearnedServiceChargeMinor: view.unearnedServiceChargeMinor,
      creditMinor: view.creditMinor,
    }).toEqual({
      unearnedRentMinor: sum('unearnedRentMinor'),
      unearnedServiceChargeMinor: sum('unearnedServiceChargeMinor'),
      creditMinor: sum('creditMinor'),
    });
    expect(view.creditMinor).toBe(750_000 + 50_000);
  });
});

describe('DA-01 BC-08 arrears as the statement counts them', () => {
  it('counts 1100 past its due date, and keeps an annual invoice’s months not started apart', async () => {
    const rows = await snapshotOf(ctx, split.companyId, today);
    const u = rows.find((x) => x.leaseId === split.leases.U)!;
    const started = await startedLines(split.companyId, split.leases.U, 'rent');
    const owed =
      u.arrears0To30Minor + u.arrears31To60Minor + u.arrears61To90Minor + u.arrears90PlusMinor;
    expect(owed).toBe(started * 80_000);
    expect(owed).toBe(
      await journalSum(ctx, split.companyId, `l.account_code = '1100' and l.lease_id = $1::uuid`, [
        split.leases.U,
      ]),
    );
    expect(u.dueNotStartedMinor).toBe((12 - started) * 80_000);
    // The whole dashboard: 1100 on lines past due is the arrears, to the pesewa.
    const view = await r.dashboard.get(split.admin);
    expect(view.arrears.totalMinor).toBe(
      await journalSum(
        ctx,
        split.companyId,
        `l.account_code = '1100' and l.invoice_line_id in (select id from invoice_line where due_date < $1::date)`,
        [today],
      ),
    );
    expect(view.arrears.dueNotStartedMinor).toBe((12 - started) * 80_000);
    expect(view.arrears.totalMinor).toBeGreaterThan(owed);
  });
});

describe('DA-02 the expiry pipeline counts leases holding over', () => {
  it('puts a lease past its end that still holds its unit in every window', async () => {
    const [h] = await system(split.companyId, (tx) =>
      tx.execute<{ status: string }>(sql`select status from lease where id = ${split.leases.H}`),
    ).then((x) => x.rows);
    expect(h!.status).toBe('holding_over');
    const view = await r.dashboard.get(split.manager);
    expect(view.expiries.map((e) => [e.withinMonths, e.leases])).toEqual([
      [3, 1],
      [6, 1],
      [12, 4],
    ]);
  });
});

describe('DA-01 F2 the collection rate counts rent in the month it covers', () => {
  it('counts one month of an annual invoice this month on the dashboard and in Gate 1, not twelve in the month it fell due', async () => {
    const c = await moneyCompany(ctx, s, 'landlord', 'F2 Landlord');
    const ownerId = (await s.owners.create(c.admin, { kind: 'individual', displayName: 'F2 O' }))
      .id;
    const place = await propertyWithUnits(s, c.manager, {
      areaCode: 'ACC',
      propertyPart: 'FTW',
      ownerId,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const start = plusMonths(today, -2);
    const annual = await lease(c.manager, Object.values(place.units)[0]!, {
      start,
      rentMinor: 100_000,
      cycle: 'annual',
    });
    await b.money.recordProviderPayment(c.companyId, {
      leaseId: annual.id,
      amountMinor: 12 * 100_000,
      receivedOn: today,
    });
    await r.rollup.run(c.companyId);
    const one = { dueMinor: 100_000, collectedMinor: 100_000 };
    const view = await r.dashboard.get(c.admin);
    expect(view.collectionRate).toMatchObject({ month: today.slice(0, 7), ...one });
    expect(view.collectionRate.rate.bps).toBe(10_000);
    expect((await r.gate1.gate1(c.admin))!.collectionRate).toMatchObject(one);
    // The month it fell due counts only the month it covers, unpaid by that month's end.
    const dueMonth = start.slice(0, 7);
    const then = await system(c.companyId, (tx) =>
      r.gate1.compute(tx, c.companyId, dueMonth, ctx.clock.now(), 'Africa/Accra'),
    );
    expect(then.gate1.collectionRate).toMatchObject({ dueMinor: 100_000, collectedMinor: 0 });
    expect(then.inputs.collectionLines).toBe(1);
  });

  it('counts only what was recorded by Gate 1’s asOf', async () => {
    const month = today.slice(0, 7);
    const now = await system(split.companyId, (tx) =>
      r.gate1.compute(tx, split.companyId, month, ctx.clock.now(), 'Africa/Accra'),
    );
    expect(now.gate1.collectionRate.collectedMinor).toBeGreaterThan(0);
    // An hour before anything in this file was recorded: no line, no allocation yet.
    const before = await system(split.companyId, (tx) =>
      r.gate1.compute(
        tx,
        split.companyId,
        month,
        new Date(ctx.clock.now().getTime() - 3_600_000),
        'Africa/Accra',
      ),
    );
    expect(before.gate1.collectionRate).toMatchObject({ dueMinor: 0, collectedMinor: 0 });
    expect(before.inputs.collectionLines).toBe(0);
  });
});

describe('DA-01 refresh is for those who manage leases, once a minute per company', () => {
  it('refuses an accountant and an adviser (403), and queues one rollup per minute', async () => {
    const adviser = await staffIn(ctx, split.companyId, 'agency', 'adviser', 'Split adviser', {
      owners: [split.ownerId],
    });
    for (const reader of [split.accountant, adviser]) {
      await expect(r.dashboard.get(reader)).resolves.toBeDefined();
      await expect(r.dashboard.refresh(reader)).rejects.toMatchObject({ status: 403 });
    }
    const saved = ctx.clock.now();
    try {
      // A minute of its own, whatever else this file queued.
      ctx.clock.set(new Date(Math.ceil(saved.getTime() / 60_000) * 60_000 + 3 * 60_000));
      const before = (await outboxOf(ctx, split.companyId, METRICS_REFRESH_EVENT)).length;
      await r.dashboard.refresh(split.manager);
      await r.dashboard.refresh(split.admin);
      expect(await outboxOf(ctx, split.companyId, METRICS_REFRESH_EVENT)).toHaveLength(before + 1);
      ctx.clock.advance(60_000);
      await r.dashboard.refresh(split.manager);
      expect(await outboxOf(ctx, split.companyId, METRICS_REFRESH_EVENT)).toHaveLength(before + 2);
    } finally {
      ctx.clock.set(saved);
    }
    // A landlord manages their own leases: allowed.
    const landlord = await moneyCompany(ctx, s, 'landlord', 'Refresh Landlord');
    await expect(r.dashboard.refresh(landlord.admin)).resolves.toEqual({ queued: true });
  });
});

describe('DA-06 the live figures say when they were read, apart from the snapshot', () => {
  it('reads liveAt now while asOf stays the snapshot’s, and the export carries both', async () => {
    const saved = ctx.clock.now();
    try {
      const view = await r.dashboard.get(split.admin);
      expect(view.liveAt).toEqual(ctx.clock.now());
      ctx.clock.advance(3_600_000);
      const later = await r.dashboard.get(split.admin);
      expect(later.liveAt).toEqual(ctx.clock.now());
      expect(later.asOf).toEqual(view.asOf);
      const exported = await r.dashboard.exportCreate(split.admin, { format: 'pdf' });
      const [request] = await system(split.companyId, (tx) =>
        tx.execute<{ template_version: number; data: { liveAt: string; asOf: string } }>(
          sql`select d.template_version, d.data from document_render_request d
              join dashboard_export e on e.company_id = d.company_id and e.render_request_id = d.id
              where e.id = ${exported.id}`,
        ),
      ).then((x) => x.rows);
      expect(request!.template_version).toBe(DASHBOARD_TEMPLATE.version);
      expect(DASHBOARD_TEMPLATE.version).toBe(2);
      expect(request!.data.liveAt).toBe(ctx.clock.now().toISOString());
      expect(request!.data.asOf).toBe(view.asOf!.toISOString());
    } finally {
      ctx.clock.set(saved);
    }
  });
});

describe('TX-02 TX-05 the compliance list gives each item a stable id, unique within it', () => {
  it('keys each item by its kind and the record it is about, the same on every read', async () => {
    const items = await r.compliance.list(split.accountant);
    expect(items.length).toBeGreaterThan(1);
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of items) expect(item.id.startsWith(`${item.kind}:`)).toBe(true);
    for (const item of items.filter((i) => i.kind === 'rent_control_registration'))
      expect(item.id).toBe(`rent_control_registration:${item.lease!.id}`);
    expect((await r.compliance.list(split.accountant)).map((i) => i.id)).toEqual(ids);
  });
});

describe('DA-01 a negative credit is raised, never clamped', () => {
  it('alerts when more is allocated to months not started than 2010 holds, and shows it as it is', async () => {
    const c = await moneyCompany(ctx, s, 'agency', 'Broken Books Agency');
    const ownerId = (
      await s.owners.create(c.admin, { kind: 'individual', displayName: 'Broken O' })
    ).id;
    const place = await propertyWithUnits(s, c.manager, {
      areaCode: 'ACC',
      propertyPart: 'BRK',
      ownerId,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const annual = await lease(c.manager, Object.values(place.units)[0]!, {
      start: plusMonths(today, -1),
      rentMinor: 80_000,
      cycle: 'annual',
    });
    // A broken entry written below the application, balanced within 2010: 10,000 credited to a
    // month not started and the same debited to money applied to no month. 2010 still holds
    // nothing, yet 10,000 sits on a month not started, so credit comes out at -10,000.
    const [line] = await system(c.companyId, (tx) =>
      tx
        .select()
        .from(schema.invoiceLine)
        .where(sql`lease_id = ${annual.id} and kind = 'rent' and period_start > ${today}::date`)
        .orderBy(schema.invoiceLine.periodStart)
        .limit(1),
    );
    await asSuperuser(
      ctx,
      // eslint-disable-next-line rent/ledger-writes -- a broken fixture entry, to prove the alert fires
      `with e as (
         insert into journal_entry (id, company_id, rule, idempotency_key, value_date, accounting_date,
           record_type, record_id)
         select gen_random_uuid(), l.company_id, 'P01', 'test:broken:' || l.id, $2::date, $2::date,
           'payment', gen_random_uuid()
         from invoice_line l where l.id = $1
         returning id, company_id)
       insert into journal_line (id, company_id, entry_id, line_no, book_id, account_code, amount_minor,
         property_id, unit_id, lease_id, tenant_id, invoice_line_id)
       select gen_random_uuid(), e.company_id, e.id, x.n, i.book_id, '2010', x.amount, l.property_id,
         i.unit_id, l.lease_id, i.tenant_id, case when x.n = 1 then l.id end
       from e, invoice_line l join invoice i on i.company_id = l.company_id and i.id = l.invoice_id,
         (values (1, -10000), (2, 10000)) as x(n, amount)
       where l.id = $1`,
      [line!.id, today],
    );
    const alerts = new InMemoryAlert();
    const rollup = new ReportingRollupService(ctx.database, b.engine, r.gate1, ctx.clock, alerts);
    const run = await rollup.run(c.companyId);
    expect(run.negativeCredit).toEqual([annual.id]);
    const [raised] = alerts.byCode(PREPAYMENT_SPLIT_ALERT);
    expect(raised).toMatchObject({
      severity: 'critical',
      context: { companyId: c.companyId, leases: 1 },
    });
    const [row] = await snapshotOf(ctx, c.companyId, today);
    expect(row).toMatchObject({ unearnedRentMinor: 10_000, creditMinor: -10_000 });
    // A sound company raises nothing.
    const quiet = new InMemoryAlert();
    const sound = new ReportingRollupService(ctx.database, b.engine, r.gate1, ctx.clock, quiet);
    expect((await sound.run(split.companyId)).negativeCredit).toEqual([]);
    expect(quiet.byCode(PREPAYMENT_SPLIT_ALERT)).toEqual([]);
  });
});

// Last: it moves the clock into next month and leaves next month's snapshots behind.
describe('DA-01 Gate 1 finalises past months (M9 review)', () => {
  it('finalises last month on the 1st, once; later money leaves it as it was; open windows settle', async () => {
    const c = await moneyCompany(ctx, s, 'agency', 'Final Agency');
    const ownerId = (await s.owners.create(c.admin, { kind: 'individual', displayName: 'Final O' }))
      .id;
    const place = await propertyWithUnits(s, c.manager, {
      areaCode: 'ACC',
      propertyPart: 'FIN',
      ownerId,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const monthly = await lease(c.manager, Object.values(place.units)[0]!, {
      start: plusMonths(today, -1),
      rentMinor: 100_000,
    });
    const m0 = reportMonth(today.slice(0, 7));
    const first = await r.rollup.run(c.companyId);
    expect(first.finalised).toEqual([]);
    expect(await r.gate1.gate1(c.admin, m0.month)).toMatchObject({
      status: 'provisional',
      finalisedAt: null,
    });
    // A notice issued on the month's last evening, never signed: its window runs into next month.
    const [l] = await system(c.companyId, (tx) =>
      tx.execute<{ tenant_id: string }>(sql`select tenant_id from lease where id = ${monthly.id}`),
    ).then((x) => x.rows);
    const [notice] = await asSuperuser(
      ctx,
      `insert into notice (company_id, number, type, status, property_id, lease_id, tenant_id,
         template_key, template_version, issue_date, issued_at)
       values ($1, 1, 'rent_demand', 'sent', $2, $3, $4, 'notices.notice', 1, $5::date, $6) returning id`,
      [
        c.companyId,
        place.propertyId,
        monthly.id,
        l!.tenant_id,
        m0.lastDay,
        `${m0.lastDay}T20:00:00Z`,
      ],
    );
    await asSuperuser(
      ctx,
      `insert into notice_recipient (company_id, property_id, notice_id, tenant_id, lease_id, kind,
         name, channels, physical_service_planned, position)
       values ($1, $2, $3, $4, $5, 'tenant', 'Tenant', '[]'::jsonb, false, 1)`,
      [c.companyId, place.propertyId, notice!.id, l!.tenant_id, monthly.id],
    );

    const saved = ctx.clock.now();
    const next = plusDays(m0.lastDay, 1);
    try {
      // The 1st at 04:00 (Accra is on UTC): the month is worked out once more, and marked final.
      ctx.clock.set(new Date(`${next}T04:00:00Z`));
      const onThe1st = await r.rollup.run(c.companyId);
      expect(onThe1st.finalised).toEqual([m0.month]);
      const final = (await r.gate1.gate1(c.admin, m0.month))!;
      expect(final).toMatchObject({ status: 'final', finalisedAt: ctx.clock.now() });
      expect(final.noticeAcknowledgement).toMatchObject({ met: 0, missed: 0, pending: 1 });
      expect((await r.gate1.gate1(c.admin, next.slice(0, 7)))!.status).toBe('provisional');

      // Money for last month recorded after it is final (enough for the month's line as well as
      // the one before it) does not change its figures.
      await b.money.recordProviderPayment(c.companyId, {
        leaseId: monthly.id,
        amountMinor: 200_000,
        receivedOn: m0.lastDay,
      });
      ctx.clock.advance(60_000);
      const again = await r.rollup.run(c.companyId);
      expect(again.finalised).toEqual([]);
      const still = (await r.gate1.gate1(c.admin, m0.month))!;
      expect(still.finalisedAt).toEqual(final.finalisedAt);
      expect(still.collectionRate).toEqual(final.collectionRate);

      // Once the notice's 7 days are over, it is missed, not pending; the month stays final.
      ctx.clock.set(new Date(`${plusDays(next, 8)}T04:00:00Z`));
      const settled = await r.rollup.run(c.companyId);
      expect(settled.settled).toEqual([m0.month]);
      const closed = (await r.gate1.gate1(c.admin, m0.month))!;
      expect(closed).toMatchObject({ status: 'final', finalisedAt: final.finalisedAt });
      expect(closed.noticeAcknowledgement).toMatchObject({ met: 0, missed: 1, pending: 0 });
      expect(closed.collectionRate).toEqual(final.collectionRate);
      expect(closed.computedAt).toEqual(ctx.clock.now());
      ctx.clock.advance(86_400_000);
      expect((await r.rollup.run(c.companyId)).settled).toEqual([]);

      // Across companies: final only once every company's month is, as old as its oldest part.
      const admin = await platform(ctx);
      const partial = await r.gate1.platformGate1(admin, m0.month);
      const views = partial.companies.flatMap((x) => (x.gate1 ? [x.gate1] : []));
      expect(views.length).toBeGreaterThan(1);
      expect(partial.companies.find((x) => x.company.id === c.companyId)?.gate1?.status).toBe(
        'final',
      );
      expect(partial.total).toMatchObject({ status: 'provisional', finalisedAt: null });
      expect(partial.total!.computedAt).toEqual(
        new Date(Math.min(...views.map((v) => v.computedAt.getTime()))),
      );
      for (const x of partial.companies.filter((y) => y.gate1 && y.company.id !== c.companyId))
        await r.rollup.run(x.company.id);
      const whole = await r.gate1.platformGate1(admin, m0.month);
      expect(whole.total).toMatchObject({ status: 'final', finalisedAt: expect.any(Date) });
      const finals = whole.companies.flatMap((x) => (x.gate1 ? [x.gate1] : []));
      expect(finals.every((v) => v.status === 'final')).toBe(true);
      expect(whole.total!.computedAt).toEqual(
        new Date(Math.min(...finals.map((v) => v.computedAt.getTime()))),
      );
    } finally {
      ctx.clock.set(saved);
    }
  });
});
