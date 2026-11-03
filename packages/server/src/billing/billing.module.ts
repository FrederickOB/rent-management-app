import { Inject, Module, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { DocumentsModule } from '../documents/documents.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PolicyModule } from '../policy/policy.module';
import { RulesModule } from '../rules/rules.module';
import { AdvanceService } from './advance.service';
import { BillingReadService } from './billing-read.service';
import { BillingEngine } from './engine';
import { InvoicingService } from './invoicing.service';
import { MoneyService } from './money.service';
import { SubledgerCheckService } from './subledger-check.service';
import { TerminationService } from './termination.service';

const SERVICES = [
  BillingEngine,
  InvoicingService,
  MoneyService,
  BillingReadService,
  SubledgerCheckService,
  // M5: early termination (AR-04), and advance rent and the paid-until prompt (AR-05, AR-06).
  TerminationService,
  AdvanceService,
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
export class BillingModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    @Inject(MoneyService) private readonly money: MoneyService,
    @Inject(TerminationService) private readonly termination: TerminationService,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
  ) {}

  /**
   * M5 review 7: billing never runs without rent tax. The tax module registers its hooks with the
   * engine as it starts; an app that loads billing without it would post receipts with no tax
   * assessed and nobody told, so it refuses to start instead.
   */
  onApplicationBootstrap(): void {
    assertTaxHooks(this.engine);
  }

  /**
   * Cash, transfers, banking and every correction are two-person actions (decision 3), and so is
   * an early termination's refund (M5 decision 6).
   */
  onModuleInit(): void {
    this.money.registerApprovals();
    this.termination.registerApprovals();
  }
}

/** Throws unless the tax module registered its hooks with the billing engine (review 7). */
export function assertTaxHooks(engine: Pick<BillingEngine, 'taxHooksRegistered'>): void {
  if (!engine.taxHooksRegistered)
    throw new Error(
      'Billing needs rent tax: import TaxModule wherever BillingModule is used, so every receipt is assessed (M5 review 7)',
    );
}
