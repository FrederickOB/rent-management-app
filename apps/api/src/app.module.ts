import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ORPCModule } from '@orpc/nest';
import { ApprovalsModule } from '@rent/server/approvals';
import { BillingModule } from '@rent/server/billing';
import { AuditModule } from '@rent/server/audit';
import { CompaniesModule } from '@rent/server/companies';
import { CoreModule, type CoreOptions } from '@rent/server/core';
import { DocumentsModule } from '@rent/server/documents';
import { EsignModule } from '@rent/server/esign';
import { IdentityModule } from '@rent/server/identity';
import { LedgerModule } from '@rent/server/ledger';
import { MaintenanceModule } from '@rent/server/maintenance';
import { MessagingModule } from '@rent/server/messaging';
import { NoticesModule } from '@rent/server/notices';
import { PaymentsModule } from '@rent/server/payments';
import { PolicyModule } from '@rent/server/policy';
import { PortfolioModule } from '@rent/server/portfolio';
import { RulesModule } from '@rent/server/rules';
import { TasksModule } from '@rent/server/tasks';
import { TaxModule } from '@rent/server/tax';
import { TenancyModule } from '@rent/server/tenancy';
import { AdvanceController } from './billing/advance.controller';
import { BillingController } from './billing/billing.controller';
import { CompanyController } from './company/company.controller';
import { GovernanceController } from './governance/governance.controller';
import { toORPCError } from './http/errors';
import { ActorGuard, PermissionGuard } from './http/guards';
import { HealthController } from './health/health.controller';
import { LinksController } from './links/links.controller';
import { OpenApiController } from './health/openapi.controller';
import { MeController } from './me/me.controller';
import { InboxStreamController } from './messaging/inbox-stream.controller';
import {
  BroadcastsController,
  InboxController,
  MaintenanceController,
  MessagingConsentController,
  MessagingSettingsController,
  TenantMessagingController,
  UnsubscribeLinksController,
} from './messaging/messaging.controller';
import { MessagingWebhooksController } from './messaging/messaging-webhooks.controller';
import {
  NoticesController,
  QuitAcknowledgementController,
  RentAssessmentsController,
  TasksController,
} from './notices/notices.controller';
import { PayLinksController } from './payments/pay-links.controller';
import { PaymentsController } from './payments/payments.controller';
import { WebhooksController } from './payments/webhooks.controller';
import { RegisterController } from './register/register.controller';
import { TaxController } from './tax/tax.controller';
import {
  SigningRequestsController,
  TenancyController,
  TenantAppController,
} from './tenancy/tenancy.controller';

@Module({})
export class AppModule {
  static forRoot(core: CoreOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(core),
        IdentityModule,
        PolicyModule,
        AuditModule,
        RulesModule,
        DocumentsModule,
        CompaniesModule,
        ApprovalsModule,
        PortfolioModule,
        EsignModule,
        TenancyModule,
        MaintenanceModule,
        MessagingModule,
        LedgerModule,
        BillingModule,
        PaymentsModule,
        TaxModule,
        // M7: staff tasks and legal notices.
        TasksModule,
        NoticesModule,
        ORPCModule.forRoot({
          interceptors: [
            async ({ next }) => {
              try {
                return await next();
              } catch (error) {
                throw toORPCError(error);
              }
            },
          ],
        }),
      ],
      controllers: [
        HealthController,
        OpenApiController,
        MeController,
        CompanyController,
        GovernanceController,
        RegisterController,
        TenancyController,
        TenantAppController,
        SigningRequestsController,
        LinksController,
        BillingController,
        PaymentsController,
        PayLinksController,
        // Before the payments webhooks' `/webhooks/:provider`, which would otherwise match them.
        MessagingWebhooksController,
        WebhooksController,
        TaxController,
        AdvanceController,
        // M6 messaging.
        InboxController,
        InboxStreamController,
        MessagingConsentController,
        BroadcastsController,
        MessagingSettingsController,
        TenantMessagingController,
        UnsubscribeLinksController,
        MaintenanceController,
        // M7 notices, the OQ-16 acknowledgement, Rent Officer assessments and tasks.
        NoticesController,
        QuitAcknowledgementController,
        RentAssessmentsController,
        TasksController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: ActorGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
      ],
    };
  }
}
