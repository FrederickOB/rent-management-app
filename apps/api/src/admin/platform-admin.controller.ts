import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import {
  PlatformCompaniesService,
  PlatformPricingService,
  SupportAccessService,
  SystemHealthService,
  UsageService,
} from '@rent/server/admin';
import { IdempotencyStore } from '@rent/server/core';
import { SubscriptionCreditNotesService, SubscriptionService } from '@rent/server/subscription';
import { idempotent } from '../http/idempotency';
import { serialize } from '../http/serialize';
import { Ctx, type RequestContext } from '../http/request-context';

/**
 * The platform admin console (AD-10; M10 decisions 3, 4, 6, 8, 12 to 16; founder answers Q1 and
 * Q2): companies and onboarding, a company's invoices, snapshots and credit notes, reactivation,
 * billing on or off, prices and terms, discount codes, WhatsApp rates, usage, system health and
 * support access under a company's grant. Platform admins only, through PolicyService in each
 * service. Crediting an invoice, extending a trial and turning billing on require an
 * Idempotency-Key; onboarding takes one when sent (review BE-20, BE-21): a retry with the same key
 * answers the first result and does nothing twice.
 */
@Controller()
export class PlatformAdminController {
  constructor(
    @Inject(PlatformCompaniesService) private readonly companies: PlatformCompaniesService,
    @Inject(PlatformPricingService) private readonly pricing: PlatformPricingService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(SystemHealthService) private readonly health: SystemHealthService,
    @Inject(SupportAccessService) private readonly support: SupportAccessService,
    @Inject(SubscriptionService) private readonly subscriptions: SubscriptionService,
    @Inject(SubscriptionCreditNotesService)
    private readonly credits: SubscriptionCreditNotesService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Implement(contract.platformAdmin)
  platformAdminRouter(@Ctx() ctx: RequestContext) {
    const c = contract.platformAdmin;
    const a = ctx.actor;
    return {
      companies: implement(c.companies).handler(async () =>
        serialize(await this.companies.companies(a)),
      ),
      createCompany: implement(c.createCompany).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'platformAdmin.createCompany',
          input,
          async (claim) => ({
            companyId: await this.companies.onboard(a, input, ctx.requestId, claim),
          }),
          async (made: { readonly companyId: string }) =>
            serialize(await this.companies.company(a, made.companyId)),
          { required: false },
        ),
      ),
      company: implement(c.company).handler(async ({ input }) =>
        serialize(await this.companies.company(a, input.companyId)),
      ),
      setTier: implement(c.setTier).handler(async ({ input }) =>
        serialize(await this.companies.setTier(a, input.companyId, input.tier, input.reason)),
      ),
      extendTrial: implement(c.extendTrial).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'platformAdmin.extendTrial',
          input,
          async (claim) => {
            await this.companies.extendTrial(a, input.companyId, input.days, input.reason, claim);
            return { companyId: input.companyId };
          },
          async (done: { readonly companyId: string }) =>
            serialize(await this.companies.company(a, done.companyId)),
        ),
      ),
      applyCode: implement(c.applyCode).handler(async ({ input }) =>
        serialize(await this.companies.applyCode(a, input.companyId, input.code)),
      ),
      invoice: implement(c.invoice).handler(async ({ input }) =>
        serialize(await this.subscriptions.invoiceDetailFor(a, input.companyId, input.invoiceId)),
      ),
      snapshot: implement(c.snapshot).handler(async ({ input }) =>
        serialize(await this.subscriptions.snapshotFor(a, input.companyId, input.snapshotId)),
      ),
      creditInvoice: implement(c.creditInvoice).handler(({ input }) =>
        idempotent(this.idempotency, ctx, 'platformAdmin.creditInvoice', input, async (claim) =>
          serialize(
            await this.credits.credit(
              a,
              input.companyId,
              input.invoiceId,
              { amountMinor: input.amountMinor, reason: input.reason },
              claim,
            ),
          ),
        ),
      ),
      creditNoteDocument: implement(c.creditNoteDocument).handler(async ({ input }) =>
        serialize(await this.credits.documentFor(a, input.companyId, input.creditNoteId)),
      ),
      reactivate: implement(c.reactivate).handler(async ({ input }) =>
        serialize(
          await this.companies.reactivate(a, input.companyId, {
            tier: input.tier,
            trialDays: input.trialDays ?? null,
            reason: input.reason,
          }),
        ),
      ),
      billing: implement(c.billing).handler(async () =>
        serialize(await this.subscriptions.billingState(a)),
      ),
      turnOnBilling: implement(c.turnOnBilling).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'platformAdmin.turnOnBilling',
          input,
          async (claim) => {
            await this.subscriptions.turnOnBilling(
              a,
              { startsOn: input.startsOn, note: input.note ?? null },
              claim,
            );
            return { startsOn: input.startsOn };
          },
          // The state now, on the first answer and on a replay alike.
          async () => serialize(await this.subscriptions.billingState(a)),
        ),
      ),
      invoiceDocument: implement(c.invoiceDocument).handler(async ({ input }) =>
        serialize(await this.companies.invoiceDocument(a, input.companyId, input.invoiceId)),
      ),
      priceLists: implement(c.priceLists).handler(async () =>
        serialize(await this.pricing.priceLists(a)),
      ),
      addPriceList: implement(c.addPriceList).handler(async ({ input }) =>
        serialize(await this.pricing.addPriceList(a, input)),
      ),
      terms: implement(c.terms).handler(async () => serialize(await this.pricing.terms(a))),
      addTerms: implement(c.addTerms).handler(async ({ input }) =>
        serialize(await this.pricing.addTerms(a, input)),
      ),
      discountCodes: implement(c.discountCodes).handler(async () =>
        serialize(await this.pricing.discountCodes(a)),
      ),
      addDiscountCode: implement(c.addDiscountCode).handler(async ({ input }) =>
        serialize(await this.pricing.addDiscountCode(a, input)),
      ),
      whatsappRates: implement(c.whatsappRates).handler(async () =>
        serialize(await this.pricing.whatsappRates(a)),
      ),
      addWhatsappRate: implement(c.addWhatsappRate).handler(async ({ input }) =>
        serialize(await this.pricing.addWhatsappRate(a, input)),
      ),
      usage: implement(c.usage).handler(async ({ input }) =>
        serialize(await this.usage.usage(a, input.month)),
      ),
      health: implement(c.health).handler(async () => serialize(await this.health.health(a))),
      supportGrants: implement(c.supportGrants).handler(async ({ input }) =>
        serialize(await this.support.grantsAcrossCompanies(a, input.activeOnly ?? false)),
      ),
      supportOverview: implement(c.supportOverview).handler(async ({ input }) =>
        serialize(await this.support.overview(a, input.companyId, ctx.requestId)),
      ),
    };
  }
}
