import { schema, withCompany } from '@rent/db';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoiceStatusOf, lineBalance, remainingAfterWalk } from '@rent/domain/billing';
import { isoNow } from '../src/billing/records';
import { startServerTest, type ServerTestContext } from './support';
import {
  approvedCash,
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { propertyWithUnits, tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * NFR-PERF (M11 load smoke): the invoice list loaded each lease's billing state on its own, about
 * ten queries a lease, so a page of 100 invoices took seconds. BillingEngine.loadMany reads every
 * lease at once; this proves each state is exactly the one load() gives, and that the list's
 * figures are unchanged.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let today: string;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
const leaseIds: string[] = [];

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  today = isoNow(ctx.clock, 'Africa/Accra');
  agency = await moneyCompany(ctx, s, 'agency', 'Invoice List Agency');
  const owner = (
    await s.owners.create(agency.admin, { kind: 'individual', displayName: 'List Owner' })
  ).id;
  const property = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: 'INV',
    ownerId: owner,
    units: [{ unitType: 'apartment', count: 6, bedrooms: 2 }],
  });
  const units = Object.values(property.units);
  const cycles = ['monthly', 'quarterly', 'monthly', 'annual', 'monthly', 'six_monthly'] as const;
  for (const [index, unitId] of units.entries()) {
    const { tenant } = await s.tenants.create(agency.manager, {
      kind: 'individual',
      displayName: `List Tenant ${index}`,
    });
    const start = plusMonths(today, -2);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId,
      tenantId: tenant.id,
      startDate: start,
      endDate: plusDays(plusMonths(start, 12), -1),
      monthlyRentMinor: 100_000 + index * 10_000,
      cycle: cycles[index]!,
      depositMinor: index % 2 === 0 ? 200_000 : null,
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    leaseIds.push(lease.id);
  }
  // A partial payment, a full one and an overpayment held as credit (BC-07).
  for (const [i, amount] of [
    [0, 50_000],
    [2, 320_000],
    [4, 900_000],
  ] as const)
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: leaseIds[i]!,
      amountMinor: amount,
      receivedOn: today,
    });
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

describe('NFR-PERF BC-08 the invoice list reads every lease at once (M11 load smoke)', () => {
  it('gives each lease exactly the billing state load() gives', async () => {
    await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      async (tx) => {
        const many = await b.engine.loadMany(tx, agency.companyId, [...leaseIds, leaseIds[0]!]);
        expect([...many.keys()].sort()).toEqual([...leaseIds].sort());
        for (const leaseId of leaseIds)
          expect(many.get(leaseId), leaseId).toEqual(
            await b.engine.load(tx, agency.companyId, leaseId),
          );
      },
    );
  });

  it('lists every invoice with the figures the old per-lease path gives (an independent oracle)', async () => {
    const list = await b.read.invoices(agency.manager, { limit: 100 });
    // The oracle: each lease loaded on its own with load(), then the domain's own functions over
    // that lease's lines and allocations, as the list did before M11.
    const expected = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      async (tx) => {
        const rows = await tx.select().from(schema.invoice);
        const out = new Map<
          string,
          {
            totalMinor: number;
            settledMinor: number;
            outstandingMinor: number;
            status: string;
            overdue: boolean;
          }
        >();
        for (const leaseId of leaseIds) {
          const state = await b.engine.load(tx, agency.companyId, leaseId);
          const walk = b.engine.walk(state);
          for (const r of rows.filter((x) => x.leaseId === leaseId)) {
            const mine = state.lines.filter((l) => l.invoiceId === r.id);
            const balances = mine.map((l) => lineBalance(l, state.allocations));
            const outstanding = mine.reduce(
              (sum, l) => sum + remainingAfterWalk(l, state.allocations, walk),
              0,
            );
            out.set(r.id, {
              totalMinor: mine.reduce((sum, l) => sum + l.amountMinor, 0),
              settledMinor: balances.reduce((sum, x) => sum + x.settledMinor, 0),
              outstandingMinor: outstanding,
              status: invoiceStatusOf(balances),
              overdue: r.dueDate < today && outstanding > 0,
            });
          }
        }
        return out;
      },
    );
    expect(list.length).toBe(expected.size);
    expect(list.length).toBeGreaterThan(leaseIds.length);
    for (const row of list)
      expect(
        {
          totalMinor: row.totalMinor,
          settledMinor: row.settledMinor,
          outstandingMinor: row.outstandingMinor,
          status: row.status,
          overdue: row.overdue,
        },
        row.number,
      ).toEqual(expected.get(row.id));
    // Exact figures the payments make: the partial payment of 50,000 is settled in full against
    // its lease's debts (they exceed it); the overpaid lease owes nothing and nothing is overdue.
    const settledOn = (leaseId: string) =>
      list.filter((r) => r.leaseId === leaseId).reduce((sum, r) => sum + r.settledMinor, 0);
    expect(settledOn(leaseIds[0]!)).toBe(50_000);
    const overpaid = list.filter((r) => r.leaseId === leaseIds[4]);
    expect(overpaid.length).toBeGreaterThan(0);
    expect(overpaid.every((r) => r.outstandingMinor === 0 && !r.overdue)).toBe(true);
  });
});
