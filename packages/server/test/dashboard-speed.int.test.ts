import { businessDateOf, instantFrom, toIsoDate } from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPerfFixture, type PerfFixtureResult } from '../scripts/perf-fixture';
import { startServerTest, type ServerTestContext } from './support';
import { billingServices, moneyCompany, type BillingServices } from './support/billing';
import { maintenanceServices, type MaintenanceServices } from './support/maintenance';
import {
  reportingDashboardServices,
  type ReportingDashboardServices,
} from './support/reporting-dashboard';
import { taxServices } from './support/tax';
import { staffIn, tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * The dashboard's speed at 5,000 units (M9 plan section 6; roadmap risk; decision 11): the
 * dashboard answers within 1.5 s from the snapshot, and the rollup that builds the snapshot
 * finishes within 10 minutes. Advisory: it runs only with RENT_SPEED=1 (RENT_SPEED_UNITS sets the
 * size), on this test's own cloned database, with the fixture of scripts/perf-fixture.ts.
 */
const enabled = process.env.RENT_SPEED === '1';
const UNITS = Number(process.env.RENT_SPEED_UNITS ?? 5_000);
const DASHBOARD_MS = 1_500;
const ROLLUP_MS = 10 * 60_000;
const HOUR = 3_600_000;

let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let m: MaintenanceServices;
let r: ReportingDashboardServices;
let company: Awaited<ReturnType<typeof moneyCompany>>;
let fixture: PerfFixtureResult;

const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: Math.ceil(performance.now() - t0) };
};

describe.skipIf(!enabled)('DA-01 dashboard speed at 5,000 units (advisory)', () => {
  beforeAll(async () => {
    ctx = await startServerTest();
    s = tenancyServices(ctx);
    b = billingServices(ctx, s);
    const t = taxServices(ctx, s, b);
    m = maintenanceServices(ctx, s, b, t);
    r = reportingDashboardServices(ctx, s, b);
    company = await moneyCompany(ctx, s, 'agency', 'Speed Agency');
    let last = 0;
    fixture = await buildPerfFixture(
      {
        owners: s.owners,
        register: s.register,
        read: s.read,
        tenants: s.tenants,
        leases: s.leases,
        invoicing: b.invoicing,
        money: b.money,
        expenses: m.expenses,
        storage: ctx.storage,
        config: ctx.config,
      },
      {
        companyId: company.companyId,
        admin: company.admin,
        manager: company.manager,
        today: toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra')),
        units: UNITS,
        onProgress: (done, total) => {
          if (done - last >= 500 || done === total) {
            last = done;
            console.info(`perf fixture: ${done}/${total} leases`);
          }
        },
      },
    );
    console.info(
      `perf fixture: ${fixture.leases} leases, ${fixture.payments} payments, ${fixture.expenses} expenses in ${fixture.ms} ms`,
    );
  }, 3 * HOUR);

  afterAll(async () => {
    await ctx?.close();
  });

  it(
    `finishes the rollup within 10 minutes and answers the dashboard within 1.5 s`,
    async () => {
      const rollup = await timed(() => r.rollup.run(company.companyId));
      console.info(`rollup: ${rollup.value.leases} leases in ${rollup.ms} ms`);
      expect(rollup.value.leases).toBe(fixture.leases);
      expect(rollup.ms).toBeLessThan(ROLLUP_MS);

      // The first read warms the connection and the plan cache; the next ones are what people see.
      await r.dashboard.get(company.admin);
      const reads: number[] = [];
      for (let i = 0; i < 5; i += 1)
        reads.push((await timed(() => r.dashboard.get(company.admin))).ms);
      const owner = await staffIn(ctx, company.companyId, 'agency', 'owner', 'Perf owner user', {
        owners: [fixture.owners[0]!],
      });
      const scoped = await timed(() => r.dashboard.get(owner));
      const filtered = await timed(() =>
        r.dashboard.get(company.admin, { propertyId: fixture.properties[0]! }),
      );
      const sorted = [...reads].sort((x, y) => x - y);
      console.info(
        `dashboard: ${reads.join(', ')} ms (median ${sorted[2]}); owner's ${scoped.ms} ms; one property ${filtered.ms} ms`,
      );
      const view = (await timed(() => r.dashboard.get(company.admin))).value;
      expect(view.occupancy.units).toBe(fixture.leases);
      expect(sorted[2]).toBeLessThan(DASHBOARD_MS);
      expect(scoped.ms).toBeLessThan(DASHBOARD_MS);
      expect(filtered.ms).toBeLessThan(DASHBOARD_MS);
      const xlsx = await timed(() => r.dashboard.exportCreate(company.admin, { format: 'xlsx' }));
      console.info(`Excel export: ${xlsx.ms} ms`);
    },
    HOUR,
  );
});
