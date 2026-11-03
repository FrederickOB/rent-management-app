import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { IdempotencyStore, notFound } from '@rent/server/core';
import { GraService, TaxReportService, WithholdingService } from '@rent/server/tax';
import { toApproval } from '../governance/governance.controller';
import { idempotent } from '../http/idempotency';
import { Ctx, type RequestContext } from '../http/request-context';
import { serialize } from '../http/serialize';

/**
 * Rent tax, withholding and VAT returns (M5 plan 5.1 to 5.3, 5.6, 5.8). Every money write needs
 * an Idempotency-Key; every check goes through PolicyService in the services.
 */
@Controller()
export class TaxController {
  constructor(
    @Inject(TaxReportService) private readonly reports: TaxReportService,
    @Inject(GraService) private readonly gra: GraService,
    @Inject(WithholdingService) private readonly withholding: WithholdingService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Implement(contract.rentTax)
  rentTaxRouter(@Ctx() ctx: RequestContext) {
    return {
      items: implement(contract.rentTax.items).handler(async ({ input }) =>
        serialize(await this.reports.items(ctx.actor, input)),
      ),
      due: implement(contract.rentTax.due).handler(async ({ input }) =>
        serialize(await this.reports.dueList(ctx.actor, input)),
      ),
      report: implement(contract.rentTax.report).handler(async ({ input }) =>
        serialize(await this.reports.report(ctx.actor, input)),
      ),
      reportCsv: implement(contract.rentTax.reportCsv).handler(({ input }) =>
        this.reports.csv(ctx.actor, input),
      ),
      requestReportPdf: implement(contract.rentTax.requestReportPdf).handler(({ input }) =>
        this.reports.requestPdf(ctx.actor, input),
      ),
      reportPdf: implement(contract.rentTax.reportPdf).handler(({ input }) =>
        this.reports.pdf(ctx.actor, input.renderRequestId),
      ),
      createUpload: implement(contract.rentTax.createUpload).handler(async ({ input }) => {
        const { purpose, ...rest } = input;
        return serialize(
          purpose === 'gra_receipt'
            ? await this.gra.createUpload(ctx.actor, rest)
            : await this.withholding.createUpload(ctx.actor, rest),
        );
      }),
      graPayments: implement(contract.rentTax.graPayments).handler(async ({ input }) =>
        serialize(await this.gra.graPayments(ctx.actor, input)),
      ),
      recordGraPayment: implement(contract.rentTax.recordGraPayment).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'tax.gra_payment',
          input,
          (claim) => this.gra.recordGraPayment(ctx.actor, input, { claim }),
          async (id) => {
            const [payment] = await this.gra.graPayments(ctx.actor, { ids: [id] });
            if (!payment) throw notFound('GRA payment');
            return serialize(payment);
          },
        ),
      ),
      file: implement(contract.rentTax.file).handler(async ({ input }) => ({
        url: await this.reports.fileUrl(ctx.actor, input.documentId),
      })),
    };
  }

  @Implement(contract.withholding)
  withholdingRouter(@Ctx() ctx: RequestContext) {
    const view = async (id: string) => serialize(await this.withholding.get(ctx.actor, id));
    const ofCertificate = async (certificateId: string) => {
      const [found] = (await this.withholding.list(ctx.actor, {})).filter(
        (w) => w.certificate?.id === certificateId,
      );
      if (found) return serialize(found);
      // A rejected certificate is no longer the live one: find its withholding directly.
      const id = await this.withholding.withholdingOfCertificate(ctx.actor, certificateId);
      return view(id);
    };
    return {
      options: implement(contract.withholding.options).handler(({ input }) =>
        this.withholding.options(ctx.actor, input.leaseId, input.valueDate),
      ),
      list: implement(contract.withholding.list).handler(async ({ input }) =>
        serialize(await this.withholding.list(ctx.actor, input)),
      ),
      get: implement(contract.withholding.get).handler(({ input }) => view(input.withholdingId)),
      record: implement(contract.withholding.record).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'tax.withholding',
          input,
          (claim) => this.withholding.record(ctx.actor, input, { claim }),
          (id) => view(id),
        ),
      ),
      uploadCertificate: implement(contract.withholding.uploadCertificate).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'tax.withholding_certificate',
          input,
          async (claim) => {
            const { withholdingId, ...rest } = input;
            await this.withholding.uploadCertificate(ctx.actor, withholdingId, rest, { claim });
            return withholdingId;
          },
          (id) => view(id),
        ),
      ),
      confirmCertificate: implement(contract.withholding.confirmCertificate).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'tax.certificate_confirm',
          input,
          async (claim) => {
            await this.withholding.confirmCertificate(ctx.actor, input.certificateId, { claim });
            return input.certificateId;
          },
          (id) => ofCertificate(id),
          // A decision, like an approval's: the policy answers first (403 for its uploader), and
          // a retry finds it already confirmed (P20 is keyed on the certificate).
          { required: false },
        ),
      ),
      rejectCertificate: implement(contract.withholding.rejectCertificate).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'tax.certificate_reject',
          input,
          async (claim) => {
            await this.withholding.rejectCertificate(ctx.actor, input.certificateId, input.reason, {
              claim,
            });
            return input.certificateId;
          },
          (id) => ofCertificate(id),
          { required: false },
        ),
      ),
      requestWriteOff: implement(contract.withholding.requestWriteOff).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'tax.withholding_write_off',
          input,
          (claim) =>
            this.withholding.requestWriteOff(ctx.actor, input.withholdingId, input, { claim }),
          async (approvalId) => ({
            approval: toApproval(await this.withholding.approval(ctx.actor, approvalId)),
          }),
        ),
      ),
    };
  }

  @Implement(contract.vat)
  vatRouter(@Ctx() ctx: RequestContext) {
    return {
      report: implement(contract.vat.report).handler(async ({ input }) =>
        serialize(await this.gra.vatReport(ctx.actor, input)),
      ),
      payments: implement(contract.vat.payments).handler(async ({ input }) =>
        serialize(await this.gra.vatPayments(ctx.actor, input)),
      ),
      recordPayment: implement(contract.vat.recordPayment).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'tax.vat_payment',
          input,
          (claim) => this.gra.recordVatPayment(ctx.actor, input, { claim }),
          async (id) => {
            const [payment] = await this.gra.vatPayments(ctx.actor, { ids: [id] });
            if (!payment) throw notFound('VAT payment');
            return serialize(payment);
          },
        ),
      ),
    };
  }
}
