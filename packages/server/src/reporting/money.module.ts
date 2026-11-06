import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { BillingModule } from '../billing/billing.module';
import { CompaniesModule } from '../companies/companies.module';
import { DocumentsModule } from '../documents/documents.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PolicyModule } from '../policy/policy.module';
import { TaxModule } from '../tax/tax.module';
import { ManagementFeesService } from './fees.service';
import { OwnerMoneyService } from './owner-money.service';

const SERVICES = [ManagementFeesService, OwnerMoneyService];

/**
 * The money side of reporting (M9 build steps 2 and 4; AC-02, AC-05; decisions 1 to 3 and 8):
 * management fees through billing's fee hooks, the monthly fixed fees and the nightly fee check,
 * fee terms and their approval, and remittances, fees taken and owner funding. Every posting goes
 * through the posting service. Both apps import it, so billing never settles money without its fee
 * hooks; tax is imported for the same reason (M5 review 7).
 */
@Module({
  imports: [
    ApprovalsModule,
    BillingModule,
    TaxModule,
    CompaniesModule,
    DocumentsModule,
    LedgerModule,
    PolicyModule,
  ],
  providers: SERVICES,
  exports: SERVICES,
})
export class ReportingMoneyModule {}
