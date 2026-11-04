import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { CompaniesModule } from '../companies/companies.module';
import { DocumentsModule } from '../documents/documents.module';
import { EsignModule } from '../esign/esign.module';
import { PolicyModule } from '../policy/policy.module';
import { RulesModule } from '../rules/rules.module';
import { TasksModule } from '../tasks/tasks.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { NoticeAcknowledgementsService } from './acknowledgements.service';
import { NoticesService } from './notices.service';
import { TenantNoticesService } from './tenant-notices.service';
import { NoticeTrackingService } from './tracking.service';

const SERVICES = [
  NoticesService,
  NoticeTrackingService,
  NoticeAcknowledgementsService,
  TenantNoticesService,
];

/**
 * Legal notices (M7 plan 4.1; architecture section 2, layer 6): templates, the composer, effective
 * dates, issue, tracking, the ladder, escalation, service records, closure and corrections. Notices
 * sign on the e-sign engine (no second engine), queue messages through core, and make tasks.
 * Starting up registers the approval handlers, the signing page's notice facts, the task lists'
 * notice names and the tenant timeline's notice events.
 */
@Module({
  imports: [
    ApprovalsModule,
    AuditModule,
    BillingModule,
    CompaniesModule,
    DocumentsModule,
    EsignModule,
    PolicyModule,
    RulesModule,
    TasksModule,
    TenancyModule,
  ],
  providers: SERVICES,
  exports: SERVICES,
})
export class NoticesModule {}
