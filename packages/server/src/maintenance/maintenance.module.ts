import { Module } from '@nestjs/common';
import { CompaniesModule } from '../companies/companies.module';
import { DocumentsModule } from '../documents/documents.module';
import { PolicyModule } from '../policy/policy.module';
import { MaintenanceService } from './maintenance.service';

/** The maintenance stub (M6 decision 12; architecture section 2, layer 6). M8 grows it. */
@Module({
  imports: [CompaniesModule, DocumentsModule, PolicyModule],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
