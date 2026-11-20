import { sql, withCompany, type Tx } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { consentTextVersion } from '@rent/domain/messaging';
import { weeksStartingIn } from '@rent/domain/reporting';
import readXlsxFile from 'read-excel-file/node';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATE1_TREND_COLUMNS, Gate1ExportService } from '../src/reporting/gate1-export.service';
import { StaffActivityService } from '../src/reporting/staff-activity.service';
import { asSuperuser, startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { platform } from './support/messaging';
import {
  reportingDashboardServices,
  snapshotOf,
  type ReportingDashboardServices,
} from './support/reporting-dashboard';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * The Gate 1 measures M11 adds (decision 4; plan section 6, Metrics) against the real database
 * with RLS on: staff active days recorded once a day; arrears over 60 days from the day's snapshot
 * with the cut-over baseline, weekly active managers (managers only), WhatsApp adoption and time
 * to receipt delivered, per company; exact platform totals across companies, with the targets
 * and net revenue retention; the trends and the Excel export. The M9 definitions are untouched
 * (their tests are dashboard.int.test.ts and m9-review-dashboard.int.test.ts). Dates are relative
 * to the test clock's day.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let r: ReportingDashboardServices;
let activity: StaffActivityService;
let exports: Gate1ExportService;
let today: string;
let a: Awaited<ReturnType<typeof moneyCompany>>;
let l: Awaited<ReturnType<typeof moneyCompany>>;
let caretaker: Awaited<ReturnType<typeof staffIn>>;
let adviser: Awaited<ReturnType<typeof staffIn>>;
let scoped: Awaited<ReturnType<typeof staffIn>>;

const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const system = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId, actorKind: 'system' }, fn);

async function leaseIn(
  c: Awaited<ReturnType<typeof moneyCompany>>,
  part: string,
  start: string,
  rentMinor: number,
) {
  const ownerId = (await s.owners.create(c.admin, { kind: 'individual', displayName: `O ${part}` }))
    .id;
  const place = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: part,
    ownerId,
    units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
  });
  const tenantId = (
    await s.tenants.create(c.admin, { kind: 'individual', displayName: `Tenant ${part}` })
  ).tenant.id;
  const lease = await billedLease(ctx, s, b, c.manager, {
    unitId: Object.values(place.units)[0]!,
    tenantId,
    startDate: start,
    endDate: plusDays(plusMonths(start, 12), -1),
    monthlyRentMinor: rentMinor,
    cycle: 'monthly',
    depositMinor: null,
    signedOn: plusDays(start, -1),
    billingStartDate: start,
  });
  return { lease, tenantId, propertyId: place.propertyId, ownerId };
}

/** An outbound WhatsApp or receipt message to a tenant, with one event on it. */
async function messageWith(
  companyId: string,
  tenantId: string,
  input: { purpose: string; channel: string; status: 'read' | 'delivered'; at: Date },
): Promise<string> {
  const id = uuidv7();
  await system(companyId, async (tx) => {
    await tx.execute(
      sql`insert into message (id, company_id, tenant_id, recipient_type, purpose, body, channels)
          values (${id}::uuid, ${companyId}::uuid, ${tenantId}::uuid, 'tenant', ${input.purpose},
                  'Hello', ${`{${input.channel}}`}::text[])`,
    );
    await tx.execute(
      sql`insert into message_event (company_id, message_id, status, channel, occurred_at)
          values (${companyId}::uuid, ${id}::uuid, ${input.status}, ${input.channel}, ${input.at})`,
    );
  });
  return id;
}

let aLeases: {
  arrears: Awaited<ReturnType<typeof leaseIn>>;
  fresh: Awaited<ReturnType<typeof leaseIn>>;
};

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  r = reportingDashboardServices(ctx, s, b);
  activity = new StaffActivityService(ctx.database, ctx.clock);
  exports = new Gate1ExportService(
    ctx.database,
    s.policy,
    r.gate1,
    s.documents,
    ctx.audit,
    ctx.clock,
  );
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  a = await moneyCompany(ctx, s, 'agency', 'Gate Agency');
  l = await moneyCompany(ctx, s, 'landlord', 'Gate Landlord');
  caretaker = await staffIn(ctx, a.companyId, 'agency', 'caretaker', 'Gate caretaker');
  adviser = await staffIn(ctx, a.companyId, 'agency', 'adviser', 'Gate adviser');

  // Agency: a lease three months in and never paid (arrears over 60 days), and one started this
  // month. Landlord: one lease three months in, never paid.
  aLeases = {
    arrears: await leaseIn(a, 'GAA', plusMonths(today, -3), 100_000),
    fresh: await leaseIn(a, 'GAB', `${today.slice(0, 7)}-01`, 80_000),
  };
  const landlord = await leaseIn(l, 'GLA', plusMonths(today, -3), 50_000);
  scoped = await staffIn(ctx, a.companyId, 'agency', 'property_manager', 'Gate scoped', {
    properties: [aLeases.fresh.propertyId],
  });
  for (const c of [a.companyId, l.companyId]) await s.lifecycle.runTransitions(c);

  // The agency's cut-over is the 1st of this month: this month is its arrears baseline.
  await system(a.companyId, (tx) =>
    tx.execute(
      sql`insert into company_onboarding (company_id, cut_over_date, set_by)
          values (${a.companyId}::uuid, ${`${today.slice(0, 7)}-01`}::date, ${a.admin.personId}::uuid)`,
    ),
  );

  // WhatsApp: the arrears tenant consented and read a WhatsApp message this month; the other did
  // not consent. In the landlord company, the tenant read one without consent.
  await system(a.companyId, (tx) =>
    s.tenants.recordSystemConsent(tx, a.companyId, {
      tenantId: aLeases.arrears.tenantId,
      contactId: null,
      channel: 'whatsapp',
      action: 'grant',
      source: 'staff',
      textVersion: consentTextVersion('staff', 'grant'),
    }),
  );
  const now = ctx.clock.now();
  await messageWith(a.companyId, aLeases.arrears.tenantId, {
    purpose: 'broadcast',
    channel: 'whatsapp',
    status: 'read',
    at: now,
  });
  await messageWith(l.companyId, landlord.tenantId, {
    purpose: 'broadcast',
    channel: 'whatsapp',
    status: 'read',
    at: now,
  });

  // A provider payment in each company today: its receipt is delivered 45 s after confirmation in
  // the agency, and never in the landlord company.
  const paid = await b.money.recordProviderPayment(a.companyId, {
    leaseId: aLeases.fresh.lease.id,
    amountMinor: 80_000,
    receivedOn: today,
  });
  await b.money.recordProviderPayment(l.companyId, {
    leaseId: landlord.lease.id,
    amountMinor: 50_000,
    receivedOn: today,
  });
  const confirmed = new Date(now.getTime() - 120_000);
  const messageId = await messageWith(a.companyId, aLeases.fresh.tenantId, {
    purpose: 'receipt',
    channel: 'sms',
    status: 'delivered',
    at: new Date(confirmed.getTime() + 45_000),
  });
  await asSuperuser(
    ctx,
    `insert into receipt_delivery (company_id, property_id, tenant_id, lease_id, receipt_id,
       payment_id, message_id, confirmed_at, status, channel, sent_at, latency_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'sent', 'sms', $9, 20000)`,
    [
      a.companyId,
      aLeases.fresh.propertyId,
      aLeases.fresh.tenantId,
      aLeases.fresh.lease.id,
      paid.receiptId,
      paid.paymentId,
      messageId,
      confirmed,
      new Date(confirmed.getTime() + 20_000),
    ],
  );
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

describe('DA-01 Gate 1 weekly active managers: staff active days (M11 decision 4)', () => {
  it('records a staff member’s day once, on their first request, in the company’s zone', async () => {
    expect(await activity.record(a.manager)).toBe(true);
    expect(await activity.record(a.manager)).toBe(false);
    // Another API process, with nothing cached, writes nothing new either.
    expect(await new StaffActivityService(ctx.database, ctx.clock).record(a.manager)).toBe(false);
    const rows = await system(a.companyId, (tx) =>
      tx.execute<{ day: string }>(
        sql`select day::text as day from staff_active_day where person_id = ${a.manager.personId}::uuid`,
      ),
    );
    expect(rows.rows).toEqual([{ day: today }]);
    // The next day is a new one.
    ctx.clock.advance(86_400_000);
    try {
      expect(await activity.record(a.manager)).toBe(true);
    } finally {
      ctx.clock.advance(-86_400_000);
    }
  });

  it('counts a week for managers active on 3 days of it; caretakers and advisers never count', async () => {
    const month = plusMonths(today, -2).slice(0, 7);
    const [week] = weeksStartingIn(month);
    const days = (n: number) => Array.from({ length: n }, (_, i) => plusDays(week!, i));
    for (const [who, n] of [
      [a.admin, 3],
      [a.manager, 2],
      [caretaker, 5],
      [adviser, 4],
    ] as const)
      for (const day of days(n))
        await system(a.companyId, (tx) =>
          tx.execute(
            sql`insert into staff_active_day (company_id, person_id, day)
                values (${a.companyId}::uuid, ${who.personId}::uuid, ${day}::date)`,
          ),
        );
    const figures = await system(a.companyId, (tx) =>
      r.gate1.compute(tx, a.companyId, month, ctx.clock.now(), 'Africa/Accra'),
    );
    const weekly = figures.gate1.weeklyActiveManagers!;
    // Managers: the agency admin, the property managers (one scoped) and the accountant.
    expect(weekly.staff).toBe(4);
    expect(weekly.weeks[0]).toEqual({ weekStart: week, active: 1 });
    expect(weekly.weeks.slice(1).every((w) => w.active === 0)).toBe(true);
    expect(weekly.share).toMatchObject({ numerator: 1, denominator: 4 * weekly.weeks.length });
  });
});

describe('DA-01 Gate 1 the M11 measures per company, from the rollup (decision 4)', () => {
  it('works out arrears over 60 days, WhatsApp adoption and time to receipt delivered', async () => {
    for (const c of [a.companyId, l.companyId]) await r.rollup.run(c);
    const g = (await r.gate1.gate1(a.admin))!;
    const snapshot = await snapshotOf(ctx, a.companyId, today);
    const over60 = snapshot.reduce((t, x) => t + x.arrears61To90Minor + x.arrears90PlusMinor, 0);
    const roll = snapshot.reduce((t, x) => t + x.rentMinor + x.serviceChargeMinor, 0);
    expect(over60).toBeGreaterThan(0);
    expect(g.arrearsOver60).toMatchObject({
      arrearsMinor: over60,
      rentRollMinor: roll,
      share: { numerator: over60, denominator: roll },
      // The cut-over on the 1st makes this month the baseline.
      baselineMonth: today.slice(0, 7),
      baselineShare: { numerator: over60, denominator: roll },
    });
    expect(g.whatsappAdoption).toEqual({
      tenantsWithActiveLease: 2,
      adopted: 1,
      share: { numerator: 1, denominator: 2, bps: 5_000 },
    });
    expect(g.timeToReceiptDelivered).toMatchObject({
      receipts: 1,
      delivered: 1,
      withinTarget: 1,
      medianMs: 45_000,
    });
    expect(g.targets).toEqual({
      collectionRate: { targetBps: 9_500, met: expect.any(Boolean) },
      autoMatch: { targetBps: 9_500, met: true },
    });
    // The M9 figures are as they were: time to receipt is still until sent (20 s).
    expect(g.timeToReceipt).toMatchObject({ receipts: 1, sent: 1, medianMs: 20_000 });

    const lg = (await r.gate1.gate1(l.admin))!;
    expect(lg.arrearsOver60).toMatchObject({ baselineMonth: null, baselineShare: null });
    expect(lg.whatsappAdoption).toMatchObject({ tenantsWithActiveLease: 1, adopted: 0 });
    expect(lg.timeToReceiptDelivered).toMatchObject({ receipts: 1, delivered: 0, medianMs: null });
  });

  it('shows the company’s months with their targets, none to a scoped reader', async () => {
    const trend = await r.gate1.gate1Trend(a.admin);
    // From the cut-over's month to this one.
    expect(trend.months.map((m) => m.month)).toEqual([today.slice(0, 7)]);
    expect(trend.months[0]!.gate1?.targets.autoMatch.targetBps).toBe(9_500);
    const wider = await r.gate1.gate1Trend(a.admin, {
      from: plusMonths(today, -2).slice(0, 7),
      to: today.slice(0, 7),
    });
    expect(wider.months.map((m) => m.gate1 === null)).toEqual([true, true, false]);
    expect(await r.gate1.gate1Trend(scoped)).toEqual({ months: [] });
    await expect(r.gate1.gate1Trend(caretaker)).rejects.toMatchObject({ status: 403 });
    await expect(
      r.gate1.gate1Trend(a.admin, { from: '2026-10', to: '2026-09' }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_range' });
    await expect(
      r.gate1.gate1Trend(a.admin, { from: '2020-01', to: '2026-01' }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_range' });
    await expect(r.gate1.gate1Trend(a.admin, { from: '2026-13' })).rejects.toMatchObject({
      status: 400,
      code: 'bad_month',
    });
  });
});

describe('DA-01 Gate 1 exact platform totals across companies (decision 4)', () => {
  it('adds every company’s M11 figures up exactly, with the targets and net revenue retention', async () => {
    const admin = await platform(ctx);
    const all = await r.gate1.platformGate1(admin);
    const views = all.companies.flatMap((x) => (x.gate1 ? [x.gate1] : []));
    expect(views).toHaveLength(2);
    const sum = (f: (v: (typeof views)[number]) => number) => views.reduce((t, v) => t + f(v), 0);
    const total = all.total!;
    expect(total.arrearsOver60).toMatchObject({
      arrearsMinor: sum((v) => v.arrearsOver60!.arrearsMinor),
      rentRollMinor: sum((v) => v.arrearsOver60!.rentRollMinor),
      share: {
        numerator: sum((v) => v.arrearsOver60!.share.numerator),
        denominator: sum((v) => v.arrearsOver60!.share.denominator),
      },
      // Only once every company has a baseline.
      baselineMonth: null,
      baselineShare: null,
    });
    expect(total.weeklyActiveManagers).toMatchObject({
      staff: sum((v) => v.weeklyActiveManagers!.staff),
      share: {
        numerator: sum((v) => v.weeklyActiveManagers!.share.numerator),
        denominator: sum((v) => v.weeklyActiveManagers!.share.denominator),
      },
    });
    expect(total.whatsappAdoption).toEqual({
      tenantsWithActiveLease: 3,
      adopted: 1,
      share: { numerator: 1, denominator: 3, bps: 3_333 },
    });
    // From every receipt's latency, not an average of medians.
    expect(total.timeToReceiptDelivered).toMatchObject({
      receipts: 2,
      delivered: 1,
      withinTarget: 1,
      share: { numerator: 1, denominator: 2, bps: 5_000 },
      medianMs: 45_000,
    });
    expect(total.targets.autoMatch).toEqual({ targetBps: 9_500, met: true });
    expect(total.targets.collectionRate.met).toBe(
      BigInt(total.collectionRate.collectedMinor) * 10_000n >=
        9_500n * BigInt(total.collectionRate.dueMinor),
    );
    expect(total.netRevenueRetention).toEqual({
      available: false,
      monthsOfHistory: 0,
      share: null,
    });
    // Each company's view has its targets; net revenue retention is the platform's alone.
    expect(views.every((v) => v.targets && v.netRevenueRetention === undefined)).toBe(true);
  });

  it('gives the trend over the pilot months and an Excel export through a five-minute link, to platform admins only', async () => {
    const admin = await platform(ctx);
    const trend = await r.gate1.platformGate1Trend(admin);
    // The months before any company has figures are left out by default.
    expect(trend.months.map((m) => m.month)).toEqual([today.slice(0, 7)]);
    expect(trend.months[0]!.companies.filter((x) => x.gate1)).toHaveLength(2);
    await expect(r.gate1.platformGate1Trend(a.admin)).rejects.toMatchObject({ status: 403 });
    await expect(
      r.gate1.platformGate1Trend(admin, { from: '2020-01', to: '2026-01' }),
    ).rejects.toMatchObject({ status: 400 });

    const link = await exports.platformExport(admin);
    expect(link.url).toEqual(expect.any(String));
    expect(link.expiresAt.getTime() - ctx.clock.now().getTime()).toBe(300_000);
    await expect(exports.platformExport(a.admin)).rejects.toMatchObject({ status: 403 });
    const [doc] = (
      await withCompany(ctx.database, { companyId: admin.companyId, actorKind: 'system' }, (tx) =>
        tx.execute<{ id: string; write_once: boolean }>(
          sql`select id, write_once from document where kind = 'gate1_export'`,
        ),
      )
    ).rows;
    expect(doc?.write_once).toBe(true);
    const file = await s.documents.documentFile(admin.companyId, doc!.id);
    const [sheet] = (await readXlsxFile(file!.bytes)) as unknown as {
      sheet: string;
      data: unknown[][];
    }[];
    const header = sheet!.data.findIndex((row) => row[0] === GATE1_TREND_COLUMNS[0]);
    expect(sheet!.data[header]).toEqual([...GATE1_TREND_COLUMNS]);
    const body = sheet!.data.slice(header + 1);
    expect(body.map((row) => row[1])).toEqual(['All companies', 'Gate Agency', 'Gate Landlord']);
    const totalRow = body[0]!;
    expect(totalRow[0]).toBe(today.slice(0, 7));
    expect(totalRow[5]).toBe(trend.months[0]!.total!.collectionRate.dueMinor);
    expect(totalRow[GATE1_TREND_COLUMNS.indexOf('WhatsApp adoption')]).toBe('33.33%');
    expect(totalRow[GATE1_TREND_COLUMNS.indexOf('Net revenue retention')]).toBe(
      'Needs 12 months of subscription invoices; 0 so far',
    );
    const audited = await withCompany(
      ctx.database,
      { companyId: admin.companyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from audit_event where action = 'metrics.gate1_exported'`,
        ),
    );
    expect(audited.rows[0]!.n).toBe(1);
  });
});
