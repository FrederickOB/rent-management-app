import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { DocumentsModule } from '../documents/documents.module';
import { IdentityModule } from '../identity/identity.module';
import { PolicyModule } from '../policy/policy.module';
import { CompaniesService } from './companies.service';
import { EntitlementsService } from './entitlements.service';
import { MembershipsService } from './memberships.service';
import { OwnersModule } from './owners.module';

@Module({
  // ApprovalsModule: approver-widening membership changes go to approval (M11, founder D1).
  imports: [
    AuditModule,
    ApprovalsModule,
    DocumentsModule,
    IdentityModule,
    OwnersModule,
    PolicyModule,
  ],
  providers: [CompaniesService, EntitlementsService, MembershipsService],
  exports: [CompaniesService, EntitlementsService, MembershipsService, OwnersModule],
})
export class CompaniesModule {}
