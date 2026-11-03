import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { BillingReadService, MoneyService } from '@rent/server/billing';
import { IdempotencyStore, notFound } from '@rent/server/core';
import { toApproval } from '../governance/governance.controller';
import { idempotent } from '../http/idempotency';
import { Ctx, type RequestContext } from '../http/request-context';
import { serialize } from '../http/serialize';

/**
 * The ledger and billing (M4a plan 4.18): invoices, the lease's money card, payments, receipts,
 * cash and banking, corrections, unmatched receipts and arrears. Every money write requires an
 * Idempotency-Key (plan 4.15). Every check goes through PolicyService in the services.
 */
@Controller()
export class BillingController {
  constructor(
    @Inject(BillingReadService) private readonly read: BillingReadService,
    @Inject(MoneyService) private readonly money: MoneyService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  private async approval(ctx: RequestContext, id: string) {
    return { approval: toApproval(await this.money.approval(ctx.actor, id)) };
  }

  @Implement(contract.invoices)
  invoicesRouter(@Ctx() ctx: RequestContext) {
    return {
      list: implement(contract.invoices.list).handler(async ({ input }) =>
        serialize(await this.read.invoices(ctx.actor, input)),
      ),
      get: implement(contract.invoices.get).handler(async ({ input }) =>
        serialize(await this.read.invoice(ctx.actor, input.invoiceId)),
      ),
      document: implement(contract.invoices.document).handler(async ({ input }) => ({
        url: await this.read.invoiceDocumentUrl(ctx.actor, input.invoiceId),
      })),
      leaseBilling: implement(contract.invoices.leaseBilling).handler(async ({ input }) =>
        serialize(await this.read.leaseBilling(ctx.actor, input.leaseId)),
      ),
      creditNote: implement(contract.invoices.creditNote).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'invoice.credit_note',
          input,
          (claim) => {
            const { lineId, ...rest } = input;
            return this.money.requestCreditNote(ctx.actor, lineId, rest, { claim });
          },
          (approvalId) => this.approval(ctx, approvalId),
        ),
      ),
      writeOff: implement(contract.invoices.writeOff).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'invoice.write_off',
          input,
          (claim) => {
            const { lineId, ...rest } = input;
            return this.money.requestWriteOff(ctx.actor, lineId, rest, { claim });
          },
          (approvalId) => this.approval(ctx, approvalId),
        ),
      ),
    };
  }

  @Implement(contract.payments)
  paymentsRouter(@Ctx() ctx: RequestContext) {
    return {
      createUpload: implement(contract.payments.createUpload).handler(async ({ input }) =>
        serialize(await this.money.createUpload(ctx.actor, input)),
      ),
      recordCash: implement(contract.payments.recordCash).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'payment.cash_record',
          input,
          (claim) => this.money.recordCash(ctx.actor, input, { claim }),
          async ({ cashRecordId, approvalId }) => {
            const [cashRecord] = await this.read.cashRecords(ctx.actor, { ids: [cashRecordId] });
            if (!cashRecord) throw notFound('Cash record');
            return {
              cashRecord: serialize(cashRecord),
              ...(await this.approval(ctx, approvalId)),
            };
          },
        ),
      ),
      cashRecords: implement(contract.payments.cashRecords).handler(async ({ input }) =>
        serialize(await this.read.cashRecords(ctx.actor, input)),
      ),
      recordTransfer: implement(contract.payments.recordTransfer).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'payment.direct_receipt',
          input,
          (claim) => this.money.recordTransfer(ctx.actor, input, { claim }),
          ({ approvalId }) => this.approval(ctx, approvalId),
        ),
      ),
      recordBanking: implement(contract.payments.recordBanking).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'cash.banking',
          input,
          (claim) => this.money.recordBanking(ctx.actor, input, { claim }),
          ({ approvalId }) => this.approval(ctx, approvalId),
        ),
      ),
      collectorsCash: implement(contract.payments.collectorsCash).handler(async () =>
        serialize(await this.read.collectorsCash(ctx.actor)),
      ),
      list: implement(contract.payments.list).handler(async ({ input }) =>
        serialize(await this.read.payments(ctx.actor, input)),
      ),
      get: implement(contract.payments.get).handler(async ({ input }) =>
        serialize(await this.read.payment(ctx.actor, input.paymentId)),
      ),
      requestReversal: implement(contract.payments.requestReversal).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'payment.reversal',
          input,
          (claim) => {
            const { paymentId, ...rest } = input;
            return this.money.requestReversal(ctx.actor, paymentId, rest, { claim });
          },
          (approvalId) => this.approval(ctx, approvalId),
        ),
      ),
      receipts: implement(contract.payments.receipts).handler(async ({ input }) =>
        serialize(await this.read.receipts(ctx.actor, input)),
      ),
      receiptDocument: implement(contract.payments.receiptDocument).handler(async ({ input }) => ({
        url: await this.read.receiptDocumentUrl(ctx.actor, input.receiptId),
      })),
      paymentFile: implement(contract.payments.paymentFile).handler(async ({ input }) => ({
        url: await this.read.paymentFileUrl(ctx.actor, input.documentId),
      })),
      unmatched: implement(contract.payments.unmatched).handler(async () =>
        serialize(await this.read.unmatched(ctx.actor)),
      ),
      match: implement(contract.payments.match).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'payment.match',
          input,
          async (claim) => {
            await this.money.match(ctx.actor, input.paymentId, input.leaseId, { claim });
            return { paymentId: input.paymentId };
          },
          async ({ paymentId }) => serialize(await this.read.payment(ctx.actor, paymentId)),
        ),
      ),
    };
  }

  @Implement(contract.arrears)
  arrearsRouter(@Ctx() ctx: RequestContext) {
    return {
      get: implement(contract.arrears.get).handler(async ({ input }) =>
        serialize(await this.read.arrears(ctx.actor, input)),
      ),
    };
  }
}
