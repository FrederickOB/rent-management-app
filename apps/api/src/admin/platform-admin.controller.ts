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
import { serialize } from '../http/serialize';
import { Ctx, type RequestContext } from '../http/request-context';

/**
 * The platform admin console (AD-10; M10 decisions 3, 4, 6, 8, 13 to 16): companies and
 * onboarding, prices and terms, discount codes, WhatsApp rates, usage, system health and support
 * access under a company's grant. Platform admins only, through PolicyService in each service.
 */
@Controller()
export class PlatformAdminController {
  constructor(
    @Inject(PlatformCompaniesService) private readonly companies: PlatformCompaniesService,
    @Inject(PlatformPricingService) private readonly pricing: PlatformPricingService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(SystemHealthService) private readonly health: SystemHealthService,
    @Inject(SupportAccessService) private readonly support: SupportAccessService,
  ) {}

  @Implement(contract.platformAdmin)
  platformAdminRouter(@Ctx() ctx: RequestContext) {
    const c = contract.platformAdmin;
    return {
      companies: implement(c.companies).handler(async () =>
        serialize(await this.companies.companies(ctx.actor)),
      ),
      createCompany: implement(c.createCompany).handler(async ({ input }) =>
        serialize(await this.companies.createCompany(ctx.actor, input, ctx.requestId)),
      ),
      company: implement(c.company).handler(async ({ input }) =>
        serialize(await this.companies.company(ctx.actor, input.companyId)),
      ),
      setTier: implement(c.setTier).handler(async ({ input }) =>
        serialize(
          await this.companies.setTier(ctx.actor, input.companyId, input.tier, input.reason),
        ),
      ),
      extendTrial: implement(c.extendTrial).handler(async ({ input }) =>
        serialize(
          await this.companies.extendTrial(ctx.actor, input.companyId, input.days, input.reason),
        ),
      ),
      applyCode: implement(c.applyCode).handler(async ({ input }) =>
        serialize(await this.companies.applyCode(ctx.actor, input.companyId, input.code)),
      ),
      invoiceDocument: implement(c.invoiceDocument).handler(async ({ input }) =>
        serialize(
          await this.companies.invoiceDocument(ctx.actor, input.companyId, input.invoiceId),
        ),
      ),
      priceLists: implement(c.priceLists).handler(async () =>
        serialize(await this.pricing.priceLists(ctx.actor)),
      ),
      addPriceList: implement(c.addPriceList).handler(async ({ input }) =>
        serialize(await this.pricing.addPriceList(ctx.actor, input)),
      ),
      terms: implement(c.terms).handler(async () => serialize(await this.pricing.terms(ctx.actor))),
      addTerms: implement(c.addTerms).handler(async ({ input }) =>
        serialize(await this.pricing.addTerms(ctx.actor, input)),
      ),
      discountCodes: implement(c.discountCodes).handler(async () =>
        serialize(await this.pricing.discountCodes(ctx.actor)),
      ),
      addDiscountCode: implement(c.addDiscountCode).handler(async ({ input }) =>
        serialize(await this.pricing.addDiscountCode(ctx.actor, input)),
      ),
      whatsappRates: implement(c.whatsappRates).handler(async () =>
        serialize(await this.pricing.whatsappRates(ctx.actor)),
      ),
      addWhatsappRate: implement(c.addWhatsappRate).handler(async ({ input }) =>
        serialize(await this.pricing.addWhatsappRate(ctx.actor, input)),
      ),
      usage: implement(c.usage).handler(async ({ input }) =>
        serialize(await this.usage.usage(ctx.actor, input.month)),
      ),
      health: implement(c.health).handler(async () =>
        serialize(await this.health.health(ctx.actor)),
      ),
      supportGrants: implement(c.supportGrants).handler(async ({ input }) =>
        serialize(await this.support.grantsAcrossCompanies(ctx.actor, input.activeOnly ?? false)),
      ),
      supportOverview: implement(c.supportOverview).handler(async ({ input }) =>
        serialize(await this.support.overview(ctx.actor, input.companyId, ctx.requestId)),
      ),
    };
  }
}
