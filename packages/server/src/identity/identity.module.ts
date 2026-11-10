import { Module } from '@nestjs/common';
import { sql, withCompany, withSystem, type Database } from '@rent/db';
import type { AlertPort, EmailPort, SmsPort } from '@rent/integrations';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import type { AppLogger } from '../core/logging/logger';
import {
  ALERT_PORT,
  AUTH,
  CLOCK,
  CONFIG,
  DATABASE,
  EMAIL_PORT,
  LOGGER,
  SMS_PORT,
} from '../core/tokens';
import { AccountRecoveryService } from './account-recovery';
import { createAuth, type AuthAuditEvent } from './auth';
import { IdentityService } from './identity.service';
import { MembershipDirectory } from './memberships';
import { PersonAccounts } from './person-accounts';
import { StepUpVerifier } from './step-up';

/** The chains a person's account events go in: every company they work in, else the platform's. */
async function chainsFor(
  database: Database,
  memberships: MembershipDirectory,
  personId: string,
): Promise<string[]> {
  const companies = (await memberships.forPerson(personId))
    .filter((m) => m.status === 'active')
    .map((m) => m.companyId);
  if (companies.length > 0) return [...new Set(companies)];
  const result = await withSystem(database, { personId }, (tx) =>
    tx.execute<{ id: string | null }>(sql`select app.platform_company_id() as id`),
  );
  const platform = result.rows[0]?.id;
  return platform ? [platform] : [];
}

/**
 * Records each completed sign-in (AD-07) in the chain of every company where the person works,
 * or in the platform company's chain if they work nowhere yet (for example a new tenant). M11
 * review R1 F5: with a keyed hash of the address and the user agent.
 */
function signInAuditor(database: Database, audit: AuditService, memberships: MembershipDirectory) {
  return async ({
    personId,
    sessionId,
    authMethod,
    ipHash,
    userAgent,
  }: {
    personId: string;
    sessionId: string;
    authMethod: string;
    ipHash?: string | null;
    userAgent?: string | null;
  }) => {
    if (authMethod !== 'password_totp' && authMethod !== 'phone_otp') return; // intermediate sessions
    for (const companyId of await chainsFor(database, memberships, personId)) {
      await withCompany(database, { companyId, personId, actorKind: 'system' }, (tx) =>
        audit.append(tx, {
          companyId,
          action: 'auth.signed_in',
          recordType: 'session',
          recordId: sessionId,
          data: { authMethod, ipHash: ipHash ?? null, userAgent: userAgent ?? null },
        }),
      );
    }
  };
}

/** M11 review R1 F5: the other account events, in the same chains as sign-ins. */
function authEventAuditor(
  database: Database,
  audit: AuditService,
  memberships: MembershipDirectory,
) {
  return async (event: AuthAuditEvent) => {
    for (const companyId of await chainsFor(database, memberships, event.personId)) {
      await withCompany(
        database,
        { companyId, personId: event.personId, actorKind: 'system' },
        (tx) =>
          audit.append(tx, {
            companyId,
            action: event.action,
            recordType: event.recordType,
            recordId: event.recordId,
            data: event.data ?? {},
          }),
      );
    }
  };
}

/** Tests never reach Have I Been Pwned: nothing counts as breached unless a test says so. */
const offlineBreachCheck = async () => false;

@Module({
  imports: [AuditModule],
  providers: [
    {
      provide: AUTH,
      inject: [DATABASE, CONFIG, SMS_PORT, EMAIL_PORT, CLOCK, LOGGER, AuditService, ALERT_PORT],
      useFactory: (
        database: Database,
        config: AppConfig,
        sms: SmsPort,
        email: EmailPort,
        clock: Clock,
        logger: AppLogger,
        audit: AuditService,
        alerts: AlertPort,
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
          onAuthEvent: authEventAuditor(database, audit, memberships),
          alerts,
          ...(config.NODE_ENV === 'test' ? { breachedPassword: offlineBreachCheck } : {}),
        });
      },
    },
    IdentityService,
    PersonAccounts,
    StepUpVerifier,
    AccountRecoveryService,
  ],
  exports: [AUTH, IdentityService, PersonAccounts, StepUpVerifier, AccountRecoveryService],
})
export class IdentityModule {}
