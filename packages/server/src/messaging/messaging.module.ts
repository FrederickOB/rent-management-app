import { Module } from '@nestjs/common';
import { EsignModule } from '../esign/esign.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { MessagingService } from './messaging.service';

/**
 * The outbound messaging core (M3 decision 1; architecture section 2, layer 7): messages,
 * consent checks and the send job, for SMS and email. WhatsApp, push and the inbox follow in M6.
 * The e-signing phase registers its signer recipients and signing links with MessagingService.
 */
@Module({
  imports: [EsignModule, TenancyModule],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
