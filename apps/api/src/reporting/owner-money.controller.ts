import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { IdempotencyStore } from '@rent/server/core';
import { OwnerMoneyService } from '@rent/server/reporting';
import { idempotent } from '../http/idempotency';
import { Ctx, type RequestContext } from '../http/request-context';
import { serialize } from '../http/serialize';

/**
 * Fee terms (M9: AC-02; decision 1) and the owner's money the agent holds (AC-05; decision 8):
 * remittances with fees retained, fees taken and owner funding. Every check is in the service,
 * through PolicyService; Growth only, agencies only. The three money writes require an
 * Idempotency-Key; asking for new fee terms accepts one.
 */
@Controller()
export class OwnerMoneyController {
  constructor(
    @Inject(OwnerMoneyService) private readonly money: OwnerMoneyService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Implement(contract.feeTerms)
  feeTermsRouter(@Ctx() ctx: RequestContext) {
    const m = this.money;
    const a = ctx.actor;
    return {
      get: implement(contract.feeTerms.get).handler(async ({ input }) =>
        serialize(await m.feeTerms(a, input.ownerId)),
      ),
      request: implement(contract.feeTerms.request).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'reporting.fee_terms_request',
          input,
          async (claim) => {
            await m.requestFeeTerms(a, input, claim);
            return { ownerId: input.ownerId };
          },
          async ({ ownerId }) => serialize(await m.feeTerms(a, ownerId)),
          { required: false },
        ),
      ),
    };
  }

  @Implement(contract.ownerMoney)
  ownerMoneyRouter(@Ctx() ctx: RequestContext) {
    const m = this.money;
    const a = ctx.actor;
    const render = async ({ id }: { readonly id: string }) => serialize(await m.get(a, id));
    return {
      list: implement(contract.ownerMoney.list).handler(async ({ input }) =>
        serialize(await m.list(a, input)),
      ),
      suggestion: implement(contract.ownerMoney.suggestion).handler(async ({ input }) =>
        serialize(await m.suggestion(a, input.ownerId)),
      ),
      createUpload: implement(contract.ownerMoney.createUpload).handler(async ({ input }) =>
        serialize(await m.createUpload(a, input)),
      ),
      remit: implement(contract.ownerMoney.remit).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'reporting.remittance',
          input,
          (claim) => m.remit(a, input, claim),
          render,
        ),
      ),
      takeFees: implement(contract.ownerMoney.takeFees).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'reporting.fees_taken',
          input,
          (claim) => m.takeFees(a, input, claim),
          render,
        ),
      ),
      fund: implement(contract.ownerMoney.fund).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'reporting.owner_funding',
          input,
          (claim) => m.fund(a, input, claim),
          render,
        ),
      ),
      proof: implement(contract.ownerMoney.proof).handler(async ({ input }) =>
        serialize(await m.proofUrl(a, input.id)),
      ),
    };
  }
}
