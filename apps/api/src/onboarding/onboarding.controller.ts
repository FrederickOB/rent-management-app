import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { XLSX_CONTENT_TYPE } from '@rent/domain/portfolio';
import { IdempotencyStore } from '@rent/server/core';
import { OnboardingService, type BatchView } from '@rent/server/onboarding';
import { idempotent } from '../http/idempotency';
import { Ctx, type RequestContext } from '../http/request-context';
import { serialize } from '../http/serialize';

const toUpload = <T extends { expiresAt: Date }>(u: T) => ({
  ...u,
  expiresAt: u.expiresAt.toISOString(),
});

const workbook = (bytes: Buffer, name: string) =>
  new File([new Uint8Array(bytes)], name, { type: XLSX_CONTENT_TYPE });

/** A batch in the contract's shape. */
const toBatch = (b: BatchView) =>
  serialize({
    id: b.id,
    kind: b.kind,
    status: b.status,
    fileName: b.fileName,
    cutOverDate: b.cutOverDate,
    report: b.report,
    approval: b.approval,
    createdBy: b.createdBy,
    createdAt: b.createdAt,
    committedAt: b.committedAt,
    postedAt: b.postedAt,
    error: b.error,
  });

/**
 * Pilot onboarding (M11 decisions 2 and 3; P25): the cut-over, the workbooks for each step, their
 * dry runs, previews and commits, and the scans of imported paper leases. Every check is in the
 * service, through PolicyService (`onboarding.import`); approving opening balances is the
 * approvals engine's (`opening_balances`). The commit needs an Idempotency-Key: for balances it
 * asks a second person, and a retry must never ask twice.
 */
@Controller()
export class OnboardingController {
  constructor(
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Implement(contract.onboarding)
  onboardingRouter(@Ctx() ctx: RequestContext) {
    const o = this.onboarding;
    const a = ctx.actor;
    return {
      get: implement(contract.onboarding.get).handler(async () => serialize(await o.state(a))),
      setCutOver: implement(contract.onboarding.setCutOver).handler(async ({ input }) =>
        serialize(await o.setCutOver(a, input.cutOverDate)),
      ),
      registerTemplate: implement(contract.onboarding.registerTemplate).handler(async () =>
        workbook(await o.registerTemplate(a), 'onboarding-register-template.xlsx'),
      ),
      template: implement(contract.onboarding.template).handler(async ({ input }) =>
        workbook(await o.template(a, input.kind), `onboarding-${input.kind}-template.xlsx`),
      ),
      createUpload: implement(contract.onboarding.createUpload).handler(async ({ input }) => {
        const { batchId, upload } = await o.createUpload(a, input);
        return { batchId, upload: toUpload(upload) };
      }),
      validate: implement(contract.onboarding.validate).handler(async ({ input }) =>
        toBatch(await o.startValidation(a, input.batchId)),
      ),
      batches: implement(contract.onboarding.batches).handler(async ({ input }) =>
        (await o.batches(a, input.kind)).map(toBatch),
      ),
      batch: implement(contract.onboarding.batch).handler(async ({ input }) =>
        toBatch(await o.batch(a, input.batchId)),
      ),
      preview: implement(contract.onboarding.preview).handler(async ({ input }) =>
        serialize(await o.preview(a, input.batchId)),
      ),
      commit: implement(contract.onboarding.commit).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'onboarding.commit',
          input,
          async (claim) => {
            await o.commit(a, input.batchId, { claim });
            return { batchId: input.batchId };
          },
          async ({ batchId }) => toBatch(await o.batch(a, batchId)),
        ),
      ),
      attachScan: implement(contract.onboarding.attachScan).handler(async ({ input }) =>
        o.attachScan(a, input.leaseId, input.scanUploadId),
      ),
      leasesMissingScan: implement(contract.onboarding.leasesMissingScan).handler(async () =>
        serialize(await o.leasesMissingScan(a)),
      ),
    };
  }
}
