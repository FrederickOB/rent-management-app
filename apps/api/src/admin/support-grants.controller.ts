import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { SupportAccessService } from '@rent/server/admin';
import { serialize } from '../http/serialize';
import { Ctx, type RequestContext } from '../http/request-context';

/**
 * Support access as the company grants it (AD-10; M10 decision 13): its own admins
 * (`support.grant`, allowed while read-only) list, grant and revoke the platform's read-only
 * access, and see each request made under it.
 */
@Controller()
export class SupportGrantsController {
  constructor(@Inject(SupportAccessService) private readonly support: SupportAccessService) {}

  @Implement(contract.supportGrants)
  supportGrantsRouter(@Ctx() ctx: RequestContext) {
    return {
      list: implement(contract.supportGrants.list).handler(async () =>
        serialize(await this.support.list(ctx.actor)),
      ),
      grant: implement(contract.supportGrants.grant).handler(async ({ input }) =>
        serialize(await this.support.grant(ctx.actor, input, ctx.requestId)),
      ),
      revoke: implement(contract.supportGrants.revoke).handler(async ({ input }) =>
        serialize(await this.support.revoke(ctx.actor, input.grantId, ctx.requestId)),
      ),
    };
  }
}
