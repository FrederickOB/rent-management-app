import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ORPCModule } from '@orpc/nest';
import { ApprovalsModule } from '@rent/server/approvals';
import { AuditModule } from '@rent/server/audit';
import { CompaniesModule } from '@rent/server/companies';
import { CoreModule, type CoreOptions } from '@rent/server/core';
import { DocumentsModule } from '@rent/server/documents';
import { EsignModule } from '@rent/server/esign';
import { IdentityModule } from '@rent/server/identity';
import { MessagingModule } from '@rent/server/messaging';
import { PolicyModule } from '@rent/server/policy';
import { PortfolioModule } from '@rent/server/portfolio';
import { RulesModule } from '@rent/server/rules';
import { TenancyModule } from '@rent/server/tenancy';
import { CompanyController } from './company/company.controller';
import { GovernanceController } from './governance/governance.controller';
import { toORPCError } from './http/errors';
import { ActorGuard, PermissionGuard } from './http/guards';
import { HealthController } from './health/health.controller';
import { LinksController } from './links/links.controller';
import { OpenApiController } from './health/openapi.controller';
import { MeController } from './me/me.controller';
import { RegisterController } from './register/register.controller';
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
        MessagingModule,
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
      ],
      providers: [
        { provide: APP_GUARD, useClass: ActorGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
      ],
    };
  }
}
