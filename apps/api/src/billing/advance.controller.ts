import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { AdvanceService, MoneyService, TerminationService } from '@rent/server/billing';
import { IdempotencyStore, notFound } from '@rent/server/core';
import { toApproval } from '../governance/governance.controller';
import { idempotent } from '../http/idempotency';
import { Ctx, type RequestContext } from '../http/request-context';
import { serialize } from '../http/serialize';

/**
 * Early termination (AR-04), advance rent (AR-05) and the paid-until prompt (AR-06): M5 plan 5.4
 * and 5.5. Every money write needs an Idempotency-Key; every check goes through PolicyService in
 * the services.
 */
@Controller()
export class AdvanceController {
  constructor(
    @Inject(TerminationService) private readonly termination: TerminationService,
    @Inject(AdvanceService) private readonly advance: AdvanceService,
    @Inject(MoneyService) private readonly money: MoneyService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Implement(contract.earlyTermination)
  earlyTerminationRouter(@Ctx() ctx: RequestContext) {
    const one = async (id: string) => {
      const [found] = await this.termination.list(ctx.actor, { ids: [id] });
      if (!found) throw notFound('Early termination');
      return serialize(found);
    };
    return {
      preview: implement(contract.earlyTermination.preview).handler(async ({ input }) => {
        const { leaseId, ...rest } = input;
        return serialize(await this.termination.preview(ctx.actor, leaseId, rest));
      }),
      request: implement(contract.earlyTermination.request).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'lease.early_termination',
          input,
          (claim) => {
            const { leaseId, ...rest } = input;
            return this.termination.request(ctx.actor, leaseId, rest, { claim });
          },
          async ({ terminationId, approvalId }) => ({
            termination: await one(terminationId),
            approval: toApproval(await this.money.approval(ctx.actor, approvalId)),
          }),
        ),
      ),
      list: implement(contract.earlyTermination.list).handler(async ({ input }) =>
        serialize(await this.termination.list(ctx.actor, input)),
      ),
      get: implement(contract.earlyTermination.get).handler(({ input }) =>
        one(input.terminationId),
      ),
      createUpload: implement(contract.earlyTermination.createUpload).handler(async ({ input }) =>
        serialize(await this.termination.createUpload(ctx.actor, input)),
      ),
      recordRefundPaid: implement(contract.earlyTermination.recordRefundPaid).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'lease.refund_paid',
          input,
          async (claim) => {
            const { terminationId, ...rest } = input;
            await this.termination.recordPaid(ctx.actor, terminationId, rest, { claim });
            return terminationId;
          },
          (id) => one(id),
        ),
      ),
    };
  }

  @Implement(contract.advanceRent)
  advanceRentRouter(@Ctx() ctx: RequestContext) {
    return {
      compliance: implement(contract.advanceRent.compliance).handler(async () =>
        serialize(await this.advance.complianceReport(ctx.actor)),
      ),
      payment: implement(contract.advanceRent.payment).handler(({ input }) =>
        this.advance.paymentAdvance(ctx.actor, input.paymentId),
      ),
      lease: implement(contract.advanceRent.lease).handler(async ({ input }) =>
        serialize(await this.advance.leaseAdvance(ctx.actor, input.leaseId)),
      ),
      paidUntilEnding: implement(contract.advanceRent.paidUntilEnding).handler(async ({ input }) =>
        serialize(await this.advance.paidUntilEnding(ctx.actor, input.days)),
      ),
    };
  }
}
