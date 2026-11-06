import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DocumentsModule } from '../documents/documents.module';
import { IdentityModule } from '../identity/identity.module';
import { PolicyModule } from '../policy/policy.module';
import { CompaniesService } from './companies.service';
import { EntitlementsService } from './entitlements.service';
import { MembershipsService } from './memberships.service';
import { OwnersModule } from './owners.module';

@Module({
  imports: [AuditModule, DocumentsModule, IdentityModule, OwnersModule, PolicyModule],
  providers: [CompaniesService, EntitlementsService, MembershipsService],
  exports: [CompaniesService, EntitlementsService, MembershipsService, OwnersModule],
})
export class CompaniesModule {}
