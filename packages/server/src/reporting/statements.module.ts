import { Module } from '@nestjs/common';
import { CompaniesModule } from '../companies/companies.module';
import { DocumentsModule } from '../documents/documents.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PolicyModule } from '../policy/policy.module';
import { OwnerStatementsService } from './statements.service';

/**
 * Owner statements (M9 build step 3; AC-04; decisions 5 to 7 and 15): drafts worked out from the
 * ledger, issue with its period lock and PDF, the email once rendered, and the monthly drafting
 * job. It reads the ledger and its sub-ledgers directly, never the dashboard's snapshot (decision
 * 11), and writes only statements, their frozen figures and the lock (through the posting
 * service).
 */
@Module({
  imports: [CompaniesModule, DocumentsModule, LedgerModule, PolicyModule],
  providers: [OwnerStatementsService],
  exports: [OwnerStatementsService],
})
export class ReportingStatementsModule {}
