import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { RulesModule } from '../rules/rules.module';
import { SubscriptionCoreService } from './core.service';

/**
 * The subscription engine's core (M10): the subscription, its status and access, the catalogue
 * and the numbering. The billing, paying, lifecycle and console modules build on it.
 */
@Module({
  imports: [AuditModule, LedgerModule, RulesModule],
  providers: [SubscriptionCoreService],
  exports: [SubscriptionCoreService, AuditModule, LedgerModule, RulesModule],
})
export class SubscriptionCoreModule {}
