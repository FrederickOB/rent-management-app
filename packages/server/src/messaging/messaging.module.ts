import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { CompaniesModule } from '../companies/companies.module';
import { DocumentsModule } from '../documents/documents.module';
import { EsignModule } from '../esign/esign.module';
import { EsignService } from '../esign/esign.service';
import { ArtisansService } from '../maintenance/artisans.service';
import { JobSheetService } from '../maintenance/job-sheet.service';
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { PolicyModule } from '../policy/policy.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantsService } from '../tenancy/tenants.service';
import { BotService } from './bot.service';
import { BroadcastsService } from './broadcasts.service';
import { MessagingConsentService } from './consent.service';
import { InboundService } from './inbound.service';
import { InboxStreamService } from './inbox-stream.service';
import { InboxService } from './inbox.service';
import { registerMaintenanceRecipients } from './maintenance-recipients';
import { MessagingService } from './messaging.service';
import { MessagingOperationsService } from './operations.service';
import { MessagingSettingsService } from './settings.service';
import { registerSigningRecipients } from './signing-recipients';
import { TemplatesService } from './templates.service';
import { TenantMessagingService } from './tenant-messaging.service';
import { registerMessageTimeline } from './timeline';

const SERVICES = [
  MessagingService,
  TemplatesService,
  BotService,
  InboundService,
  InboxService,
  BroadcastsService,
  MessagingConsentService,
  MessagingSettingsService,
  TenantMessagingService,
  MessagingOperationsService,
  InboxStreamService,
];

/**
 * Messaging (M3 decision 1; M6; architecture section 2, layer 7): the outbound core and its send
 * job on push, WhatsApp, SMS and email; the inbound pipeline and the bot; the unified inbox and
 * its live stream; broadcasts, groups, templates, consent and the tenant app's conversations.
 * Signers and their links come from the e-signing engine, and the tenant timeline gets the
 * messages, both registered here at start-up.
 */
@Module({
  imports: [
    AuditModule,
    EsignModule,
    TenancyModule,
    DocumentsModule,
    CompaniesModule,
    PolicyModule,
    MaintenanceModule,
    BillingModule,
  ],
  providers: SERVICES,
  exports: SERVICES,
})
export class MessagingModule implements OnModuleInit {
  constructor(
    @Inject(MessagingService) private readonly messaging: MessagingService,
    @Inject(EsignService) private readonly esign: EsignService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(ArtisansService) private readonly artisans: ArtisansService,
    @Inject(JobSheetService) private readonly sheets: JobSheetService,
  ) {}

  onModuleInit(): void {
    registerSigningRecipients(this.messaging, this.esign, this.tenants);
    registerMessageTimeline(this.tenants, this.messaging);
    // M8: staff WhatsApp for emergency alerts, artisans, and job-sheet links.
    registerMaintenanceRecipients(this.messaging, this.artisans, this.sheets);
  }
}
