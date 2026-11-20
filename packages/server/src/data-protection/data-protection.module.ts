import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DocumentsModule } from '../documents/documents.module';
import { PolicyModule } from '../policy/policy.module';
import { RulesModule } from '../rules/rules.module';
import { DataProtectionService } from './data-protection.service';
import { RetentionReviewService } from './retention-review.service';

const SERVICES = [DataProtectionService, RetentionReviewService];

/**
 * Data protection requests under Act 843 (M11 decision 5; NFR-DP): the request register, the
 * tenant's export, erasure limited by retention, and the nightly retention review. Messaging's
 * send job refuses anything for a tenant whose erasure request stopped it (CM-09).
 */
@Module({
  imports: [PolicyModule, RulesModule, DocumentsModule, AuditModule],
  providers: SERVICES,
  exports: SERVICES,
})
export class DataProtectionModule {}
