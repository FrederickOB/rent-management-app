import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { IdempotencyStore } from '@rent/server/core';
import { DataProtectionService, RetentionReviewService } from '@rent/server/data-protection';
import { idempotent } from '../http/idempotency';
import { Ctx, type RequestContext } from '../http/request-context';
import { serialize } from '../http/serialize';

/**
 * Data protection requests under Act 843 (M11 decision 5; NFR-DP), for company admins: the
 * register, the tenant's export and erasure. Every check is in the service, through
 * PolicyService. Erasure requires an Idempotency-Key; recording a request takes one when sent.
 */
@Controller()
export class DataProtectionController {
  constructor(
    @Inject(DataProtectionService) private readonly requests: DataProtectionService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Implement(contract.dataProtection)
  dataProtectionRouter(@Ctx() ctx: RequestContext) {
    const c = contract.dataProtection;
    const a = ctx.actor;
    const one = async (requestId: string) => serialize(await this.requests.get(a, requestId));
    return {
      list: implement(c.list).handler(async ({ input }) =>
        serialize(await this.requests.list(a, input)),
      ),
      create: implement(c.create).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'dataProtection.create',
          input,
          async (claim) => (await this.requests.create(a, input, { claim })).id,
          one,
          { required: false },
        ),
      ),
      get: implement(c.get).handler(({ input }) => one(input.requestId)),
      update: implement(c.update).handler(async ({ input }) => {
        const { requestId, ...rest } = input;
        return serialize(await this.requests.update(a, requestId, rest));
      }),
      exportCreate: implement(c.exportCreate).handler(async ({ input }) =>
        serialize(await this.requests.exportCreate(a, input.requestId)),
      ),
      exportGet: implement(c.exportGet).handler(async ({ input }) =>
        serialize(await this.requests.exportGet(a, input.exportId)),
      ),
      erase: implement(c.erase).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'dataProtection.erase',
          input,
          async (claim) => (await this.requests.erase(a, input.requestId, { claim })).id,
          one,
        ),
      ),
    };
  }
}

/** The nightly retention review, for platform admins (decision 5): counts only. */
@Controller()
export class PlatformRetentionController {
  constructor(@Inject(RetentionReviewService) private readonly review: RetentionReviewService) {}

  @Implement(contract.platformRetention)
  platformRetentionRouter(@Ctx() ctx: RequestContext) {
    return {
      review: implement(contract.platformRetention.review).handler(async () =>
        serialize(await this.review.latest(ctx.actor)),
      ),
    };
  }
}
