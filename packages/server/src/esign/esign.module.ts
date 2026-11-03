import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DocumentsModule } from '../documents/documents.module';
import { EsignService } from './esign.service';
import { SigningPageService } from './signing-page.service';

/**
 * The e-signature engine (TL-07; M3 plan 4.8; architecture section 2, layer 2): signing
 * requests, signers, secure links, one-time codes, evidence, certificate pages and finalisation.
 * Modules above it call EsignService; the links API calls SigningPageService.
 */
@Module({
  imports: [AuditModule, DocumentsModule],
  providers: [EsignService, SigningPageService],
  exports: [EsignService, SigningPageService],
})
export class EsignModule {}
