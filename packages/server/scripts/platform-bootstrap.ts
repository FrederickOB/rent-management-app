/**
 * A new deployment's platform (M10 decision 14): the platform company and its platform book, and
 * the first platform admin, invited by email to set a password (then TOTP at first sign-in).
 * Idempotent: run it again and nothing new is made; the invitation goes again only while the
 * admin has not set a password. The email address is never printed.
 *
 *   pnpm platform:bootstrap --name "Rent Platform" --legal-name "Rent Platform Ltd" \
 *     --email ops@example.com [--admin-name "Ama Mensah"]
 */
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Database } from '@rent/db';
import { bootstrapPlatform } from '../src/admin/bootstrap';
import { invitationSender } from '../src/admin/invitations';
import { AuditModule, AuditService } from '../src/audit';
import { AUTH, CoreModule, DATABASE, loadConfig } from '../src/core';
import { IdentityModule, PersonAccounts, type Auth } from '../src/identity';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    'legal-name': { type: 'string' },
    email: { type: 'string' },
    'admin-name': { type: 'string' },
  },
});

const missing = (['name', 'legal-name', 'email'] as const).filter((name) => !values[name]?.trim());
if (missing.length > 0) {
  console.error(
    `Missing --${missing.join(', --')}. See the usage at the top of scripts/platform-bootstrap.ts.`,
  );
  process.exit(1);
}

const config = loadConfig();

@Module({
  imports: [
    CoreModule.forRoot({ config, applicationName: 'rent-platform-bootstrap' }),
    AuditModule,
    IdentityModule,
  ],
})
class PlatformBootstrapModule {}

const app = await NestFactory.createApplicationContext(PlatformBootstrapModule, { logger: false });
try {
  const result = await bootstrapPlatform(
    app.get<Database>(DATABASE),
    {
      accounts: app.get(PersonAccounts),
      audit: app.get(AuditService),
      invite: invitationSender(app.get<Auth>(AUTH), config.WEB_ORIGIN),
    },
    {
      name: values.name!,
      legalName: values['legal-name']!,
      email: values.email!,
      ...(values['admin-name'] ? { adminName: values['admin-name'] } : {}),
    },
  );
  console.log(
    result.companyCreated
      ? `Created the platform company ${result.platformCompanyId} and its platform book.`
      : `The platform company ${result.platformCompanyId} exists already.`,
  );
  console.log(
    result.membershipCreated
      ? 'Added the first platform admin.'
      : 'That person is a platform admin already.',
  );
  console.log(
    result.invitationSent
      ? 'Sent the set-password invitation to the address given.'
      : 'No invitation sent: the platform admin has set a password already.',
  );
} catch (error) {
  console.error(`Platform bootstrap failed: ${error instanceof Error ? error.message : 'unknown'}`);
  process.exitCode = 1;
} finally {
  await app.close();
}
