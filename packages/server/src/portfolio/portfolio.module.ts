import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { OwnersModule } from '../companies/owners.module';
import { DocumentsModule } from '../documents/documents.module';
import { PolicyModule } from '../policy/policy.module';
import { RulesModule } from '../rules/rules.module';
import { MetersService } from './meters.service';
import { PropertyFilesService } from './property-files.service';
import { RegisterImportService } from './register-import.service';
import { RegisterReadService } from './register-read.service';
import { RegisterService } from './register.service';

/** The property register (PR-01 to PR-10, PB-01; architecture section 2, layer 3). */
@Module({
  imports: [AuditModule, DocumentsModule, OwnersModule, PolicyModule, RulesModule],
  providers: [
    RegisterService,
    RegisterReadService,
    MetersService,
    PropertyFilesService,
    RegisterImportService,
  ],
  exports: [
    RegisterService,
    RegisterReadService,
    MetersService,
    PropertyFilesService,
    RegisterImportService,
  ],
})
export class PortfolioModule {}
