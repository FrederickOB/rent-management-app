import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { IdempotencyStore } from '@rent/server/core';
import {
  SubscriptionBillingService,
  SubscriptionPaymentsService,
  SubscriptionService,
} from '@rent/server/subscription';
import { idempotent } from '../http/idempotency';
import { Ctx, type RequestContext } from '../http/request-context';
import { serialize } from '../http/serialize';

/**
 * The company's subscription (M10: AD-08, PB-02 to PB-05, PB-07, PB-08, PB-10, PB-11): its view,
 * invoices with their snapshots and PDFs, receipts, paying, tier changes, codes, cancellation and
 * the export. Every check is in the services, through PolicyService; reading needs
 * `subscription.read`, everything else `subscription.manage` (allowed while read-only). Paying
 * requires an Idempotency-Key.
 */
@Controller()
export class SubscriptionController {
  constructor(
    @Inject(SubscriptionService) private readonly subscription: SubscriptionService,
    @Inject(SubscriptionBillingService) private readonly billing: SubscriptionBillingService,
    @Inject(SubscriptionPaymentsService) private readonly payments: SubscriptionPaymentsService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Implement(contract.subscription)
  subscriptionRouter(@Ctx() ctx: RequestContext) {
    const s = this.subscription;
    const a = ctx.actor;
    return {
      get: implement(contract.subscription.get).handler(async () => serialize(await s.view(a))),
      invoices: implement(contract.subscription.invoices).handler(async () =>
        serialize(await s.invoices(a)),
      ),
      invoice: implement(contract.subscription.invoice).handler(async ({ input }) =>
        serialize(await s.invoice(a, input.invoiceId)),
      ),
      invoiceDocument: implement(contract.subscription.invoiceDocument).handler(async ({ input }) =>
        serialize(await this.billing.invoiceDocument(a, input.invoiceId)),
      ),
      snapshot: implement(contract.subscription.snapshot).handler(async ({ input }) =>
        serialize(await s.snapshot(a, input.snapshotId)),
      ),
      receipts: implement(contract.subscription.receipts).handler(async () =>
        serialize(await this.payments.receipts(a)),
      ),
      receiptDocument: implement(contract.subscription.receiptDocument).handler(async ({ input }) =>
        serialize(await this.payments.receiptDocument(a, input.receiptId)),
      ),
      pay: implement(contract.subscription.pay).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'subscription.pay',
          input,
          (claim) => this.payments.pay(a, input, claim),
          async (view: { readonly id: string }) =>
            serialize(await this.payments.payment(a, view.id)),
        ),
      ),
      payment: implement(contract.subscription.payment).handler(async ({ input }) =>
        serialize(await this.payments.payment(a, input.paymentId)),
      ),
      changeTier: implement(contract.subscription.changeTier).handler(async ({ input }) =>
        serialize(await s.changeTier(a, input.tier)),
      ),
      applyCode: implement(contract.subscription.applyCode).handler(async ({ input }) =>
        serialize(await s.applyCode(a, input.code)),
      ),
      cancel: implement(contract.subscription.cancel).handler(async ({ input }) =>
        serialize(await s.cancel(a, input.reason ?? null)),
      ),
      withdrawCancel: implement(contract.subscription.withdrawCancel).handler(async () =>
        serialize(await s.withdrawCancel(a)),
      ),
      exportCreate: implement(contract.subscription.exportCreate).handler(async () =>
        serialize(await s.exportCreate(a)),
      ),
      exportGet: implement(contract.subscription.exportGet).handler(async ({ input }) =>
        serialize(await s.exportGet(a, input.exportId)),
      ),
    };
  }
}
