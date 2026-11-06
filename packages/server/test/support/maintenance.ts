import { schema, sql, withCompany } from '@rent/db';
import { EntitlementsService } from '../../src/companies/entitlements.service';
import { ArtisansService } from '../../src/maintenance/artisans.service';
import { ExpensesService } from '../../src/maintenance/expenses.service';
import { InspectionsService } from '../../src/maintenance/inspections.service';
import { JobSheetService } from '../../src/maintenance/job-sheet.service';
import { MaintenanceService } from '../../src/maintenance/maintenance.service';
import { TenantRepairsService } from '../../src/maintenance/tenant-repairs.service';
import { MoveInReportService } from '../../src/moveout/move-in-report.service';
import { MoveOutService } from '../../src/moveout/moveout.service';
import { TasksService } from '../../src/tasks/tasks.service';
import type { BillingServices } from './billing';
import type { ServerTestContext } from './index';
import type { TaxServices } from './tax';
import type { TenancyServices } from './tenancy';

/** The M8 services wired as Nest wires them, on the test database (CLAUDE.md section 12). */
export function maintenanceServices(
  ctx: ServerTestContext,
  s: TenancyServices,
  b: BillingServices,
  t: TaxServices,
) {
  const entitlements = new EntitlementsService(ctx.database, s.policy);
  const tasks = new TasksService(ctx.database, s.policy, ctx.clock);
  const maintenance = new MaintenanceService(
    ctx.database,
    s.policy,
    entitlements,
    s.documents,
    tasks,
    ctx.clock,
  );
  const artisans = new ArtisansService(ctx.database, s.policy, entitlements, ctx.clock);
  const sheets = new JobSheetService(
    ctx.database,
    ctx.config,
    ctx.clock,
    s.sms,
    s.documents,
    maintenance,
  );
  const tenantRepairs = new TenantRepairsService(ctx.database, s.policy, s.documents, maintenance);
  const expenses = new ExpensesService(
    ctx.database,
    s.policy,
    s.documents,
    b.posting,
    maintenance,
    ctx.clock,
  );
  const inspections = new InspectionsService(
    ctx.database,
    s.policy,
    entitlements,
    s.documents,
    ctx.clock,
  );
  const reports = new MoveInReportService(
    ctx.database,
    s.policy,
    s.documents,
    s.esign,
    inspections,
    s.leaseSigning,
    ctx.clock,
  );
  const moveOuts = new MoveOutService(
    ctx.database,
    s.policy,
    s.approvals,
    b.engine,
    b.invoicing,
    s.lifecycle,
    t.rentTax,
    inspections,
    s.documents,
    ctx.clock,
  );
  moveOuts.registerApprovals();
  inspections.useMoveInReports((tx, id) => reports.forInspection(tx, id));
  // As MoveOutModule.onModuleInit (M8 review): the tenant's documents, and M3's quick move-out guard.
  s.tenantApp.useDocumentOwner((tx, id) => reports.tenantOwns(tx, id));
  s.lifecycle.useMoveOutGuard((tx, leaseId) => moveOuts.liveFor(tx, leaseId));
  t.termination.useMoveOutGuard((tx, leaseId) => moveOuts.existsFor(tx, leaseId));
  return {
    entitlements,
    tasks,
    maintenance,
    artisans,
    sheets,
    tenantRepairs,
    expenses,
    inspections,
    reports,
    moveOuts,
  };
}

export type MaintenanceServices = ReturnType<typeof maintenanceServices>;

/** JPEG, MP4 and PDF heads, enough for the first-bytes check (decision 2). */
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
export const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.alloc(300, 2),
]);

/** Puts a file where a presigned upload would, as the browser does. */
export async function putUpload(
  ctx: ServerTestContext,
  upload: { uploadId: string; fields: Record<string, string> },
  contentType: string,
  body: Buffer,
): Promise<string> {
  await ctx.storage.put({
    bucket: ctx.config.S3_BUCKET_FILES,
    key: upload.fields.key!,
    body,
    contentType,
  });
  return upload.uploadId;
}

/** The outbox events of a type for a company, oldest first. */
export async function outboxOf(ctx: ServerTestContext, companyId: string, type: string) {
  return withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .select()
      .from(schema.outboxEvent)
      .where(sql`${schema.outboxEvent.type} = ${type}`)
      .orderBy(schema.outboxEvent.createdAt),
  );
}
