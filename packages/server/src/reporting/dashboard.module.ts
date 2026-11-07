import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { CompaniesModule } from '../companies/companies.module';
import { DocumentsModule } from '../documents/documents.module';
import { PolicyModule } from '../policy/policy.module';
import { TaxModule } from '../tax/tax.module';
import { ComplianceService } from './compliance.service';
import { DashboardService } from './dashboard.service';
import { Gate1Service } from './gate1.service';
import { ReportingRollupService } from './rollup.service';

const SERVICES = [Gate1Service, ReportingRollupService, DashboardService, ComplianceService];

/**
 * The dashboard side of reporting (M9 build steps 5 and 6; decisions 9 to 14): the daily rollup
 * and its snapshot, the dashboard and its exports, the Gate 1 metrics per company and across
 * companies, and the compliance list. It reads billing's engine walk and the ledger, renders
 * through the documents service, and posts nothing. Tax is imported so billing never runs without
 * its rent tax hooks (M5 review 7).
 */
@Module({
  imports: [BillingModule, TaxModule, CompaniesModule, DocumentsModule, PolicyModule],
  providers: SERVICES,
  exports: SERVICES,
})
export class ReportingDashboardModule {}
