import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { IdempotencyStore } from '@rent/server/core';
import {
  PayLinksService,
  QueueService,
  SettlementAccountsService,
  TenantMoneyService,
} from '@rent/server/payments';
import { toApproval } from '../governance/governance.controller';
import { idempotent } from '../http/idempotency';
import { Ctx, type RequestContext } from '../http/request-context';
import { serialize } from '../http/serialize';

/**
 * Provider payments for staff and tenants (M4b plan 4.2, 4.5, 4.10 and 4.11): settlement accounts
 * and agreements, the unmatched queue's suggestions and refunds, reconciliation exceptions,
 * sending pay links, and the tenant app's money. Every check goes through PolicyService in the
 * services. A refund request is a money write, so it takes an Idempotency-Key.
 */
@Controller()
export class PaymentsController {
  constructor(
    @Inject(SettlementAccountsService) private readonly accounts: SettlementAccountsService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(PayLinksService) private readonly links: PayLinksService,
    @Inject(TenantMoneyService) private readonly money: TenantMoneyService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Implement(contract.settlement)
  settlementRouter(@Ctx() ctx: RequestContext) {
    return {
      banks: implement(contract.settlement.banks).handler(async () =>
        this.accounts.banks(ctx.actor),
      ),
      list: implement(contract.settlement.list).handler(async () =>
        serialize(await this.accounts.list(ctx.actor)),
      ),
      request: implement(contract.settlement.request).handler(async ({ input }) => {
        const { accountId, approvalId } = await this.accounts.request(ctx.actor, input);
        return {
          account: serialize(await this.accounts.view(ctx.actor, accountId)),
          approval: toApproval(await this.accounts.approval(ctx.actor, approvalId)),
        };
      }),
      retire: implement(contract.settlement.retire).handler(async ({ input }) => {
        const approvalId = await this.accounts.retire(ctx.actor, input.accountId, input.reason);
        return { approval: toApproval(await this.accounts.approval(ctx.actor, approvalId)) };
      }),
      reveal: implement(contract.settlement.reveal).handler(async ({ input }) => ({
        accountNumber: await this.accounts.reveal(ctx.actor, input.accountId, input.reason),
      })),
      agreements: implement(contract.settlement.agreements).handler(async () =>
        this.accounts.agreements(ctx.actor),
      ),
      setAgreement: implement(contract.settlement.setAgreement).handler(async ({ input }) =>
        this.accounts.setAgreement(ctx.actor, input.ownerId, {
          destination: input.destination,
          effectiveFrom: input.effectiveFrom,
        }),
      ),
    };
  }

  @Implement(contract.paymentsQueue)
  queueRouter(@Ctx() ctx: RequestContext) {
    return {
      suggestions: implement(contract.paymentsQueue.suggestions).handler(async ({ input }) =>
        serialize(await this.queue.suggestions(ctx.actor, input.paymentId)),
      ),
      refund: implement(contract.paymentsQueue.refund).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'payment.refund_unmatched',
          input,
          async () =>
            this.queue.requestRefund(ctx.actor, input.paymentId, {
              reason: input.reason,
              proofUploadId: input.proofUploadId ?? null,
            }),
          async (approvalId) => ({
            approval: toApproval(await this.accounts.approval(ctx.actor, approvalId)),
          }),
        ),
      ),
      exceptions: implement(contract.paymentsQueue.exceptions).handler(async ({ input }) =>
        serialize(await this.queue.exceptions(ctx.actor, input.open)),
      ),
      resolveException: implement(contract.paymentsQueue.resolveException).handler(
        async ({ input }) =>
          serialize(await this.queue.resolveException(ctx.actor, input.exceptionId, input.note)),
      ),
      sendPayLink: implement(contract.paymentsQueue.sendPayLink).handler(async ({ input }) =>
        this.links.send(ctx.actor, input.invoiceId),
      ),
    };
  }

  @Implement(contract.tenantMoney)
  tenantMoneyRouter(@Ctx() ctx: RequestContext) {
    return {
      billing: implement(contract.tenantMoney.billing).handler(async ({ input }) =>
        serialize(await this.money.billing(ctx.actor, input.leaseId)),
      ),
      payments: implement(contract.tenantMoney.payments).handler(async () =>
        serialize(await this.money.payments(ctx.actor)),
      ),
      receiptDownload: implement(contract.tenantMoney.receiptDownload).handler(
        async ({ input }) => ({
          url: await this.money.receiptDownload(ctx.actor, input.receiptId),
        }),
      ),
      payLink: implement(contract.tenantMoney.payLink).handler(async ({ input }) =>
        serialize(await this.money.payLink(ctx.actor, input.leaseId)),
      ),
    };
  }
}
