import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { BillingModule } from '../billing/billing.module';
import { TerminationService } from '../billing/termination.service';
import { CompaniesModule } from '../companies/companies.module';
import { DocumentsModule } from '../documents/documents.module';
import { EsignModule } from '../esign/esign.module';
import { InspectionsService } from '../maintenance/inspections.service';
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { PolicyModule } from '../policy/policy.module';
import { TaxModule } from '../tax/tax.module';
import { LeaseLifecycleService } from '../tenancy/lease-lifecycle.service';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantAppService } from '../tenancy/tenant-app.service';
import { MoveInReportService } from './move-in-report.service';
import { MoveOutService } from './moveout.service';

/**
 * Move-in reports and the move-out settlement (architecture section 2, layer 7; M8 decision 13).
 * It registers at start: the settlement's approval, the move-in report reader, the documents a
 * tenant may download (the signed move-in report and the final statement, TL-08 and TL-11), and the
 * guard that keeps M3's quick move-out off a lease with a live move-out (M8 review).
 */
@Module({
  imports: [
    ApprovalsModule,
    BillingModule,
    CompaniesModule,
    DocumentsModule,
    EsignModule,
    MaintenanceModule,
    PolicyModule,
    TaxModule,
    TenancyModule,
  ],
  providers: [MoveOutService, MoveInReportService],
  exports: [MoveOutService, MoveInReportService],
})
export class MoveOutModule implements OnModuleInit {
  constructor(
    @Inject(MoveOutService) private readonly moveOuts: MoveOutService,
    @Inject(MoveInReportService) private readonly reports: MoveInReportService,
    @Inject(InspectionsService) private readonly inspections: InspectionsService,
    @Inject(TenantAppService) private readonly tenantApp: TenantAppService,
    @Inject(LeaseLifecycleService) private readonly lifecycle: LeaseLifecycleService,
    @Inject(TerminationService) private readonly terminations: TerminationService,
  ) {}

  onModuleInit(): void {
    this.moveOuts.registerApprovals();
    this.inspections.useMoveInReports((tx, inspectionId) =>
      this.reports.forInspection(tx, inspectionId),
    );
    this.tenantApp.useDocumentOwner((tx, documentId) => this.reports.tenantOwns(tx, documentId));
    this.lifecycle.useMoveOutGuard((tx, leaseId) => this.moveOuts.liveFor(tx, leaseId));
    this.terminations.useMoveOutGuard((tx, leaseId) => this.moveOuts.existsFor(tx, leaseId));
  }
}
