import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { PolicyModule } from '../policy/policy.module';
import { RulesModule } from '../rules/rules.module';
import { SubscriptionCoreModule } from '../subscription/core.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { PlatformCompaniesService } from './companies.service';
import { SystemHealthService } from './health.service';
import { PlatformPricingService } from './pricing.service';
import { RulesConsoleService } from './rules-console.service';
import { SupportAccessService } from './support.service';
import { UsageService } from './usage.service';

/**
 * The platform admin console (M10 plan 4.1, layer 8; AD-10): support access under a company's
 * grant, companies and onboarding, prices, terms, discount codes and WhatsApp rates, usage and
 * messaging costs, system health and the rules screen. Every route is for platform admins only,
 * through PolicyService, except the company side of support access (`support.grant`).
 */
@Module({
  imports: [
    AuditModule,
    IdentityModule,
    PolicyModule,
    RulesModule,
    SubscriptionCoreModule,
    SubscriptionModule,
  ],
  providers: [
    SupportAccessService,
    PlatformPricingService,
    UsageService,
    SystemHealthService,
    RulesConsoleService,
    PlatformCompaniesService,
  ],
  exports: [
    SupportAccessService,
    PlatformPricingService,
    UsageService,
    SystemHealthService,
    RulesConsoleService,
    PlatformCompaniesService,
  ],
})
export class AdminModule {}
