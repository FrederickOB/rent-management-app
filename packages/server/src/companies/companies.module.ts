import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DocumentsModule } from '../documents/documents.module';
import { IdentityModule } from '../identity/identity.module';
import { PolicyModule } from '../policy/policy.module';
import { CompaniesService } from './companies.service';
import { MembershipsService } from './memberships.service';

@Module({
  imports: [AuditModule, DocumentsModule, IdentityModule, PolicyModule],
  providers: [CompaniesService, MembershipsService],
  exports: [CompaniesService, MembershipsService],
})
export class CompaniesModule {}
