import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { EsignModule } from '../esign/esign.module';
import { EsignService } from '../esign/esign.service';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantsService } from '../tenancy/tenants.service';
import { MessagingService } from './messaging.service';
import { registerSigningRecipients } from './signing-recipients';

/**
 * The outbound messaging core (M3 decision 1; architecture section 2, layer 7): messages,
 * consent checks and the send job, for SMS and email. WhatsApp, push and the inbox follow in M6.
 * Signers and their links come from the e-signing engine, registered here at start-up.
 */
@Module({
  imports: [EsignModule, TenancyModule],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule implements OnModuleInit {
  constructor(
    @Inject(MessagingService) private readonly messaging: MessagingService,
    @Inject(EsignService) private readonly esign: EsignService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
  ) {}

  onModuleInit(): void {
    registerSigningRecipients(this.messaging, this.esign, this.tenants);
  }
}
