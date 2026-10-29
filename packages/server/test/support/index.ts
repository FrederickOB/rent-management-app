import { createDatabase, schema, sql, withCompany, withSystem, type Database } from '@rent/db';
import {
  cloneTemplateDatabase,
  runSql,
  runSqlWithoutTriggers,
  type TestDatabase,
} from '@rent/db/testing';
import type { CompanyKind, MembershipRole } from '@rent/domain/policy';
import { InMemoryStorage } from '@rent/integrations';
import { symmetricEncrypt } from 'better-auth/crypto';
import { v7 as uuidv7 } from 'uuid';
import { inject } from 'vitest';
import { FixedClock } from '../../src/core/clock';
import { loadConfig, type AppConfig } from '../../src/core/config';
import { AuditService } from '../../src/audit/audit.service';

/** A fresh database cloned from the migrated template, connected as the application role. */
export interface ServerTestContext {
  readonly db: TestDatabase;
  readonly database: Database;
  readonly config: AppConfig;
  readonly clock: FixedClock;
  readonly storage: InMemoryStorage;
  readonly audit: AuditService;
  close(): Promise<void>;
}

export async function startServerTest(): Promise<ServerTestContext> {
  const db = await cloneTemplateDatabase(inject('templateDatabase'));
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: db.appUrl,
    FAKE_PROVIDERS_URL: undefined,
  });
  const database = createDatabase(db.appUrl, { max: 8, applicationName: 'server-test' });
  const clock = new FixedClock(new Date());
  const storage = new InMemoryStorage();
  await storage.ensureBuckets({
    files: config.S3_BUCKET_FILES,
    evidence: config.S3_BUCKET_EVIDENCE,
  });
  const audit = new AuditService(database, storage, clock);
  return {
    db,
    database,
    config,
    clock,
    storage,
    audit,
    async close() {
      await database.close();
      await db.drop();
    },
  };
}

export async function company(
  ctx: ServerTestContext,
  kind: CompanyKind,
  name: string,
): Promise<string> {
  return withSystem(ctx.database, {}, async (tx) => {
    const result = await tx.execute<{ id: string }>(
      sql`select app.create_company(null, ${kind}, ${name}, ${name}, 'GH', 'Africa/Accra', ${name}, '{}'::jsonb) as id`,
    );
    return result.rows[0]!.id;
  });
}

export async function person(
  ctx: ServerTestContext,
  name: string,
  extra: { totpSecret?: string } = {},
): Promise<string> {
  const id = uuidv7();
  await withSystem(ctx.database, {}, async (tx) => {
    await tx.insert(schema.person).values({
      id,
      name,
      email: `${id}@test.invalid`,
      isTestContact: true,
      twoFactorEnabled: Boolean(extra.totpSecret),
    });
    if (extra.totpSecret) {
      await tx.insert(schema.twoFactor).values({
        userId: id,
        secret: await symmetricEncrypt({
          key: ctx.config.BETTER_AUTH_SECRET,
          data: extra.totpSecret,
        }),
        backupCodes: await symmetricEncrypt({ key: ctx.config.BETTER_AUTH_SECRET, data: '[]' }),
        verified: true,
      });
    }
  });
  return id;
}

export async function member(
  ctx: ServerTestContext,
  companyId: string,
  personId: string,
  role: MembershipRole,
  extra: { nominatedApprover?: boolean } = {},
): Promise<string> {
  return withCompany(ctx.database, { companyId, actorKind: 'system' }, async (tx) => {
    const [row] = await tx
      .insert(schema.membership)
      .values({ companyId, personId, role, nominatedApprover: extra.nominatedApprover ?? false })
      .returning({ id: schema.membership.id });
    return row!.id;
  });
}

/** A staff actor, as the API's guard would build it. */
export function staff(
  companyId: string,
  companyKind: CompanyKind,
  personId: string,
  membershipId: string,
  role: Exclude<MembershipRole, 'platform_admin'>,
  nominatedApprover = false,
) {
  return {
    kind: 'staff' as const,
    personId,
    companyId,
    companyKind,
    membershipId,
    role,
    nominatedApprover,
    scope: {},
    authMethod: 'password_totp' as const,
  };
}

/** SQL as a superuser with triggers off: simulates changes made below the application. */
export const asSuperuser = (ctx: ServerTestContext, statement: string, values: unknown[] = []) =>
  runSqlWithoutTriggers(ctx.db.superuserUrl, statement, values);

export const asOwner = (ctx: ServerTestContext, statement: string, values: unknown[] = []) =>
  runSql(ctx.db.ownerUrl, statement, values);
