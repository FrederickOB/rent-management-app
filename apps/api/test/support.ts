import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createDatabase, sql, withCompany, withSystem, schema, type Database } from '@rent/db';
import { cloneTemplateDatabase, runSql, type TestDatabase } from '@rent/db/testing';
import type { CompanyKind, MembershipRole } from '@rent/domain/policy';
import { InMemoryEmail, InMemorySms, InMemoryStorage } from '@rent/integrations';
import { createLogger, loadConfig, type AppConfig } from '@rent/server/core';
import { PersonAccounts } from '@rent/server/identity';
import { generate } from 'otplib';
import { inject } from 'vitest';
import { createApiApp } from '../src/app';

export interface TestApi {
  readonly app: NestFastifyApplication;
  readonly baseUrl: string;
  readonly db: TestDatabase;
  readonly database: Database;
  readonly sms: InMemorySms;
  readonly email: InMemoryEmail;
  readonly storage: InMemoryStorage;
  readonly config: AppConfig;
  close(): Promise<void>;
}

export async function startApi(overrides: Partial<AppConfig> = {}): Promise<TestApi> {
  const db = await cloneTemplateDatabase(inject('templateDatabase'));
  const base = loadConfig({
    ...process.env,
    DATABASE_URL: db.appUrl,
    FAKE_PROVIDERS_URL: undefined,
  });
  const config: AppConfig = { ...base, API_BASE_URL: 'http://127.0.0.1:0', ...overrides };
  const database = createDatabase(db.appUrl, { max: 5, applicationName: 'api-test' });
  const sms = new InMemorySms();
  const email = new InMemoryEmail();
  const storage = new InMemoryStorage();
  const app = await createApiApp({
    config,
    database,
    sms,
    email,
    storage,
    logger: createLogger({ level: 'warn' }),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = await app.getUrl();
  return {
    app,
    baseUrl: baseUrl.replace('[::1]', '127.0.0.1'),
    db,
    database,
    sms,
    email,
    storage,
    config,
    async close() {
      await app.close();
      await database.close();
      await db.drop();
    },
  };
}

/** A device: keeps its own cookies, like a browser or the Expo app. */
export class Device {
  private readonly cookies = new Map<string, string>();
  constructor(
    private readonly baseUrl: string,
    readonly userAgent = 'vitest-device',
  ) {}

  async call(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      origin: 'http://localhost:3701',
      ...init.headers,
    };
    for (const [key, value] of Object.entries(headers)) if (value === '') delete headers[key];
    if (this.cookies.size > 0)
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (!value || /max-age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return {
      status: response.status,
      json: (json ?? {}) as Record<string, unknown>,
      headers: response.headers,
    };
  }

  sessionToken(): string | undefined {
    const raw = [...this.cookies].find(([k]) => k.endsWith('session_token'))?.[1];
    return raw ? decodeURIComponent(raw).split('.')[0] : undefined;
  }
}

export async function createCompany(
  api: TestApi,
  kind: CompanyKind,
  name: string,
): Promise<string> {
  return withSystem(api.database, {}, async (tx) => {
    const result = await tx.execute<{ id: string }>(
      sql`select app.create_company(null, ${kind}, ${name}, ${name}, 'GH', 'Africa/Accra', ${name}, '{}'::jsonb) as id`,
    );
    return result.rows[0]!.id;
  });
}

export async function addMembership(
  api: TestApi,
  companyId: string,
  personId: string,
  role: MembershipRole,
  extra: { nominatedApprover?: boolean } = {},
): Promise<string> {
  return withCompany(api.database, { companyId, actorKind: 'system' }, async (tx) => {
    const [row] = await tx
      .insert(schema.membership)
      .values({ companyId, personId, role, nominatedApprover: extra.nominatedApprover ?? false })
      .returning({ id: schema.membership.id });
    return row!.id;
  });
}

export async function createPerson(
  api: TestApi,
  input: { name: string; email?: string; phone?: string; password?: string },
) {
  return api.app.get(PersonAccounts).create({ ...input, isTestContact: true });
}

export async function totpFrom(uri: string): Promise<string> {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) throw new Error('No secret in TOTP URI');
  return generate({ secret });
}

/** Signs a staff member in and enrols TOTP; returns the device and the TOTP secret URI. */
export async function enrolStaff(api: TestApi, email: string, password: string) {
  const device = new Device(api.baseUrl);
  const signIn = await device.call('/api/auth/sign-in/email', { body: { email, password } });
  if (signIn.status !== 200)
    throw new Error(`sign-in failed: ${signIn.status} ${JSON.stringify(signIn.json)}`);
  const enable = await device.call('/api/auth/two-factor/enable', { body: { password } });
  if (enable.status !== 200)
    throw new Error(`enable failed: ${enable.status} ${JSON.stringify(enable.json)}`);
  const totpURI = String(enable.json.totpURI);
  const verify = await device.call('/api/auth/two-factor/verify-totp', {
    body: { code: await totpFrom(totpURI) },
  });
  if (verify.status !== 200)
    throw new Error(`verify failed: ${verify.status} ${JSON.stringify(verify.json)}`);
  return { device, totpURI, backupCodes: enable.json.backupCodes as unknown as string[] };
}

export const owner = (api: TestApi, text: string, values: unknown[] = []) =>
  runSql(api.db.ownerUrl, text, values);
export const superuser = (api: TestApi, text: string, values: unknown[] = []) =>
  runSql(api.db.superuserUrl, text, values);
