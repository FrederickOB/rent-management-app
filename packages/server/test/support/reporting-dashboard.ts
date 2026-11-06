import { schema, sql, withCompany } from '@rent/db';
import { ComplianceService } from '../../src/reporting/compliance.service';
import { DashboardService } from '../../src/reporting/dashboard.service';
import { Gate1Service } from '../../src/reporting/gate1.service';
import { ReportingRollupService } from '../../src/reporting/rollup.service';
import type { BillingServices } from './billing';
import type { ServerTestContext } from './index';
import type { TenancyServices } from './tenancy';

/**
 * The M9 dashboard services (rollup, dashboard and exports, Gate 1, the compliance list) wired as
 * `ReportingDashboardModule` wires them, on the test database (CLAUDE.md section 12).
 */
export function reportingDashboardServices(
  ctx: ServerTestContext,
  s: TenancyServices,
  b: BillingServices,
) {
  const gate1 = new Gate1Service(ctx.database, s.policy, ctx.clock);
  const rollup = new ReportingRollupService(ctx.database, b.engine, gate1, ctx.clock);
  const dashboard = new DashboardService(ctx.database, s.policy, gate1, s.documents, ctx.clock);
  const compliance = new ComplianceService(ctx.database, s.policy, ctx.clock);
  return { gate1, rollup, dashboard, compliance };
}

export type ReportingDashboardServices = ReturnType<typeof reportingDashboardServices>;

/** A company's stored snapshot rows for a day, in the system context. */
export function snapshotOf(ctx: ServerTestContext, companyId: string, date: string) {
  return withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .select()
      .from(schema.leaseSnapshot)
      .where(sql`${schema.leaseSnapshot.snapshotDate} = ${date}::date`)
      .orderBy(schema.leaseSnapshot.leaseId),
  );
}
