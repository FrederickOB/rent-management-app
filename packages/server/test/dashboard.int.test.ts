import { schema, sql, withCompany, type Tx } from '@rent/db';
import { AGE_BUCKETS } from '@rent/domain/billing';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import readXlsxFile from 'read-excel-file/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dashboardRows,
  DASHBOARD_TEMPLATE,
  DASHBOARD_XLSX_COLUMNS,
} from '../src/reporting/dashboard.service';
import { METRICS_REFRESH_EVENT } from '../src/reporting/rollup.service';
import { asSuperuser, startServerTest, type ServerTestContext } from './support';
import {
  approvedCash,
  approvedTransfer,
  billedLease,
  billingServices,
  journalSum,
  moneyCard,
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
  SAMPLE_PDF,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * The M9 dashboard against the real database with RLS on (plan 4.5, decisions 9 to 12 and 15):
 * the rollup's snapshot reconciles to the ledger and its sub-ledgers (DA-01 ★), an owner and their
 * adviser see only their own figures (★), the DA-06 filters and the DA-02 expiries, the exports
 * carry the screen's figures, a refresh is queued rather than run, the rollup is idempotent per
 * day, and the Gate 1 metrics on fixed fixtures. Every date is relative to the test clock's day, or
 * a fixed instant inside a month two months back, so the file passes on any date.
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

let tenantCount = 0;
async function tenantIn(actor: Parameters<TenancyServices['tenants']['create']>[0]) {
  tenantCount += 1;
  return (
    await s.tenants.create(actor, { kind: 'individual', displayName: `Tenant ${tenantCount}` })
  ).tenant.id;
}

/** A paper lease billed from its start, as the worker would bill it on signing. */
async function lease(
  actor: Parameters<TenancyServices['leases']['recordPaper']>[0],
  unitId: string,
  input: { start: string; months?: number; rentMinor: number; depositMinor?: number },
) {
  return billedLease(ctx, s, b, actor, {
    unitId,
    tenantId: await tenantIn(actor),
    startDate: input.start,
    endDate: endAfter(input.start, input.months ?? 12),
    monthlyRentMinor: input.rentMinor,
    cycle: 'monthly',
    depositMinor: input.depositMinor ?? null,
    signedOn: plusDays(input.start, -1),
    billingStartDate: input.start,
  });
}

/**
 * The reconciliation agency: owner A (three flats in Greater Accra, one office in Ashanti) and
 * owner B (two single rooms). A1 is a month behind; A2 paid a deposit and seven months; A3 ends
 * within the month, never paid, and has a renewal offered; B1 is two months behind.
 */
let recon: Awaited<ReturnType<typeof reconAgency>>;
async function reconAgency() {
  const c = await moneyCompany(ctx, s, 'agency', 'Recon Agency');
  const ownerA = (await s.owners.create(c.admin, { kind: 'individual', displayName: 'Owner A' }))
    .id;
  const ownerB = (await s.owners.create(c.admin, { kind: 'individual', displayName: 'Owner B' }))
    .id;
  const propA = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: 'RCA',
    ownerId: ownerA,
    units: [{ unitType: 'apartment', count: 3, bedrooms: 2 }],
  });
  const propB = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: 'RCB',
    ownerId: ownerB,
    units: [{ unitType: 'single_room', count: 2 }],
  });
  const propC = await s.register.createProperty(c.manager, {
    areaCode: 'KSI',
    propertyPart: 'RCC',
    name: 'Kumasi office',
    propertyType: 'shop',
    use: 'commercial',
    ownerId: ownerA,
    address: { region: 'Ashanti', town: 'Kumasi' },
    units: [{ unitType: 'office', count: 1 }],
  });
  const [a1, a2, a3] = Object.values(propA.units) as [string, string, string];
  const [b1] = Object.values(propB.units) as [string];
  const A1 = await lease(c.manager, a1, { start: plusMonths(today, -3), rentMinor: 100_000 });
  const A2 = await lease(c.manager, a2, {
    start: plusMonths(today, -1),
    rentMinor: 150_000,
    depositMinor: 300_000,
  });
  const A3 = await lease(c.manager, a3, { start: plusMonths(today, -11), rentMinor: 50_000 });
  const B1 = await lease(c.manager, b1, { start: plusMonths(today, -2), rentMinor: 80_000 });
  await b.money.recordProviderPayment(c.companyId, {
    leaseId: A1.id,
    amountMinor: 200_000,
    receivedOn: today,
  });
  await b.money.recordProviderPayment(c.companyId, {
    leaseId: A2.id,
    amountMinor: 300_000 + 7 * 150_000,
    receivedOn: today,
  });
  await s.leases.offerRenewal(c.manager, A3.id);
  return {
    ...c,
    ownerA,
    ownerB,
    propA: propA.propertyId,
    propB: propB.propertyId,
    propC,
    leases: { A1: A1.id, A2: A2.id, A3: A3.id, B1: B1.id },
  };
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  taxServices(ctx, s, b);
  r = reportingDashboardServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  recon = await reconAgency();
  await r.rollup.run(recon.companyId);
});

afterAll(async () => {
  await ctx?.close();
});

describe('DA-01 the dashboard reconciles to the ledger', () => {
  it('★ shows arrears, deposits held and unearned rent equal to their sub-ledger totals', async () => {
    const view = await r.dashboard.get(recon.admin);
    // The sub-ledgers themselves agree with the journal (invariants 2 to 4, 7).
    expect((await b.subledger.check(recon.companyId, { alert: false })).mismatches).toEqual([]);

    // Arrears (BC-08): the arrears report by bucket, and 1100 on the lines past their due date.
    const arrears = await system(recon.companyId, (tx) =>
      b.read.arrearsIn(tx, recon.companyId, { by: 'owner', asOf: today }),
    );
    expect(view.arrears.byBucket).toEqual(arrears.totals);
    expect(view.arrears.totalMinor).toBe(arrears.totalMinor);
    const overdue1100 = await journalSum(
      ctx,
      recon.companyId,
      `l.account_code = '1100' and l.invoice_line_id in (select id from invoice_line where due_date < $1::date)`,
      [today],
    );
    expect(view.arrears.totalMinor).toBe(overdue1100);
    // A1 one month behind, A3 eleven months, B1 two.
    expect(view.arrears.totalMinor).toBe(100_000 + 11 * 50_000 + 2 * 80_000);
    expect(view.arrears.leases).toBe(3);

    // Deposits held (BC-11): 2100 in the journal, and each lease's money card.
    const cards = await Promise.all(
      Object.values(recon.leases).map((id) => moneyCard(ctx, b, recon.companyId, id)),
    );
    expect(view.depositsHeldMinor).toBe(
      -(await journalSum(ctx, recon.companyId, `l.account_code = '2100'`)),
    );
    expect(view.depositsHeldMinor).toBe(cards.reduce((sum, c) => sum + c.depositHeldMinor, 0));
    expect(view.depositsHeldMinor).toBe(300_000);

    // Unearned rent (AR-03): the rent share of 2010, here all of it (no service charge, no
    // credit beyond a lease's end), and the money cards' figure.
    expect(view.unearnedRentMinor).toBe(cards.reduce((sum, c) => sum + c.unearnedRentMinor, 0));
    expect(view.unearnedRentMinor).toBe(
      -(await journalSum(ctx, recon.companyId, `l.account_code = '2010'`)),
    );
    expect(view.unearnedRentMinor).toBeGreaterThan(0);

    // Paid-until per lease is the money card's.
    const snapshot = await snapshotOf(ctx, recon.companyId, view.date);
    for (const [i, id] of Object.values(recon.leases).entries())
      expect(snapshot.find((row) => row.leaseId === id)?.paidUntil).toBe(cards[i]!.paidUntil);

    // Rent roll (decision 12): the monthly rent of the four leases holding their units.
    expect(view.rentRoll).toEqual({
      rentMinor: 100_000 + 150_000 + 50_000 + 80_000,
      serviceChargeMinor: 0,
      totalMinor: 380_000,
    });
    // Occupancy is counted live from the register: 4 of 6 lettable units occupied, plus the
    // Ashanti office vacant.
    expect(view.occupancy).toMatchObject({ units: 6, lettable: 6, occupied: 4, vacant: 2 });
    expect(view.asOf).toEqual(ctx.clock.now());
    expect(view.date).toBe(today);
  });

  it('DA-02 counts the leases ending within 3, 6 and 12 months, with their renewal status', async () => {
    const view = await r.dashboard.get(recon.manager);
    expect(view.expiries).toEqual([
      { withinMonths: 3, leases: 1, renewalOffered: 1, renewed: 0 },
      { withinMonths: 6, leases: 1, renewalOffered: 1, renewed: 0 },
      { withinMonths: 12, leases: 4, renewalOffered: 1, renewed: 0 },
    ]);
    // Paid-until coverage (prd-issues 32): only A2 is paid until today or later.
    expect(view.paidUntilCoverage).toMatchObject({ occupied: 4, covered: 1 });
    expect(view.paidUntilCoverage.rate.bps).toBe(2_500);
  });

  it('DA-06 filters by owner, property, region and unit type, and offers the values in view', async () => {
    const byOwner = await r.dashboard.get(recon.admin, { ownerId: recon.ownerB });
    expect(byOwner.arrears.totalMinor).toBe(160_000);
    expect(byOwner.occupancy).toMatchObject({ units: 2, occupied: 1 });
    const byProperty = await r.dashboard.get(recon.admin, { propertyId: recon.propA });
    expect(byProperty.arrears.totalMinor).toBe(100_000 + 550_000);
    expect(byProperty.depositsHeldMinor).toBe(300_000);
    const byRegion = await r.dashboard.get(recon.admin, { region: 'Ashanti' });
    expect(byRegion.occupancy).toMatchObject({ units: 1, occupied: 0, vacant: 1 });
    expect(byRegion.arrears.totalMinor).toBe(0);
    const byType = await r.dashboard.get(recon.admin, { unitType: 'single_room' });
    expect(byType.arrears.totalMinor).toBe(160_000);
    expect(byType.rentRoll.rentMinor).toBe(80_000);
    const all = await r.dashboard.get(recon.admin);
    expect(all.filterOptions.owners.map((o) => o.name)).toEqual(['Owner A', 'Owner B']);
    expect(all.filterOptions.properties).toHaveLength(3);
    expect(all.filterOptions.regions).toEqual(['Ashanti', 'Greater Accra']);
    expect(all.filterOptions.unitTypes).toEqual(['apartment', 'office', 'single_room']);
  });
});

describe('DA-01 owner isolation (decision 15)', () => {
  it('★ an owner’s user and their adviser see only that owner’s figures, never another owner’s', async () => {
    const ownerUser = await staffIn(ctx, recon.companyId, 'agency', 'owner', 'Owner A user', {
      owners: [recon.ownerA],
    });
    const adviser = await staffIn(ctx, recon.companyId, 'agency', 'adviser', 'A’s adviser', {
      owners: [recon.ownerA],
    });
    const cards = await Promise.all(
      [recon.leases.A1, recon.leases.A2, recon.leases.A3].map((id) =>
        moneyCard(ctx, b, recon.companyId, id),
      ),
    );
    for (const reader of [ownerUser, adviser]) {
      const view = await r.dashboard.get(reader);
      // The positive case: exactly owner A's leases.
      expect(view.arrears.totalMinor).toBe(100_000 + 550_000);
      expect(view.depositsHeldMinor).toBe(300_000);
      expect(view.unearnedRentMinor).toBe(cards.reduce((sum, c) => sum + c.unearnedRentMinor, 0));
      expect(view.rentRoll.rentMinor).toBe(300_000);
      expect(view.occupancy).toMatchObject({ units: 4, occupied: 3 });
      expect(view.filterOptions.owners.map((o) => o.id)).toEqual([recon.ownerA]);
      expect(view.filterOptions.properties.map((p) => p.id)).not.toContain(recon.propB);
      // Company-wide Gate 1 figures would show other owners' rent: none for a scoped reader.
      expect(view.gate1).toBeNull();
      expect(await r.gate1.gate1(reader)).toBeNull();
      // Asking for owner B's figures by filter gives nothing of theirs.
      const asked = await r.dashboard.get(reader, { ownerId: recon.ownerB });
      expect(asked.arrears.totalMinor).toBe(0);
      expect(asked.occupancy.units).toBe(0);
      expect(asked.collectionRate.dueMinor).toBe(0);
      const prop = await r.dashboard.get(reader, { propertyId: recon.propB });
      expect(prop.arrears.totalMinor).toBe(0);
      expect(prop.depositsHeldMinor + prop.unearnedRentMinor + prop.rentRoll.totalMinor).toBe(0);
      // The export carries the same scoped figures.
      const exported = await r.dashboard.exportCreate(reader, { format: 'pdf' });
      const [request] = await system(recon.companyId, (tx) =>
        tx.execute<{ data: { rows: { figure: string; amountMinor: number | null }[] } }>(
          sql`select d.data from document_render_request d
              join dashboard_export e on e.company_id = d.company_id and e.render_request_id = d.id
              where e.id = ${exported.id}`,
        ),
      ).then((x) => x.rows);
      expect(request!.data.rows.find((x) => x.figure === 'Total arrears')?.amountMinor).toBe(
        650_000,
      );
    }
  });

  it('limits a manager scoped to one property to it, and refuses a caretaker', async () => {
    const managerB = await staffIn(ctx, recon.companyId, 'agency', 'property_manager', 'Mgr B', {
      properties: [recon.propB],
    });
    const view = await r.dashboard.get(managerB);
    expect(view.arrears.totalMinor).toBe(160_000);
    expect(view.depositsHeldMinor).toBe(0);
    expect(view.occupancy.units).toBe(2);
    const caretaker = await staffIn(ctx, recon.companyId, 'agency', 'caretaker', 'Caretaker A', {
      properties: [recon.propA],
    });
    await expect(r.dashboard.get(caretaker)).rejects.toMatchObject({ status: 403 });
    await expect(r.dashboard.exportCreate(caretaker, { format: 'xlsx' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(r.dashboard.refresh(caretaker)).rejects.toMatchObject({ status: 403 });
    await expect(r.gate1.gate1(caretaker)).rejects.toMatchObject({ status: 403 });
  });

  it('keeps another company’s snapshot out of view (RLS)', async () => {
    const other = await moneyCompany(ctx, s, 'landlord', 'Other Landlord');
    const view = await r.dashboard.get(other.admin);
    expect(view.asOf).toBeNull();
    expect(view.arrears.totalMinor).toBe(0);
    expect(view.filterOptions.properties).toEqual([]);
    const rows = await withCompany(
      ctx.database,
      { companyId: other.companyId, actorKind: 'system' },
      (tx) => tx.select().from(schema.leaseSnapshot),
    );
    expect(rows).toEqual([]);
  });
});

describe('DA-06 exports carry the screen’s figures', () => {
  it('writes the Excel export at once, with every row of the screen exact in pesewas', async () => {
    const filters = { ownerId: recon.ownerA };
    const view = await r.dashboard.get(recon.admin, filters);
    const exported = await r.dashboard.exportCreate(recon.admin, { ...filters, format: 'xlsx' });
    expect(exported).toMatchObject({ format: 'xlsx', status: 'ready', url: expect.any(String) });
    expect(exported.expiresAt!.getTime() - ctx.clock.now().getTime()).toBe(300_000);
    const [row] = await system(recon.companyId, (tx) =>
      tx.execute<{ document_id: string }>(
        sql`select document_id from dashboard_export where id = ${exported.id}`,
      ),
    ).then((x) => x.rows);
    const file = await s.documents.documentFile(recon.companyId, row!.document_id);
    expect(file?.intact).toBe(true);
    const [sheet] = (await readXlsxFile(file!.bytes)) as unknown as {
      sheet: string;
      data: unknown[][];
    }[];
    const header = sheet!.data.findIndex((cells) => cells[0] === DASHBOARD_XLSX_COLUMNS[0]);
    expect(sheet!.data[header]).toEqual([...DASHBOARD_XLSX_COLUMNS]);
    const body = sheet!.data.slice(header + 1);
    const expected = dashboardRows(view);
    expect(body).toHaveLength(expected.length);
    expected.forEach((e, i) => {
      const cells = body[i]!;
      expect([cells[0], cells[1]]).toEqual([e.section, e.figure]);
      expect(cells[2] ?? null).toBe(e.count);
      expect(cells[4] ?? null).toBe(e.amountMinor);
      expect(cells[6] ?? null).toBe(e.bps);
    });
    expect(body.find((c) => c[1] === 'Deposits held')?.[3]).toBe('3000.00');
    // The filter is named in the file.
    expect(sheet!.data.some((cells) => cells[0] === 'Owner' && cells[1] === 'Owner A')).toBe(true);
  });

  it('renders the PDF from the screen’s rows, then serves it to the person who asked only', async () => {
    const view = await r.dashboard.get(recon.manager, { propertyId: recon.propB });
    const exported = await r.dashboard.exportCreate(recon.manager, {
      propertyId: recon.propB,
      format: 'pdf',
    });
    expect(exported).toMatchObject({ status: 'rendering', url: null, expiresAt: null });
    const [request] = await system(recon.companyId, (tx) =>
      tx.execute<{
        id: string;
        template_key: string;
        template_version: number;
        data: { rows: unknown[]; filters: unknown[]; date: string };
      }>(
        sql`select d.id, d.template_key, d.template_version, d.data from document_render_request d
            join dashboard_export e on e.company_id = d.company_id and e.render_request_id = d.id
            where e.id = ${exported.id}`,
      ),
    ).then((x) => x.rows);
    expect([request!.template_key, request!.template_version]).toEqual([
      DASHBOARD_TEMPLATE.key,
      DASHBOARD_TEMPLATE.version,
    ]);
    expect(request!.data.rows).toEqual(dashboardRows(view));
    expect(request!.data.filters).toEqual([{ label: 'Property', value: 'ACC-RCB property' }]);
    expect(request!.data.date).toBe(view.date);
    // Still rendering, then rendered and recorded (documents.rendered).
    expect(await r.dashboard.exportGet(recon.manager, exported.id)).toMatchObject({
      status: 'rendering',
    });
    await s.documents.renderRequested(recon.companyId, request!.id, async () => SAMPLE_PDF);
    expect(await r.dashboard.onDocumentRendered(recon.companyId, request!.id)).toBe(true);
    expect(await r.dashboard.onDocumentRendered(recon.companyId, request!.id)).toBe(false);
    expect(await r.dashboard.exportGet(recon.manager, exported.id)).toMatchObject({
      status: 'ready',
      url: expect.any(String),
    });
    // It carries the manager's figures: nobody else may fetch it.
    await expect(r.dashboard.exportGet(recon.admin, exported.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('DA-01 refresh and the daily rollup (decision 11)', () => {
  it('queues a refresh through the outbox and never runs it inline; clicks in a minute queue one', async () => {
    const before = await snapshotOf(ctx, recon.companyId, today);
    expect(await r.dashboard.refresh(recon.manager)).toEqual({ queued: true });
    expect(await r.dashboard.refresh(recon.admin)).toEqual({ queued: true });
    const events = await outboxOf(ctx, recon.companyId, METRICS_REFRESH_EVENT);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ requestedBy: recon.manager.personId });
    const after = await snapshotOf(ctx, recon.companyId, today);
    expect(after).toEqual(before);
  });

  it('is idempotent per company and day: a second run replaces the day’s rows with the same', async () => {
    const strip = (rows: Awaited<ReturnType<typeof snapshotOf>>) =>
      rows.map(({ computedAt: _computedAt, ...rest }) => rest);
    const first = strip(await snapshotOf(ctx, recon.companyId, today));
    ctx.clock.advance(1);
    try {
      const run = await r.rollup.run(recon.companyId);
      expect(run).toMatchObject({ snapshotDate: today, leases: first.length });
      const second = await snapshotOf(ctx, recon.companyId, today);
      expect(strip(second)).toEqual(first);
      expect(second.every((x) => x.computedAt.getTime() === ctx.clock.now().getTime())).toBe(true);
      const days = await system(recon.companyId, (tx) => tx.select().from(schema.metricDaily));
      expect(days).toHaveLength(1);
      expect(days[0]!.computedAt).toEqual(ctx.clock.now());
    } finally {
      ctx.clock.advance(-1);
    }
  });
});

/**
 * Gate 1 on fixed fixtures (decisions 9 and 10): a month two months back, with payments recorded
 * through the services and dated in it, and receipts' deliveries, notices and emergency jobs
 * written below the application at fixed instants inside it, so every count is known.
 */
describe('Gate 1 metrics', () => {
  const month = () => plusMonths(today, -2).slice(0, 7);
  const at = (day: number, hour: number) =>
    new Date(`${month()}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`);

  it('never shows a collection rate above 100%, even when rent arrives in advance', async () => {
    const c = await moneyCompany(ctx, s, 'landlord', 'Advance Landlord');
    const ownerId = (await s.owners.create(c.admin, { kind: 'individual', displayName: 'Lord' }))
      .id;
    const place = await propertyWithUnits(s, c.manager, {
      areaCode: 'ACC',
      propertyPart: 'G1A',
      ownerId,
      units: [{ unitType: 'apartment', count: 2, bedrooms: 1 }],
    });
    const [u1, u2] = Object.values(place.units) as [string, string];
    const start = `${today.slice(0, 7)}-01`;
    const paidAhead = await lease(c.manager, u1, { start, rentMinor: 100_000 });
    await lease(c.manager, u2, { start, rentMinor: 100_000 });
    await b.money.recordProviderPayment(c.companyId, {
      leaseId: paidAhead.id,
      amountMinor: 12 * 100_000,
      receivedOn: today,
    });
    await r.rollup.run(c.companyId);
    const g = (await r.gate1.gate1(c.admin))!;
    expect(g.collectionRate).toEqual({
      dueMinor: 200_000,
      collectedMinor: 100_000,
      rate: { numerator: 100_000, denominator: 200_000, bps: 5_000 },
    });
    const view = await r.dashboard.get(c.admin);
    expect(view.collectionRate.rate.bps).toBe(5_000);
    expect(view.gate1?.collectionRate).toEqual(g.collectionRate);
    // Paid twelve months ahead, the lease's own month counts once: 100%, never 1,200%.
    const own = await r.dashboard.get(c.admin, { propertyId: place.propertyId });
    expect(own.collectionRate.collectedMinor).toBeLessThanOrEqual(own.collectionRate.dueMinor);
  });

  it('works out every metric of a fixed month through the service', async () => {
    const c = await moneyCompany(ctx, s, 'agency', 'Gate One Agency');
    const ownerId = (await s.owners.create(c.admin, { kind: 'individual', displayName: 'Gate O' }))
      .id;
    const place = await propertyWithUnits(s, c.manager, {
      areaCode: 'ACC',
      propertyPart: 'G1B',
      ownerId,
      units: [{ unitType: 'apartment', count: 2, bedrooms: 1 }],
    });
    const [u1, u2] = Object.values(place.units) as [string, string];
    const start = plusMonths(`${month()}-01`, -1);
    const l1 = await lease(c.manager, u1, { start, rentMinor: 100_000 });
    const l2 = await lease(c.manager, u2, { start, rentMinor: 100_000 });
    // L1: three months by the provider on the 5th (digital, matched with no person).
    await b.money.recordProviderPayment(c.companyId, {
      leaseId: l1.id,
      amountMinor: 300_000,
      receivedOn: `${month()}-05`,
    });
    // L2: cash on the 6th and a transfer on the 7th, both to last month's rent; and a transfer
    // nobody could match, into the agency's account.
    await approvedCash(ctx, s, b, c.manager, c.accountant, {
      leaseId: l2.id,
      amountMinor: 50_000,
      receivedOn: `${month()}-06`,
    });
    await approvedTransfer(ctx, s, b, c.manager, c.accountant, {
      leaseId: l2.id,
      receivedInto: 'agency_account',
      amountMinor: 50_000,
      receivedOn: `${month()}-07`,
    });
    await approvedTransfer(ctx, s, b, c.manager, c.accountant, {
      receivedInto: 'agency_account',
      amountMinor: 20_000,
      receivedOn: `${month()}-08`,
    });

    // Receipts: issued in the month; two delivered (30 s and 90 s), one never sent.
    const receipts = await system(c.companyId, (tx) =>
      tx.execute<{ id: string; payment_id: string; lease_id: string; tenant_id: string }>(
        sql`select id, payment_id, lease_id, tenant_id from receipt where kind = 'receipt'
            order by issued_at, id`,
      ),
    ).then((x) => x.rows);
    expect(receipts).toHaveLength(3);
    for (const [i, receipt] of receipts.entries()) {
      const issued = at(10 + i, 9);
      await asSuperuser(ctx, `update receipt set issued_at = $1 where id = $2`, [
        issued,
        receipt.id,
      ]);
      const latency = [30_000, 90_000, null][i];
      if (latency !== null)
        await asSuperuser(
          ctx,
          `insert into receipt_delivery (company_id, property_id, tenant_id, lease_id, receipt_id,
             payment_id, message_id, confirmed_at, status, channel, sent_at, latency_ms)
           values ($1, $2, $3, $4, $5, $6, gen_random_uuid(), $7, 'sent', 'sms', $8, $9)`,
          [
            c.companyId,
            place.propertyId,
            receipt.tenant_id,
            receipt.lease_id,
            receipt.id,
            receipt.payment_id,
            issued,
            new Date(issued.getTime() + latency!),
            latency,
          ],
        );
    }

    // Notices: one signed within 7 days, one never, a building-wide notice to both tenants (one
    // signed within, one after 7 days), and a tenant's own notice, which never counts.
    const tenants = await system(c.companyId, (tx) =>
      tx.execute<{ id: string; tenant_id: string }>(
        sql`select id, tenant_id from lease where id in (${l1.id}, ${l2.id}) order by start_date, id`,
      ),
    ).then((x) => x.rows);
    let number = 0;
    const notice = async (
      type: string,
      issuedAt: Date,
      recipients: { leaseId: string; tenantId: string; signedAt: Date | null }[],
    ) => {
      number += 1;
      const target = type === 'building_wide' ? null : recipients[0]!;
      const [row] = await asSuperuser(
        ctx,
        `insert into notice (company_id, number, type, status, property_id, lease_id, tenant_id,
           template_key, template_version, issue_date, issued_at)
         values ($1, $2, $3, 'sent', $4, $5, $6, 'notices.notice', 1, $7::date, $8) returning id`,
        [
          c.companyId,
          number,
          type,
          place.propertyId,
          target?.leaseId ?? null,
          target?.tenantId ?? null,
          issuedAt.toISOString().slice(0, 10),
          issuedAt,
        ],
      );
      for (const [i, rec] of recipients.entries()) {
        const [recipient] = await asSuperuser(
          ctx,
          `insert into notice_recipient (company_id, property_id, notice_id, tenant_id, lease_id, kind,
             name, channels, physical_service_planned, position)
           values ($1, $2, $3, $4, $5, 'tenant', 'Tenant', '[]'::jsonb, false, $6) returning id`,
          [c.companyId, place.propertyId, row!.id, rec.tenantId, rec.leaseId, i + 1],
        );
        if (rec.signedAt)
          await asSuperuser(
            ctx,
            `insert into notice_event (company_id, property_id, notice_id, recipient_id, tenant_id, kind, occurred_at)
             values ($1, $2, $3, $4, $5, 'signed', $6)`,
            [c.companyId, place.propertyId, row!.id, recipient!.id, rec.tenantId, rec.signedAt],
          );
      }
    };
    const [t1, t2] = tenants.map((x) => ({ leaseId: x.id, tenantId: x.tenant_id })) as [
      { leaseId: string; tenantId: string },
      { leaseId: string; tenantId: string },
    ];
    await notice('rent_demand', at(10, 8), [{ ...t1, signedAt: at(12, 8) }]);
    await notice('entry', at(11, 8), [{ ...t2, signedAt: null }]);
    await notice('building_wide', at(12, 8), [
      { ...t1, signedAt: at(13, 8) },
      { ...t2, signedAt: at(20, 8) },
    ]);
    await notice('tenant_originated', at(13, 8), [{ ...t2, signedAt: null }]);

    // Emergency jobs (attended means work started): started in 1 hour against a 2-hour target;
    // started in 3 hours; assigned within the hour but never started; one raised to emergency
    // later; and a routine job and a cancelled emergency, which never count.
    let ticket = 900;
    const job = async (input: {
      priority: 'emergency' | 'routine';
      status: string;
      reported: Date;
      events: { kind: string; at: Date; data?: Record<string, unknown> }[];
    }) => {
      ticket += 1;
      const [row] = await asSuperuser(
        ctx,
        `insert into maintenance_job (company_id, ticket_number, property_id, unit_id, status, source,
           description, priority, category, created_at, respond_by)
         values ($1, $2, $3, $4, $5, 'staff', 'Burst pipe', $6, 'plumbing', $7, $8) returning id`,
        [
          c.companyId,
          ticket,
          place.propertyId,
          u1,
          input.status,
          input.priority,
          input.reported,
          new Date(input.reported.getTime() + 2 * 3_600_000),
        ],
      );
      for (const e of input.events)
        await asSuperuser(
          ctx,
          `insert into maintenance_job_event (company_id, property_id, job_id, kind, actor_kind, at, data)
           values ($1, $2, $3, $4, 'system', $5, $6::jsonb)`,
          [c.companyId, place.propertyId, row!.id, e.kind, e.at, JSON.stringify(e.data ?? null)],
        );
    };
    await job({
      priority: 'emergency',
      status: 'in_progress',
      reported: at(5, 10),
      events: [{ kind: 'started', at: at(5, 11) }],
    });
    await job({
      priority: 'emergency',
      status: 'in_progress',
      reported: at(6, 10),
      events: [{ kind: 'started', at: at(6, 13) }],
    });
    await job({
      priority: 'emergency',
      status: 'triaged',
      reported: at(7, 10),
      events: [{ kind: 'assigned', at: at(7, 10) }],
    });
    await job({ priority: 'routine', status: 'triaged', reported: at(8, 10), events: [] });
    // Reported as routine on the 8th, raised to emergency on the 9th at 10:00 and started at 11:00:
    // the clock starts when it became an emergency, so it was attended in time.
    await job({
      priority: 'emergency',
      status: 'in_progress',
      reported: at(8, 12),
      events: [
        { kind: 'priority_changed', at: at(9, 10), data: { from: 'routine', to: 'emergency' } },
        { kind: 'started', at: at(9, 11) },
      ],
    });
    await job({ priority: 'emergency', status: 'cancelled', reported: at(9, 10), events: [] });

    const computed = await system(c.companyId, (tx) =>
      r.gate1.compute(tx, c.companyId, month(), ctx.clock.now(), 'Africa/Accra'),
    );
    const g = computed.gate1;
    // Decision 9: due the two lines of the month; L1's settled (in advance counts), L2's not.
    expect(g.collectionRate).toEqual({
      dueMinor: 200_000,
      collectedMinor: 100_000,
      rate: { numerator: 100_000, denominator: 200_000, bps: 5_000 },
    });
    // Digital: 300,000 by the provider and 70,000 by transfer, against 50,000 cash.
    expect(g.digitalShare.byMethod).toMatchObject({
      test: 300_000,
      bank_transfer: 70_000,
      cash: 50_000,
    });
    expect(g.digitalShare.share).toEqual({ numerator: 370_000, denominator: 420_000, bps: 8_810 });
    expect(g.autoMatch.provider).toEqual({
      automatic: 1,
      byPerson: 0,
      unmatched: 0,
      rate: { numerator: 1, denominator: 1, bps: 10_000 },
    });
    expect(g.autoMatch.directTransfers).toEqual({
      againstLease: 1,
      unmatched: 1,
      rate: { numerator: 1, denominator: 2, bps: 5_000 },
    });
    expect(g.timeToReceipt).toEqual({
      receipts: 3,
      sent: 2,
      withinTarget: 1,
      share: { numerator: 1, denominator: 3, bps: 3_333 },
      medianMs: 30_000,
      p95Ms: 90_000,
    });
    expect(g.noticeAcknowledgement).toEqual({
      met: 2,
      missed: 2,
      pending: 0,
      rate: { numerator: 2, denominator: 4, bps: 5_000 },
    });
    expect(g.repairResponse).toEqual({
      met: 2,
      missed: 2,
      pending: 0,
      rate: { numerator: 2, denominator: 4, bps: 5_000 },
    });
    expect(computed.inputs.receiptLatenciesMs).toEqual([30_000, 90_000, null]);

    // As of the 11th at 09:00, every notice window is still open: pending, never missed.
    const early = await system(c.companyId, (tx) =>
      r.gate1.compute(tx, c.companyId, month(), at(11, 9), 'Africa/Accra'),
    );
    expect(early.gate1.noticeAcknowledgement).toMatchObject({ met: 0, missed: 0, pending: 4 });
    expect(early.gate1.noticeAcknowledgement.rate.bps).toBeNull();
  });

  it('shows Gate 1 across companies to platform admins only, added up exactly', async () => {
    const admin = await platform(ctx);
    const thisMonth = today.slice(0, 7);
    const all = await r.gate1.platformGate1(admin);
    expect(all.month).toBe(thisMonth);
    const mine = all.companies.find((x) => x.company.id === recon.companyId);
    expect(mine?.gate1).not.toBeNull();
    const stored = all.companies.flatMap((x) => (x.gate1 ? [x.gate1] : []));
    expect(all.total?.collectionRate.dueMinor).toBe(
      stored.reduce((sum, x) => sum + x.collectionRate.dueMinor, 0),
    );
    expect(all.total?.timeToReceipt.receipts).toBe(
      stored.reduce((sum, x) => sum + x.timeToReceipt.receipts, 0),
    );
    // Staff of any company are refused, whatever their role.
    await expect(r.gate1.platformGate1(recon.admin)).rejects.toMatchObject({ status: 403 });
    await expect(r.gate1.platformGate1(null)).rejects.toMatchObject({ status: 403 });
    // The database refuses the system function to anyone but a platform admin's session.
    await expect(
      withCompany(ctx.database, { companyId: recon.companyId, actorKind: 'staff' }, (tx) =>
        tx.execute(sql`select * from app.platform_gate1(${thisMonth})`),
      ),
    ).rejects.toThrow();
  });

  it('stores the month’s figures with the rollup, with every bucket of arrears in the snapshot', async () => {
    const g = await r.gate1.gate1(recon.admin, today.slice(0, 7));
    expect(g?.month).toBe(today.slice(0, 7));
    expect(g?.computedAt).toBeInstanceOf(Date);
    await expect(r.gate1.gate1(recon.admin, '2026-13')).rejects.toMatchObject({ status: 400 });
    const view = await r.dashboard.get(recon.admin);
    expect(Object.keys(view.arrears.byBucket)).toEqual([...AGE_BUCKETS]);
    expect(view.arrears.byBucket['90_plus']).toBeGreaterThan(0);
  });
});
