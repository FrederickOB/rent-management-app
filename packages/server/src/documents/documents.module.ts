import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RulesModule } from '../rules/rules.module';
import { DocumentsService } from './documents.service';

@Module({
  imports: [AuditModule, RulesModule],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
