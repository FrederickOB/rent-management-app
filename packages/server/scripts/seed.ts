/**
 * Accra demo dataset (CLAUDE.md section 14). M1 seeds companies and users only; later
 * milestones add properties, tenancies and money. Every person is fictional and flagged as a
 * test contact, and only fake providers are configured locally, so nothing is ever sent.
 *
 *   pnpm db:seed
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { eq, schema, sql, withCompany, withSystem, type Database } from '@rent/db';
import { defaultCompanySettings } from '@rent/domain/settings';
import type { CompanyKind, MembershipRole } from '@rent/domain/policy';
import { symmetricEncrypt } from 'better-auth/crypto';
import { CONFIG, CoreModule, DATABASE, loadConfig, type AppConfig } from '../src/core';
import { IdentityModule, PersonAccounts } from '../src/identity';

const config = loadConfig();
const host = new URL(config.DATABASE_URL).hostname;
if (config.NODE_ENV === 'production' || !['localhost', '127.0.0.1', 'postgres'].includes(host)) {
  console.error('The demo seed runs only against a local development database.');
  process.exit(1);
}

/** One documented TOTP secret for every demo staff member (dev only; see README). */
export const DEMO_TOTP_SECRET = 'rent-demo-totp-secret-2026-local';
export const DEMO_PASSWORD = 'demo-password-2026';

const COMPANIES: { id: string; kind: CompanyKind; legalName: string; displayName: string }[] = [
  {
    id: '019a3000-0000-7000-8000-000000000001',
    kind: 'platform',
    legalName: 'Rent Platform (demo operator)',
    displayName: 'Rent Platform',
  },
  {
    id: '019a3000-0000-7000-8000-000000000002',
    kind: 'agency',
    legalName: 'Osu Ridge Property Managers Ltd (demo)',
    displayName: 'Osu Ridge Property Managers',
  },
  {
    id: '019a3000-0000-7000-8000-000000000003',
    kind: 'landlord',
    legalName: 'Kwabena Owusu-Demo (demo landlord)',
    displayName: 'Kwabena Owusu-Demo',
  },
];
const [PLATFORM, AGENCY, LANDLORD] = COMPANIES.map((c) => c.id) as [string, string, string];

interface DemoPerson {
  readonly name: string;
  readonly email?: string;
  readonly phone?: string;
  readonly staff: boolean;
  /** Staff are pre-enrolled in TOTP with the shared dev secret unless this is false. */
  readonly totp?: boolean;
  readonly memberships: { companyId: string; role: MembershipRole; nominatedApprover?: boolean }[];
}

// Phone numbers come from one obviously fake block (+233 20 000 00xx).
const PEOPLE: DemoPerson[] = [
  {
    name: 'Platform Admin (demo)',
    email: 'admin@demo.invalid',
    staff: true,
    memberships: [{ companyId: PLATFORM, role: 'platform_admin' }],
  },
  {
    name: 'Efua Agency-Admin (demo)',
    email: 'agency.admin@demo.invalid',
    staff: true,
    memberships: [{ companyId: AGENCY, role: 'agency_admin' }],
  },
  {
    name: 'Kofi Manager (demo)',
    email: 'manager.one@demo.invalid',
    staff: true,
    memberships: [{ companyId: AGENCY, role: 'property_manager' }],
  },
  {
    name: 'Akosua Manager (demo)',
    email: 'manager.two@demo.invalid',
    staff: true,
    memberships: [{ companyId: AGENCY, role: 'property_manager' }],
  },
  // Not enrolled in TOTP, to try the enrolment flow (and its end-to-end test).
  {
    name: 'Kwesi New-Manager (demo)',
    email: 'new.manager@demo.invalid',
    staff: true,
    totp: false,
    memberships: [{ companyId: AGENCY, role: 'property_manager' }],
  },
  {
    name: 'Yaw Accountant (demo)',
    email: 'accountant@demo.invalid',
    staff: true,
    memberships: [{ companyId: AGENCY, role: 'accountant' }],
  },
  {
    name: 'Adjoa Adviser (demo)',
    email: 'adviser@demo.invalid',
    staff: true,
    memberships: [{ companyId: AGENCY, role: 'adviser' }],
  },
  // Agency clients; their owner records and property scope arrive in M2. One lives in London.
  {
    name: 'Nana Owner-Accra (demo)',
    email: 'owner.accra@demo.invalid',
    staff: true,
    memberships: [{ companyId: AGENCY, role: 'owner' }],
  },
  {
    name: 'Ama Owner-London (demo)',
    email: 'owner.london@demo.invalid',
    staff: true,
    memberships: [{ companyId: AGENCY, role: 'owner' }],
  },
  // Caretakers sign in by phone; property assignment arrives in M2.
  {
    name: 'Kojo Caretaker (demo)',
    phone: '+233200000011',
    staff: false,
    memberships: [{ companyId: AGENCY, role: 'caretaker' }],
  },
  {
    name: 'Abena Caretaker (demo)',
    phone: '+233200000012',
    staff: false,
    memberships: [{ companyId: AGENCY, role: 'caretaker' }],
  },
  // A self-managing landlord, with a family member nominated as second approver (AD-05).
  {
    name: 'Kwabena Landlord (demo)',
    email: 'landlord@demo.invalid',
    staff: true,
    memberships: [{ companyId: LANDLORD, role: 'owner' }],
  },
  {
    name: 'Esi Family-Approver (demo)',
    email: 'approver@demo.invalid',
    staff: true,
    memberships: [{ companyId: LANDLORD, role: 'adviser', nominatedApprover: true }],
  },
  // A tenant for the Expo app sign-in; tenancy records arrive in M3.
  { name: 'Ama Tenant (demo)', phone: '+233200000021', staff: false, memberships: [] },
];

@Module({ imports: [CoreModule.forRoot({ config, applicationName: 'rent-seed' }), IdentityModule] })
class SeedModule {}

async function ensureCompanies(database: Database) {
  for (const c of COMPANIES) {
    const existing = await withCompany(database, { companyId: c.id, actorKind: 'system' }, (tx) =>
      tx.select({ id: schema.company.id }).from(schema.company).where(eq(schema.company.id, c.id)),
    );
    if (existing.length > 0) continue;
    await withSystem(database, { actorKind: 'system' }, (tx) =>
      tx.execute(
        sql`select app.create_company(${c.id}::uuid, ${c.kind}, ${c.legalName}, ${c.displayName}, 'GH', 'Africa/Accra', ${c.displayName}, ${JSON.stringify(defaultCompanySettings())}::jsonb)`,
      ),
    );
  }
}

async function ensurePerson(
  database: Database,
  accounts: PersonAccounts,
  cfg: AppConfig,
  person: DemoPerson,
): Promise<string> {
  const lookup = await withSystem(database, {}, (tx) =>
    tx
      .select({ id: schema.person.id })
      .from(schema.person)
      .where(
        person.email
          ? eq(schema.person.email, person.email)
          : eq(schema.person.phoneNumber, person.phone!),
      ),
  );
  const personId =
    lookup[0]?.id ??
    (
      await accounts.create({
        name: person.name,
        email: person.email,
        phone: person.phone,
        password: person.staff ? DEMO_PASSWORD : undefined,
        isTestContact: true,
      })
    ).personId;

  if (person.staff && person.totp !== false) {
    await withSystem(database, { personId }, async (tx) => {
      const enrolled = await tx
        .select({ id: schema.twoFactor.id })
        .from(schema.twoFactor)
        .where(eq(schema.twoFactor.userId, personId));
      if (enrolled.length > 0) return;
      await tx.insert(schema.twoFactor).values({
        userId: personId,
        secret: await symmetricEncrypt({ key: cfg.BETTER_AUTH_SECRET, data: DEMO_TOTP_SECRET }),
        backupCodes: await symmetricEncrypt({
          key: cfg.BETTER_AUTH_SECRET,
          data: JSON.stringify(['demo1-backup', 'demo2-backup']),
        }),
        verified: true,
      });
      await tx
        .update(schema.person)
        .set({ twoFactorEnabled: true })
        .where(eq(schema.person.id, personId));
    });
  }

  if (person.staff && person.totp === false) {
    // The enrolment demo account starts un-enrolled on every seed run, so the TOTP enrolment
    // flow and its end-to-end test can be repeated.
    await withSystem(database, { personId }, async (tx) => {
      await tx.delete(schema.twoFactor).where(eq(schema.twoFactor.userId, personId));
      await tx
        .update(schema.person)
        .set({ twoFactorEnabled: false })
        .where(eq(schema.person.id, personId));
      await tx.delete(schema.session).where(eq(schema.session.userId, personId));
    });
  }

  for (const m of person.memberships) {
    await withCompany(database, { companyId: m.companyId, actorKind: 'system' }, async (tx) => {
      const existing = await tx
        .select({ id: schema.membership.id })
        .from(schema.membership)
        .where(
          sql`${schema.membership.companyId} = ${m.companyId} and ${schema.membership.personId} = ${personId} and ${schema.membership.status} in ('invited', 'active')`,
        );
      if (existing.length > 0) return;
      await tx.insert(schema.membership).values({
        companyId: m.companyId,
        personId,
        role: m.role,
        nominatedApprover: m.nominatedApprover ?? false,
      });
    });
  }
  return personId;
}

/** RFC 4648 base32 without padding, for the otpauth URI people add to an authenticator app. */
function base32(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of Buffer.from(text, 'utf8')) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

const app = await NestFactory.createApplicationContext(SeedModule, { logger: false });
try {
  const database = app.get<Database>(DATABASE);
  const cfg = app.get<AppConfig>(CONFIG);
  const accounts = app.get(PersonAccounts);
  await ensureCompanies(database);
  for (const person of PEOPLE) await ensurePerson(database, accounts, cfg, person);
  console.log(`Seeded ${COMPANIES.length} companies and ${PEOPLE.length} people.`);
  console.log(`Staff password: ${DEMO_PASSWORD}`);
  console.log(
    `TOTP for every demo staff member: otpauth://totp/Rent%20Platform:demo?secret=${base32(DEMO_TOTP_SECRET)}&issuer=Rent%20Platform`,
  );
  console.log('Tenant sign-in: +233 20 000 0021; read the code at http://localhost:4010');
} finally {
  await app.close();
}
