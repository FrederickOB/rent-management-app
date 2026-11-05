import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { BillingModule } from '../billing/billing.module';
import { CompaniesModule } from '../companies/companies.module';
import { DocumentsModule } from '../documents/documents.module';
import { EsignModule } from '../esign/esign.module';
import { InspectionsService } from '../maintenance/inspections.service';
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { PolicyModule } from '../policy/policy.module';
import { TaxModule } from '../tax/tax.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantAppService } from '../tenancy/tenant-app.service';
import { MoveInReportService } from './move-in-report.service';
import { MoveOutService } from './moveout.service';

/**
 * Move-in reports and the move-out settlement (architecture section 2, layer 7; M8 decision 13).
 * It registers the settlement's approval and the move-in report reader at start.
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
  ) {}

  onModuleInit(): void {
    this.moveOuts.registerApprovals();
    this.inspections.useMoveInReports((tx, inspectionId) =>
      this.reports.forInspection(tx, inspectionId),
    );
  }
}
