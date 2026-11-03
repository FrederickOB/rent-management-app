import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { DocumentsModule } from '../documents/documents.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PolicyModule } from '../policy/policy.module';
import { RulesModule } from '../rules/rules.module';
import { BillingReadService } from './billing-read.service';
import { BillingEngine } from './engine';
import { InvoicingService } from './invoicing.service';
import { MoneyService } from './money.service';
import { SubledgerCheckService } from './subledger-check.service';

const SERVICES = [
  BillingEngine,
  InvoicingService,
  MoneyService,
  BillingReadService,
  SubledgerCheckService,
];

/**
 * Billing (BC-01, BC-05, BC-07, BC-08, BC-11, AR-01 to AR-03, CT-04; architecture section 2,
 * layer 5): invoices, accrual, allocation, payments and receipts, cash and banking, corrections,
 * arrears, paid-until and the sub-ledger check. It reads leases through tenancy's helpers and
 * posts only through the ledger's posting service.
 */
@Module({
  imports: [ApprovalsModule, AuditModule, DocumentsModule, LedgerModule, PolicyModule, RulesModule],
  providers: SERVICES,
  exports: SERVICES,
})
export class BillingModule implements OnModuleInit {
  constructor(@Inject(MoneyService) private readonly money: MoneyService) {}

  /** Cash, transfers, banking and every correction are two-person actions (decision 3). */
  onModuleInit(): void {
    this.money.registerApprovals();
  }
}
