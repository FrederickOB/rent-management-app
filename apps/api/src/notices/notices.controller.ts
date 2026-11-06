import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { IdempotencyStore } from '@rent/server/core';
import { NoticeAcknowledgementsService, NoticesService } from '@rent/server/notices';
import { TasksService } from '@rent/server/tasks';
import { toApproval } from '../governance/governance.controller';
import { idempotent } from '../http/idempotency';
import { Ctx, type RequestContext } from '../http/request-context';
import { serialize } from '../http/serialize';

const optional = { required: false } as const;
/** Review C5: the append-only creates require a key, so a retry never records twice. */
const required = { required: true } as const;

/**
 * Legal notices (LN-01 to LN-05, LN-07, LN-09; M7 plan 4.10): the dashboard, the composer, drafts,
 * approval and issue, the ladder, physical service, closure and corrections. Every check is in the
 * services, through PolicyService and EntitlementsService (Growth only). Writes that create records
 * take an optional Idempotency-Key.
 */
@Controller()
export class NoticesController {
  constructor(
    @Inject(NoticesService) private readonly notices: NoticesService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  private async detail(ctx: RequestContext, noticeId: string) {
    const { approval, ...detail } = await this.notices.get(ctx.actor, noticeId);
    return serialize({ ...detail, approval: approval ? toApproval(approval) : null });
  }

  @Implement(contract.notices)
  noticesRouter(@Ctx() ctx: RequestContext) {
    return {
      types: implement(contract.notices.types).handler(async () =>
        serialize(await this.notices.types(ctx.actor)),
      ),
      list: implement(contract.notices.list).handler(async ({ input }) =>
        serialize(await this.notices.list(ctx.actor, input)),
      ),
      summary: implement(contract.notices.summary).handler(async () =>
        this.notices.summary(ctx.actor),
      ),
      get: implement(contract.notices.get).handler(async ({ input }) =>
        this.detail(ctx, input.noticeId),
      ),
      compose: implement(contract.notices.compose).handler(async ({ input }) =>
        serialize(await this.notices.compose(ctx.actor, input)),
      ),
      create: implement(contract.notices.create).handler(async ({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'notices.create',
          input,
          (claim) => this.notices.createRecord(ctx.actor, input, claim),
          (written) => this.detail(ctx, written.noticeId),
          optional,
        ),
      ),
      update: implement(contract.notices.update).handler(async ({ input }) => {
        const { noticeId, ...patch } = input;
        await this.notices.update(ctx.actor, noticeId, patch);
        return this.detail(ctx, noticeId);
      }),
      preview: implement(contract.notices.preview).handler(async ({ input }) =>
        this.notices.preview(ctx.actor, input.noticeId),
      ),
      discard: implement(contract.notices.discard).handler(async ({ input }) => {
        await this.notices.discard(ctx.actor, input.noticeId);
        return this.detail(ctx, input.noticeId);
      }),
      submit: implement(contract.notices.submit).handler(async ({ input }) => {
        await this.notices.submit(ctx.actor, input.noticeId);
        return this.detail(ctx, input.noticeId);
      }),
      returnToDraft: implement(contract.notices.returnToDraft).handler(async ({ input }) => {
        await this.notices.returnToDraft(ctx.actor, input.noticeId);
        return this.detail(ctx, input.noticeId);
      }),
      issue: implement(contract.notices.issue).handler(async ({ input }) => {
        await this.notices.issue(ctx.actor, input.noticeId);
        return this.detail(ctx, input.noticeId);
      }),
      ladder: implement(contract.notices.ladder).handler(async ({ input }) => {
        await this.notices.controlLadder(ctx.actor, input.noticeId, input.action, input.reason);
        return this.detail(ctx, input.noticeId);
      }),
      recordService: implement(contract.notices.recordService).handler(async ({ input }) => {
        const { noticeId, ...record } = input;
        return idempotent(
          this.idempotency,
          ctx,
          'notices.record-service',
          input,
          async (claim) => {
            await this.notices.recordService(ctx.actor, noticeId, record, claim);
            return { noticeId };
          },
          (written) => this.detail(ctx, written.noticeId),
          required,
        );
      }),
      createUpload: implement(contract.notices.createUpload).handler(async ({ input }) =>
        serialize(await this.notices.createUpload(ctx.actor, input)),
      ),
      close: implement(contract.notices.close).handler(async ({ input }) => {
        await this.notices.close(ctx.actor, input.noticeId, input.outcome, input.note);
        return this.detail(ctx, input.noticeId);
      }),
      correct: implement(contract.notices.correct).handler(async ({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'notices.correct',
          input,
          (claim) => this.notices.correctRecord(ctx.actor, input.noticeId, claim),
          (written) => this.detail(ctx, written.noticeId),
          // Optional (review-round adjustment): a retry without a key is refused by the one
          // live correction per notice (409 NOTICE_CORRECTION_OPEN), so it never makes two.
          optional,
        ),
      ),
      handoverLink: implement(contract.notices.handoverLink).handler(async ({ input }) =>
        serialize(await this.notices.handoverLink(ctx.actor, input.noticeId, input.recipientId)),
      ),
      download: implement(contract.notices.download).handler(async ({ input }) => ({
        url: await this.notices.download(ctx.actor, input.noticeId, input.which, input.recordId),
      })),
      recordReceived: implement(contract.notices.recordReceived).handler(async ({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'notices.record-received',
          input,
          async (claim) => {
            const view = await this.notices.recordReceived(ctx.actor, input, claim);
            return { noticeId: view.id };
          },
          (written) => this.detail(ctx, written.noticeId),
          required,
        ),
      ),
    };
  }
}

/** OQ-16 (decision 9): accepting or withdrawing the notice-to-quit risk statement. */
@Controller()
export class QuitAcknowledgementController {
  constructor(
    @Inject(NoticeAcknowledgementsService) private readonly acks: NoticeAcknowledgementsService,
  ) {}

  @Implement(contract.quitAcknowledgement)
  quitRouter(@Ctx() ctx: RequestContext) {
    return {
      get: implement(contract.quitAcknowledgement.get).handler(async () =>
        serialize(await this.acks.quitAcknowledgement(ctx.actor)),
      ),
      grant: implement(contract.quitAcknowledgement.grant).handler(async ({ input }) =>
        serialize(await this.acks.grantQuit(ctx.actor, input)),
      ),
      withdraw: implement(contract.quitAcknowledgement.withdraw).handler(async ({ input }) =>
        serialize(await this.acks.withdrawQuit(ctx.actor, input.reason)),
      ),
    };
  }
}

/** Rent Officer assessments on a unit (decision 3; Act 220 s.23). */
@Controller()
export class RentAssessmentsController {
  constructor(
    @Inject(NoticeAcknowledgementsService) private readonly acks: NoticeAcknowledgementsService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Implement(contract.rentAssessments)
  assessmentsRouter(@Ctx() ctx: RequestContext) {
    return {
      list: implement(contract.rentAssessments.list).handler(async ({ input }) =>
        serialize(await this.acks.assessments(ctx.actor, input.unitId)),
      ),
      record: implement(contract.rentAssessments.record).handler(async ({ input }) => {
        const { unitId, ...record } = input;
        return serialize(
          await idempotent(
            this.idempotency,
            ctx,
            'rent-assessments.record',
            input,
            (claim) => this.acks.recordAssessment(ctx.actor, unitId, record, claim),
            undefined,
            required,
          ),
        );
      }),
      correct: implement(contract.rentAssessments.correct).handler(async ({ input }) => {
        const { unitId, assessmentId, ...record } = input;
        return serialize(
          await idempotent(
            this.idempotency,
            ctx,
            'rent-assessments.correct',
            input,
            (claim) => this.acks.correctAssessment(ctx.actor, unitId, assessmentId, record, claim),
            undefined,
            required,
          ),
        );
      }),
      void: implement(contract.rentAssessments.void).handler(async ({ input }) =>
        serialize(
          await idempotent(
            this.idempotency,
            ctx,
            'rent-assessments.void',
            input,
            (claim) =>
              this.acks.voidAssessment(
                ctx.actor,
                input.unitId,
                input.assessmentId,
                input.reason,
                claim,
              ),
            undefined,
            required,
          ),
        ),
      ),
      download: implement(contract.rentAssessments.download).handler(async ({ input }) => ({
        url: await this.acks.assessmentDocument(ctx.actor, input.unitId, input.assessmentId),
      })),
    };
  }
}

/** Staff tasks (CF-06): mine and all, complete, note and cancel. */
@Controller()
export class TasksController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Implement(contract.tasks)
  tasksRouter(@Ctx() ctx: RequestContext) {
    return {
      list: implement(contract.tasks.list).handler(async ({ input }) =>
        serialize(await this.tasks.list(ctx.actor, input)),
      ),
      get: implement(contract.tasks.get).handler(async ({ input }) =>
        serialize(await this.tasks.get(ctx.actor, input.taskId)),
      ),
      complete: implement(contract.tasks.complete).handler(async ({ input }) =>
        serialize(await this.tasks.complete(ctx.actor, input.taskId, input.note ?? null)),
      ),
      note: implement(contract.tasks.note).handler(async ({ input }) =>
        serialize(await this.tasks.note(ctx.actor, input.taskId, input.note)),
      ),
      cancel: implement(contract.tasks.cancel).handler(async ({ input }) =>
        serialize(await this.tasks.cancel(ctx.actor, input.taskId, input.note)),
      ),
    };
  }
}
