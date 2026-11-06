import { Module } from '@nestjs/common';
import { CompaniesModule } from '../companies/companies.module';
import { DocumentsModule } from '../documents/documents.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PolicyModule } from '../policy/policy.module';
import { TasksModule } from '../tasks/tasks.module';
import { ArtisansService } from './artisans.service';
import { ExpensesService } from './expenses.service';
import { InspectionsService } from './inspections.service';
import { JobSheetService } from './job-sheet.service';
import { MaintenanceService } from './maintenance.service';
import { TenantRepairsService } from './tenant-repairs.service';

/**
 * Maintenance (architecture section 2, layer 6; M8 decision 13): jobs and their machine, artisans
 * and their job sheets, inspections and their templates, and expenses. In-house work is a task;
 * expenses post through the ledger (P15); messages go through the core outbox.
 */
@Module({
  imports: [CompaniesModule, DocumentsModule, PolicyModule, TasksModule, LedgerModule],
  providers: [
    MaintenanceService,
    ArtisansService,
    JobSheetService,
    TenantRepairsService,
    ExpensesService,
    InspectionsService,
  ],
  exports: [
    MaintenanceService,
    ArtisansService,
    JobSheetService,
    TenantRepairsService,
    ExpensesService,
    InspectionsService,
  ],
})
export class MaintenanceModule {}
