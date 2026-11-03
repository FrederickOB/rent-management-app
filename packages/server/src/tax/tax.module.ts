import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { DocumentsModule } from '../documents/documents.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PolicyModule } from '../policy/policy.module';
import { RulesModule } from '../rules/rules.module';
import { GraService } from './gra.service';
import { RentTaxService } from './rent-tax.service';
import { TaxAlertsService } from './tax-alerts.service';
import { TaxAssessmentService } from './tax-assessment.service';
import { TaxReportService } from './tax-report.service';
import { WithholdingService } from './withholding.service';

const SERVICES = [
  RentTaxService,
  WithholdingService,
  GraService,
  TaxReportService,
  TaxAlertsService,
  // Review 7: rent tax not assessed when the money posted, assessed once the rules allow.
  TaxAssessmentService,
];

/**
 * Tax (TX-01 to TX-04, TX-08; M5; architecture section 2, layer 6): rent tax per receipt, the due
 * tracker and its alerts, withholding and certificates, GRA payments, the rent tax report and VAT
 * returns. It sits above billing: it registers its rent tax hooks with billing's engine when it
 * starts, so every receipt, reversal and carry-over is taxed in its own posting transaction.
 */
@Module({
  imports: [
    ApprovalsModule,
    AuditModule,
    BillingModule,
    DocumentsModule,
    LedgerModule,
    PolicyModule,
    RulesModule,
  ],
  providers: SERVICES,
  exports: SERVICES,
})
export class TaxModule implements OnModuleInit {
  constructor(
    @Inject(RentTaxService) readonly rentTax: RentTaxService,
    @Inject(WithholdingService) private readonly withholding: WithholdingService,
  ) {}

  /** The withholding write-off is a two-person action (P24). */
  onModuleInit(): void {
    this.withholding.registerApprovals();
  }
}
