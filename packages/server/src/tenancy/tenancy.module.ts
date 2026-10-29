import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { DocumentsModule } from '../documents/documents.module';
import { EsignModule } from '../esign/esign.module';
import { PolicyModule } from '../policy/policy.module';
import { RulesModule } from '../rules/rules.module';
import { IdChecksService } from './id-checks.service';
import { LeaseDocumentsService } from './lease-documents.service';
import { LeaseLifecycleService } from './lease-lifecycle.service';
import { LeaseTemplatesService } from './lease-templates.service';
import { LeasesService } from './leases.service';
import { TenancyRemindersService } from './tenancy-reminders.service';
import { TenantAppService } from './tenant-app.service';
import { TenantsService } from './tenants.service';

const SERVICES = [
  TenantsService,
  IdChecksService,
  LeaseTemplatesService,
  LeaseDocumentsService,
  LeaseLifecycleService,
  LeasesService,
  TenancyRemindersService,
  TenantAppService,
];

/**
 * Tenancy (TL-01 to TL-09, PB-09, TX-05, AR-05 check; architecture section 2, layer 4): tenants,
 * ID checks, templates, leases, the schedule, occupancy, renewals and the trackers.
 */
@Module({
  imports: [ApprovalsModule, AuditModule, DocumentsModule, EsignModule, PolicyModule, RulesModule],
  providers: SERVICES,
  exports: SERVICES,
})
export class TenancyModule implements OnModuleInit {
  constructor(@Inject(LeasesService) private readonly leases: LeasesService) {}

  /** Cancelling a signed lease is a two-person action (decision 6). */
  onModuleInit(): void {
    this.leases.registerApprovals();
  }
}
