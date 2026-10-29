import { Module } from '@nestjs/common';
import { sql, withCompany, withSystem, type Database } from '@rent/db';
import type { EmailPort, SmsPort } from '@rent/integrations';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import type { AppLogger } from '../core/logging/logger';
import { AUTH, CLOCK, CONFIG, DATABASE, EMAIL_PORT, LOGGER, SMS_PORT } from '../core/tokens';
import { createAuth } from './auth';
import { IdentityService } from './identity.service';
import { MembershipDirectory } from './memberships';
import { PersonAccounts } from './person-accounts';
import { StepUpVerifier } from './step-up';

/**
 * Records each completed sign-in (AD-07) in the chain of every company where the person works,
 * or in the platform company's chain if they work nowhere yet (for example a new tenant).
 */
function signInAuditor(database: Database, audit: AuditService, memberships: MembershipDirectory) {
  return async ({
    personId,
    sessionId,
    authMethod,
  }: {
    personId: string;
    sessionId: string;
    authMethod: string;
  }) => {
    if (authMethod !== 'password_totp' && authMethod !== 'phone_otp') return; // intermediate sessions
    let companies = (await memberships.forPerson(personId))
      .filter((m) => m.status === 'active')
      .map((m) => m.companyId);
    if (companies.length === 0) {
      const result = await withSystem(database, { personId }, (tx) =>
        tx.execute<{ id: string | null }>(sql`select app.platform_company_id() as id`),
      );
      const platform = result.rows[0]?.id;
      companies = platform ? [platform] : [];
    }
    for (const companyId of companies) {
      await withCompany(database, { companyId, personId, actorKind: 'system' }, (tx) =>
        audit.append(tx, {
          companyId,
          action: 'auth.signed_in',
          recordType: 'session',
          recordId: sessionId,
          data: { authMethod },
        }),
      );
    }
  };
}

@Module({
  imports: [AuditModule],
  providers: [
    {
      provide: AUTH,
      inject: [DATABASE, CONFIG, SMS_PORT, EMAIL_PORT, CLOCK, LOGGER, AuditService],
      useFactory: (
        database: Database,
        config: AppConfig,
        sms: SmsPort,
        email: EmailPort,
        clock: Clock,
        logger: AppLogger,
        audit: AuditService,
      ) => {
        const memberships = new MembershipDirectory(database);
        return createAuth({
          database,
          config,
          sms,
          email,
          clock,
          logger,
          memberships,
          onSignedIn: signInAuditor(database, audit, memberships),
        });
      },
    },
    IdentityService,
    PersonAccounts,
    StepUpVerifier,
  ],
  exports: [AUTH, IdentityService, PersonAccounts, StepUpVerifier],
})
export class IdentityModule {}
