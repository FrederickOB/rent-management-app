import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DocumentsModule } from '../documents/documents.module';

/**
 * The e-signature engine (TL-07; M3 plan 4.8; architecture section 2, layer 2). Its tables are
 * in place (migration 0006 and 0007); the signing requests, links, codes, evidence and
 * finalisation arrive in the e-signing phase, which fills this module.
 */
@Module({
  imports: [AuditModule, DocumentsModule],
  providers: [],
  exports: [],
})
export class EsignModule {}
