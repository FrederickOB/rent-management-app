import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import {
  ComplianceService,
  DashboardService,
  Gate1ExportService,
  Gate1Service,
} from '@rent/server/reporting';
import { Ctx, type RequestContext } from '../http/request-context';
import { serialize } from '../http/serialize';

/**
 * The portfolio dashboard, its refresh and exports, and the company's Gate 1 metrics (M9: DA-01,
 * DA-02, DA-06; decisions 9 to 13). Every check is in the services, through PolicyService; the
 * dashboard is on every plan.
 */
@Controller()
export class DashboardController {
  constructor(
    @Inject(DashboardService) private readonly dashboard: DashboardService,
    @Inject(Gate1Service) private readonly gate1: Gate1Service,
  ) {}

  @Implement(contract.dashboard)
  dashboardRouter(@Ctx() ctx: RequestContext) {
    const d = this.dashboard;
    const a = ctx.actor;
    return {
      get: implement(contract.dashboard.get).handler(async ({ input }) =>
        serialize(await d.get(a, input)),
      ),
      refresh: implement(contract.dashboard.refresh).handler(async () =>
        serialize(await d.refresh(a)),
      ),
      exportCreate: implement(contract.dashboard.exportCreate).handler(async ({ input }) =>
        serialize(await d.exportCreate(a, input)),
      ),
      exportGet: implement(contract.dashboard.exportGet).handler(async ({ input }) =>
        serialize(await d.exportGet(a, input.exportId)),
      ),
      gate1: implement(contract.dashboard.gate1).handler(async ({ input }) =>
        serialize(await this.gate1.gate1(a, input.month)),
      ),
      // M11 decision 4: the company's months with the targets.
      gate1Trend: implement(contract.dashboard.gate1Trend).handler(async ({ input }) =>
        serialize(await this.gate1.gate1Trend(a, input)),
      ),
    };
  }
}

/**
 * Gate 1 across companies, for platform admins only, through a system path (decision 13); M11
 * decision 4 adds the trend over the pilot months and its Excel export.
 */
@Controller()
export class PlatformMetricsController {
  constructor(
    @Inject(Gate1Service) private readonly gate1: Gate1Service,
    @Inject(Gate1ExportService) private readonly exports: Gate1ExportService,
  ) {}

  @Implement(contract.platformMetrics)
  platformMetricsRouter(@Ctx() ctx: RequestContext) {
    return {
      gate1: implement(contract.platformMetrics.gate1).handler(async ({ input }) =>
        serialize(await this.gate1.platformGate1(ctx.actor, input.month)),
      ),
      gate1Trend: implement(contract.platformMetrics.gate1Trend).handler(async ({ input }) =>
        serialize(await this.gate1.platformGate1Trend(ctx.actor, input)),
      ),
      gate1Export: implement(contract.platformMetrics.gate1Export).handler(async ({ input }) =>
        serialize(await this.exports.platformExport(ctx.actor, input)),
      ),
    };
  }
}

/** The compliance list (decision 14): read-only, within the reader's scope, on every plan. */
@Controller()
export class ComplianceController {
  constructor(@Inject(ComplianceService) private readonly compliance: ComplianceService) {}

  @Implement(contract.compliance)
  complianceRouter(@Ctx() ctx: RequestContext) {
    return {
      list: implement(contract.compliance.list).handler(async ({ input }) =>
        serialize(await this.compliance.list(ctx.actor, input)),
      ),
    };
  }
}
