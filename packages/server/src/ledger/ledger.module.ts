import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AgentCashCheckService } from './agent-cash-check.service';
import { PostingService } from './posting.service';

/**
 * The ledger (AC-01; architecture section 2, layer 1): books, the chart of accounts, the journal,
 * the posting service, period locks and balance queries. The posting service is the only code
 * that writes journal rows (lint rule rent/ledger-writes). M9 (F3): the nightly agent cash check.
 */
@Module({
  imports: [AuditModule],
  providers: [PostingService, AgentCashCheckService],
  exports: [PostingService, AgentCashCheckService],
})
export class LedgerModule {}
