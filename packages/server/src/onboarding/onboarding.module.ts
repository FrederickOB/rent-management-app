import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { BillingModule } from '../billing/billing.module';
import { DocumentsModule } from '../documents/documents.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PolicyModule } from '../policy/policy.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { RulesModule } from '../rules/rules.module';
import { TaxModule } from '../tax/tax.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { OnboardingService } from './onboarding.service';

/**
 * Pilot onboarding (M11 decisions 2 and 3; P25): the register's Owners sheet is the portfolio
 * module's; tenancies, opening balances and their adjustment, the cut-over and the scans that
 * follow are this module's. Tax is imported so billing never posts without its hooks (M5 review 7);
 * opening money itself posts no rent tax and no fee (OQ-64).
 */
@Module({
  imports: [
    ApprovalsModule,
    BillingModule,
    DocumentsModule,
    LedgerModule,
    PolicyModule,
    PortfolioModule,
    RulesModule,
    TaxModule,
    TenancyModule,
  ],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
