import { Controller, Inject, UseGuards } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { IdempotencyStore } from '@rent/server/core';
import {
  ArtisansService,
  ExpensesService,
  InspectionsService,
  JobSheetService,
  MaintenanceService,
  TenantRepairsService,
} from '@rent/server/maintenance';
import { MoveInReportService, MoveOutService } from '@rent/server/moveout';
import { toApproval } from '../governance/governance.controller';
import { Public } from '../http/guards';
import { idempotent } from '../http/idempotency';
import { Ctx, type RequestContext } from '../http/request-context';
import { serialize } from '../http/serialize';
import { LinksKeyGuard } from '../links/links-key.guard';

const required = { required: true } as const;
const optional = { required: false } as const;

/** The browser's address and device as apps/links reported them; evidence, never logged. */
const clientOf = (client: { ip: string; userAgent: string }) => ({
  ip: client.ip.trim().slice(0, 64) || 'unknown',
  userAgent: client.userAgent.trim().slice(0, 500) || 'unknown',
});

/**
 * Maintenance (MI-01 to MI-06, CM-04; M8 plan 4.2 to 4.5): the board, its steps, uploads and the
 * job's files. Every check is in the services, through PolicyService and EntitlementsService (the
 * board is Growth, decision 1).
 */
@Controller()
export class MaintenanceController {
  constructor(
    @Inject(MaintenanceService) private readonly maintenance: MaintenanceService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Implement(contract.maintenance)
  maintenanceRouter(@Ctx() ctx: RequestContext) {
    const m = this.maintenance;
    const a = ctx.actor;
    return {
      list: implement(contract.maintenance.list).handler(async ({ input }) =>
        serialize(await m.list(a, input)),
      ),
      get: implement(contract.maintenance.get).handler(async ({ input }) =>
        serialize(await m.get(a, input.jobId)),
      ),
      attachmentDownload: implement(contract.maintenance.attachmentDownload).handler(
        async ({ input }) =>
          serialize(await m.attachmentDownload(a, input.jobId, input.attachmentId)),
      ),
      createUpload: implement(contract.maintenance.createUpload).handler(async ({ input }) =>
        serialize(await m.createUpload(a, input)),
      ),
      // An Idempotency-Key is honoured when sent (M8 review): a retry returns the first job.
      report: implement(contract.maintenance.report).handler(async ({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'maintenance.report',
          input,
          async (claim) => ({ jobId: (await m.logRepair(a, input, { claim })).id }),
          async (w) => serialize(await m.get(a, w.jobId)),
          optional,
        ),
      ),
      triage: implement(contract.maintenance.triage).handler(async ({ input }) =>
        serialize(await m.triage(a, input.jobId, input)),
      ),
      changePriority: implement(contract.maintenance.changePriority).handler(async ({ input }) =>
        serialize(await m.changePriority(a, input.jobId, input)),
      ),
      assign: implement(contract.maintenance.assign).handler(async ({ input }) =>
        serialize(await m.assign(a, input.jobId, input)),
      ),
      unassign: implement(contract.maintenance.unassign).handler(async ({ input }) =>
        serialize(await m.unassign(a, input.jobId, input.reason)),
      ),
      planVisit: implement(contract.maintenance.planVisit).handler(async ({ input }) =>
        serialize(await m.planVisit(a, input.jobId, input)),
      ),
      start: implement(contract.maintenance.start).handler(async ({ input }) =>
        serialize(await m.start(a, input.jobId, input)),
      ),
      complete: implement(contract.maintenance.complete).handler(async ({ input }) =>
        serialize(await m.complete(a, input.jobId, input)),
      ),
      recordResponse: implement(contract.maintenance.recordResponse).handler(async ({ input }) =>
        serialize(await m.recordResponse(a, input.jobId, input)),
      ),
      close: implement(contract.maintenance.close).handler(async ({ input }) =>
        serialize(await m.close(a, input.jobId, input.note)),
      ),
      cancel: implement(contract.maintenance.cancel).handler(async ({ input }) =>
        serialize(await m.cancel(a, input.jobId, input.reason)),
      ),
      addMedia: implement(contract.maintenance.addMedia).handler(async ({ input }) =>
        serialize(await m.addMedia(a, input.jobId, input)),
      ),
      addNote: implement(contract.maintenance.addNote).handler(async ({ input }) =>
        serialize(await m.addNote(a, input.jobId, input.note)),
      ),
    };
  }
}

/** Artisans (MI-04; decision 6). */
@Controller()
export class ArtisansController {
  constructor(@Inject(ArtisansService) private readonly artisans: ArtisansService) {}

  @Implement(contract.artisans)
  artisansRouter(@Ctx() ctx: RequestContext) {
    return {
      list: implement(contract.artisans.list).handler(async ({ input }) =>
        serialize(await this.artisans.list(ctx.actor, input)),
      ),
      create: implement(contract.artisans.create).handler(async ({ input }) =>
        serialize(await this.artisans.create(ctx.actor, input)),
      ),
      update: implement(contract.artisans.update).handler(async ({ input }) => {
        const { artisanId, ...patch } = input;
        return serialize(await this.artisans.update(ctx.actor, artisanId, patch));
      }),
      archive: implement(contract.artisans.archive).handler(async ({ input }) =>
        serialize(await this.artisans.archive(ctx.actor, input.artisanId)),
      ),
    };
  }
}

/**
 * The artisan's job sheet (decision 6; apps/links /j/[token]): no session; the token authorises
 * the page and the links key the caller. Rate-limited in JobSheetService.
 */
@Public()
@UseGuards(LinksKeyGuard)
@Controller()
export class JobSheetsController {
  constructor(@Inject(JobSheetService) private readonly sheets: JobSheetService) {}

  @Implement(contract.jobSheets)
  jobSheetsRouter() {
    const s = this.sheets;
    return {
      open: implement(contract.jobSheets.open).handler(async ({ input }) =>
        serialize(await s.open(input.token, clientOf(input.client))),
      ),
      respond: implement(contract.jobSheets.respond).handler(async ({ input }) =>
        serialize(await s.respond(input.token, clientOf(input.client), input)),
      ),
      createUpload: implement(contract.jobSheets.createUpload).handler(async ({ input }) => {
        const { token, client, ...declared } = input;
        return serialize(await s.createUpload(token, clientOf(client), declared));
      }),
      start: implement(contract.jobSheets.start).handler(async ({ input }) =>
        serialize(await s.start(input.token, clientOf(input.client), input)),
      ),
      sendCode: implement(contract.jobSheets.sendCode).handler(async ({ input }) =>
        serialize(await s.sendCode(input.token, clientOf(input.client))),
      ),
      complete: implement(contract.jobSheets.complete).handler(async ({ input }) =>
        serialize(await s.complete(input.token, clientOf(input.client), input)),
      ),
      attachment: implement(contract.jobSheets.attachment).handler(async ({ input }) =>
        s.attachmentUrl(input.token, clientOf(input.client), input.attachmentId),
      ),
    };
  }
}

/** Inspections and the move-in report (MI-10, TL-08). */
@Controller()
export class InspectionsController {
  constructor(
    @Inject(InspectionsService) private readonly inspections: InspectionsService,
    @Inject(MoveInReportService) private readonly reports: MoveInReportService,
  ) {}

  @Implement(contract.inspections)
  inspectionsRouter(@Ctx() ctx: RequestContext) {
    const i = this.inspections;
    const a = ctx.actor;
    return {
      templates: implement(contract.inspections.templates).handler(async () =>
        serialize(await i.templates(a)),
      ),
      updateTemplate: implement(contract.inspections.updateTemplate).handler(async ({ input }) =>
        serialize(await i.updateTemplate(a, input.unitType, input.rooms)),
      ),
      resetTemplate: implement(contract.inspections.resetTemplate).handler(async ({ input }) =>
        serialize(await i.resetTemplate(a, input.unitType)),
      ),
      list: implement(contract.inspections.list).handler(async ({ input }) =>
        serialize(await i.list(a, input)),
      ),
      get: implement(contract.inspections.get).handler(
        async ({ input }) => serialize(await i.get(a, input.inspectionId)) as never,
      ),
      start: implement(contract.inspections.start).handler(
        async ({ input }) => serialize(await i.start(a, input)) as never,
      ),
      updateItem: implement(contract.inspections.updateItem).handler(async ({ input }) =>
        serialize(await i.updateItem(a, input.inspectionId, input.itemId, input)),
      ),
      createUpload: implement(contract.inspections.createUpload).handler(async ({ input }) =>
        serialize(await i.createUpload(a, input)),
      ),
      addPhotos: implement(contract.inspections.addPhotos).handler(async ({ input }) =>
        serialize(await i.addPhotos(a, input.inspectionId, input.itemId, input.uploadIds)),
      ),
      submit: implement(contract.inspections.submit).handler(
        async ({ input }) => serialize(await i.submit(a, input.inspectionId)) as never,
      ),
      photoDownload: implement(contract.inspections.photoDownload).handler(async ({ input }) =>
        serialize(await i.photoUrl(a, input.inspectionId, input.photoId)),
      ),
      moveInReport: implement(contract.inspections.moveInReport).handler(async ({ input }) =>
        serialize(await this.reports.forLease(a, input.leaseId)),
      ),
      moveInReportDownload: implement(contract.inspections.moveInReportDownload).handler(
        async ({ input }) => serialize(await this.reports.downloadUrl(a, input.leaseId)),
      ),
    };
  }
}

/** Expenses (AC-03; decision 8). Money writes require an Idempotency-Key. */
@Controller()
export class ExpensesController {
  constructor(
    @Inject(ExpensesService) private readonly expenses: ExpensesService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Implement(contract.expenses)
  expensesRouter(@Ctx() ctx: RequestContext) {
    const e = this.expenses;
    const a = ctx.actor;
    const view = async (w: { expenseId: string }) => serialize(await e.get(a, w.expenseId));
    return {
      list: implement(contract.expenses.list).handler(async ({ input }) =>
        serialize(await e.list(a, input)),
      ),
      get: implement(contract.expenses.get).handler(async ({ input }) =>
        serialize(await e.get(a, input.expenseId)),
      ),
      createUpload: implement(contract.expenses.createUpload).handler(async ({ input }) =>
        serialize(await e.createUpload(a, input)),
      ),
      record: implement(contract.expenses.record).handler(async ({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'expenses.record',
          input,
          (claim) => e.record(a, input, claim),
          view,
          required,
        ),
      ),
      pay: implement(contract.expenses.pay).handler(async ({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'expenses.pay',
          input,
          (claim) => e.pay(a, input.expenseId, input, claim),
          view,
          required,
        ),
      ),
      reverse: implement(contract.expenses.reverse).handler(async ({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'expenses.reverse',
          input,
          (claim) => e.reverse(a, input.expenseId, input.reason, claim),
          view,
          required,
        ),
      ),
      receiptDownload: implement(contract.expenses.receiptDownload).handler(async ({ input }) =>
        serialize(await e.receiptUrl(a, input.expenseId)),
      ),
    };
  }
}

/** The tenant app's repairs (MI-01, CM-04; decision 3). */
@Controller()
export class TenantRepairsController {
  constructor(@Inject(TenantRepairsService) private readonly repairs: TenantRepairsService) {}

  @Implement(contract.tenantRepairs)
  tenantRepairsRouter(@Ctx() ctx: RequestContext) {
    const r = this.repairs;
    return {
      list: implement(contract.tenantRepairs.list).handler(async () =>
        serialize(await r.list(ctx.actor)),
      ),
      createUpload: implement(contract.tenantRepairs.createUpload).handler(async ({ input }) =>
        serialize(await r.createUpload(ctx.actor, input)),
      ),
      report: implement(contract.tenantRepairs.report).handler(async ({ input }) =>
        serialize(await r.report(ctx.actor, input)),
      ),
      respond: implement(contract.tenantRepairs.respond).handler(async ({ input }) =>
        serialize(await r.respond(ctx.actor, input.jobId, input)),
      ),
      attachment: implement(contract.tenantRepairs.attachment).handler(async ({ input }) =>
        r.attachmentUrl(ctx.actor, input.jobId, input.attachmentId),
      ),
    };
  }
}

/** Move-out and its settlement (TL-11, MI-11; plan 4.8). The refund paid requires a key. */
@Controller()
export class MoveOutsController {
  constructor(
    @Inject(MoveOutService) private readonly moveOuts: MoveOutService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Implement(contract.moveOuts)
  moveOutsRouter(@Ctx() ctx: RequestContext) {
    const m = this.moveOuts;
    const a = ctx.actor;
    const out = async (detail: Awaited<ReturnType<MoveOutService['get']>>) => {
      const { approval, ...rest } = detail;
      return serialize({ ...rest, approval: approval ? toApproval(approval) : null }) as never;
    };
    return {
      plan: implement(contract.moveOuts.plan).handler(async ({ input }) =>
        out(await m.plan(a, input.leaseId, input)),
      ),
      settleDeposit: implement(contract.moveOuts.settleDeposit).handler(async ({ input }) =>
        out(await m.settleDeposit(a, input.leaseId, input.note)),
      ),
      list: implement(contract.moveOuts.list).handler(async ({ input }) =>
        serialize(await m.list(a, input)),
      ),
      get: implement(contract.moveOuts.get).handler(async ({ input }) =>
        out(await m.get(a, input.moveOutId)),
      ),
      startInspection: implement(contract.moveOuts.startInspection).handler(async ({ input }) =>
        out(await m.startInspection(a, input.moveOutId)),
      ),
      // Deductions and charges change what the tenant gets back: each needs a key (M8 review).
      addDeduction: implement(contract.moveOuts.addDeduction).handler(async ({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'moveouts.add-deduction',
          input,
          async (claim) => {
            await m.addDeduction(a, input.moveOutId, input, { claim });
            return { moveOutId: input.moveOutId };
          },
          async (w) => out(await m.get(a, w.moveOutId)),
          required,
        ),
      ),
      withdrawDeduction: implement(contract.moveOuts.withdrawDeduction).handler(async ({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'moveouts.withdraw-deduction',
          input,
          async (claim) => {
            await m.withdrawDeduction(a, input.moveOutId, input.deductionId, { claim });
            return { moveOutId: input.moveOutId };
          },
          async (w) => out(await m.get(a, w.moveOutId)),
          required,
        ),
      ),
      setCharges: implement(contract.moveOuts.setCharges).handler(async ({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'moveouts.set-charges',
          input,
          async (claim) => {
            await m.setCharges(a, input.moveOutId, input.charges, { claim });
            return { moveOutId: input.moveOutId };
          },
          async (w) => out(await m.get(a, w.moveOutId)),
          required,
        ),
      ),
      submit: implement(contract.moveOuts.submit).handler(async ({ input }) =>
        out(await m.submit(a, input.moveOutId, input.note)),
      ),
      recordRefundPaid: implement(contract.moveOuts.recordRefundPaid).handler(async ({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'moveouts.refund-paid',
          input,
          async (claim) => {
            await m.recordRefundPaid(a, input.moveOutId, input, { claim });
            return { moveOutId: input.moveOutId };
          },
          async (w) => out(await m.get(a, w.moveOutId)),
          required,
        ),
      ),
      cancel: implement(contract.moveOuts.cancel).handler(async ({ input }) =>
        out(await m.cancel(a, input.moveOutId, input.reason)),
      ),
      statementDocument: implement(contract.moveOuts.statementDocument).handler(async ({ input }) =>
        serialize(await m.statementUrl(a, input.moveOutId)),
      ),
    };
  }
}
