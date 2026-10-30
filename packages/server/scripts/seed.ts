/**
 * Accra demo dataset (CLAUDE.md section 14). M1 seeded companies and users; M2 adds owners,
 * properties, units, meters and each person's scope. Tenancies and money arrive in later
 * milestones. Every person is fictional and flagged as a test contact, and only fake providers
 * are configured locally, so nothing is ever sent.
 *
 *   pnpm db:seed
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { eq, schema, sql, withCompany, withSystem, type Database } from '@rent/db';
import { defaultCompanySettings } from '@rent/domain/settings';
import type { Actor, CompanyKind, MembershipRole } from '@rent/domain/policy';
import type { Availability } from '@rent/domain/portfolio';
import { symmetricEncrypt } from 'better-auth/crypto';
import { CONFIG, CoreModule, DATABASE, loadConfig, type AppConfig } from '../src/core';
import { OwnersService } from '../src/companies/owners.service';
import { IdentityModule, PersonAccounts } from '../src/identity';
import {
  MetersService,
  PortfolioModule,
  RegisterReadService,
  RegisterService,
  type NewProperty,
} from '../src/portfolio';

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
  // Agency clients, linked to owner records OWN-02 and OWN-01 (M2). One lives in London.
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
  // Caretakers sign in by phone; Kojo looks after ACC-LEG and Abena after ACC-OSU (M2).
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

@Module({
  imports: [
    CoreModule.forRoot({ config, applicationName: 'rent-seed' }),
    IdentityModule,
    PortfolioModule,
  ],
})
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

/** The staff actor for a seeded person, as the API's guard would build it. */
async function actorFor(database: Database, companyId: string, email: string): Promise<Actor> {
  const result = await withSystem(database, {}, (tx) =>
    tx.execute<{ person_id: string; membership_id: string; role: string; kind: CompanyKind }>(
      sql`select p.id as person_id, m.membership_id, m.role, m.company_kind as kind
          from person p, app.memberships_for_person(p.id) m
          where p.email = ${email} and m.company_id = ${companyId} and m.status = 'active'`,
    ),
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no active membership for ${email}`);
  return {
    kind: 'staff',
    personId: row.person_id,
    companyId,
    companyKind: row.kind,
    membershipId: row.membership_id,
    role: row.role as 'owner' | 'agency_admin',
    nominatedApprover: false,
    scope: {},
    authMethod: 'password_totp',
  };
}

interface DemoProperty extends NewProperty {
  readonly status?: {
    readonly code: string;
    readonly availability: Availability;
    readonly reason: string;
  }[];
  readonly meters?: {
    readonly utility: 'electricity' | 'water';
    readonly supplier: string;
    readonly meterNumber: string;
    readonly meterType: 'prepaid' | 'postpaid' | 'shared';
    readonly units: readonly string[];
  }[];
}

// Fake GhanaPost codes (the unused 000 area) and approximate pins for each neighbourhood.
const AGENCY_PROPERTIES = (ownerA: string, ownerB: string): DemoProperty[] => [
  {
    areaCode: 'ACC',
    propertyPart: 'LEG',
    name: 'Legon compound house (demo)',
    propertyType: 'compound_house',
    use: 'residential',
    ownerId: ownerA,
    address: {
      ghanapostGps: 'GA-000-0001',
      region: 'Greater Accra',
      town: 'Legon',
      latitude: '5.6505',
      longitude: '-0.1862',
    },
    blocks: [
      { code: 'B1', name: 'Main house', units: [{ unitType: 'chamber_and_hall', count: 6 }] },
      { code: 'B2', name: 'Back rooms', units: [{ unitType: 'single_room', count: 6 }] },
    ],
    status: [
      {
        code: 'ACC-LEG-B2-06',
        availability: 'under_repair',
        reason: 'Ceiling repair after the rains',
      },
    ],
    meters: [
      {
        utility: 'water',
        supplier: 'Ghana Water',
        meterNumber: 'W-LEG-001',
        meterType: 'shared',
        units: [
          'ACC-LEG-B1-01',
          'ACC-LEG-B1-02',
          'ACC-LEG-B1-03',
          'ACC-LEG-B1-04',
          'ACC-LEG-B1-05',
          'ACC-LEG-B1-06',
        ],
      },
      {
        utility: 'electricity',
        supplier: 'ECG',
        meterNumber: 'P-LEG-0101',
        meterType: 'prepaid',
        units: ['ACC-LEG-B1-01'],
      },
    ],
  },
  {
    areaCode: 'ACC',
    propertyPart: 'ELG',
    name: 'East Legon flats (demo)',
    propertyType: 'apartment_block',
    use: 'residential',
    ownerId: ownerA,
    address: {
      ghanapostGps: 'GA-000-0002',
      region: 'Greater Accra',
      town: 'East Legon',
      latitude: '5.6362',
      longitude: '-0.1591',
    },
    units: [
      { unitType: 'apartment', count: 3, bedrooms: 1, amenities: ['parking', 'borehole'] },
      {
        unitType: 'apartment',
        count: 3,
        bedrooms: 2,
        amenities: ['parking', 'borehole', 'air_conditioning'],
      },
      {
        unitType: 'apartment',
        count: 2,
        bedrooms: 3,
        amenities: ['parking', 'borehole', 'air_conditioning', 'generator'],
      },
    ],
    meters: [
      {
        utility: 'electricity',
        supplier: 'ECG',
        meterNumber: 'P-ELG-0001',
        meterType: 'prepaid',
        units: ['ACC-ELG-B1-01'],
      },
      {
        utility: 'electricity',
        supplier: 'ECG',
        meterNumber: 'P-ELG-0002',
        meterType: 'prepaid',
        units: ['ACC-ELG-B1-02'],
      },
    ],
  },
  {
    areaCode: 'ACC',
    propertyPart: 'OSU',
    name: 'Osu mixed-use building (demo)',
    propertyType: 'mixed_use',
    use: 'mixed',
    ownerId: ownerB,
    address: {
      region: 'Greater Accra',
      town: 'Osu',
      street: 'Oxford Street (demo)',
      latitude: '5.5560',
      longitude: '-0.1819',
    },
    blocks: [
      { code: 'G', name: 'Ground floor shops', units: [{ unitType: 'shop', count: 4 }] },
      {
        code: 'F1',
        name: 'First floor offices',
        units: [{ unitType: 'office', count: 4, amenities: ['air_conditioning'] }],
      },
    ],
    status: [
      { code: 'ACC-OSU-G-04', availability: 'not_lettable', reason: 'Used as the building store' },
    ],
    meters: [
      {
        utility: 'water',
        supplier: 'Ghana Water',
        meterNumber: 'W-OSU-001',
        meterType: 'shared',
        units: ['ACC-OSU-G-01', 'ACC-OSU-G-02', 'ACC-OSU-G-03', 'ACC-OSU-G-04'],
      },
    ],
  },
];

const LANDLORD_PROPERTIES: DemoProperty[] = [
  {
    areaCode: 'TEM',
    propertyPart: 'EST',
    name: 'Tema estate house (demo)',
    propertyType: 'gated_estate',
    use: 'residential',
    address: {
      region: 'Greater Accra',
      town: 'Tema Community 25',
      latitude: '5.7348',
      longitude: '0.0322',
    },
    units: [
      {
        unitType: 'detached_house',
        count: 1,
        bedrooms: 4,
        amenities: ['parking', 'generator', 'borehole'],
      },
    ],
  },
];

/** Owners, properties, units, statuses and meters (M2), created once through the services. */
async function ensureRegister(
  database: Database,
  services: {
    owners: OwnersService;
    register: RegisterService;
    read: RegisterReadService;
    meters: MetersService;
  },
): Promise<number> {
  const admin = await actorFor(database, AGENCY, 'agency.admin@demo.invalid');
  const landlord = await actorFor(database, LANDLORD, 'landlord@demo.invalid');
  const existing = new Set(
    (await services.owners.list(admin, { includeArchived: true })).map((o) => o.reference),
  );
  const demoOwners = [
    {
      reference: 'OWN-01',
      displayName: 'Ama Owner-London (demo)',
      email: 'owner.london@demo.invalid',
      residenceCountry: 'GB',
      timeZone: 'Europe/London',
    },
    {
      reference: 'OWN-02',
      displayName: 'Nana Owner-Accra (demo)',
      email: 'owner.accra@demo.invalid',
      residenceCountry: 'GH',
      timeZone: 'Africa/Accra',
    },
  ];
  for (const o of demoOwners)
    if (!existing.has(o.reference))
      await services.owners.create(admin, { kind: 'individual', ...o });
  const owners = new Map((await services.owners.list(admin)).map((o) => [o.reference, o.id]));
  let created = 0;
  for (const [actor, properties] of [
    [admin, AGENCY_PROPERTIES(owners.get('OWN-01')!, owners.get('OWN-02')!)],
    [landlord, LANDLORD_PROPERTIES],
  ] as const) {
    const codes = new Set(
      (await services.read.listProperties(actor, { includeArchived: true })).rows.map(
        (p) => p.code,
      ),
    );
    for (const p of properties) {
      if (codes.has(`${p.areaCode}-${p.propertyPart}`)) continue;
      const propertyId = await services.register.createProperty(actor, p);
      created += 1;
      const units = new Map(
        (await services.read.getProperty(actor, propertyId)).blocks.flatMap((b) =>
          b.units.map((u) => [u.code, u.id] as const),
        ),
      );
      for (const s of p.status ?? [])
        await services.register.setAvailability(actor, units.get(s.code)!, {
          availability: s.availability,
          reason: s.reason,
        });
      for (const m of p.meters ?? [])
        await services.meters.add(actor, propertyId, {
          ...m,
          unitIds: m.units.map((code) => units.get(code)!),
        });
    }
  }
  // Every demo contact is a test contact (CLAUDE.md section 14).
  for (const companyId of [AGENCY, LANDLORD])
    await withCompany(database, { companyId, actorKind: 'system' }, (tx) =>
      tx
        .update(schema.owner)
        .set({ isTestContact: true })
        .where(eq(schema.owner.isTestContact, false)),
    );
  return created;
}

/** Who sees what inside the agency (AD-02): caretakers by property, client owners by owner. */
async function ensureScopes(database: Database): Promise<void> {
  const ids = await withCompany(
    database,
    { companyId: AGENCY, actorKind: 'system' },
    async (tx) => {
      const owners = await tx
        .select({ id: schema.owner.id, reference: schema.owner.reference })
        .from(schema.owner);
      const properties = await tx
        .select({ id: schema.property.id, code: schema.property.code })
        .from(schema.property);
      return {
        owner: new Map(owners.map((o) => [o.reference, o.id])),
        property: new Map(properties.map((p) => [p.code, p.id])),
      };
    },
  );
  const scopes: {
    key: { email?: string; phone?: string };
    scope: { owners?: string[]; properties?: string[] };
  }[] = [
    { key: { email: 'owner.london@demo.invalid' }, scope: { owners: [ids.owner.get('OWN-01')!] } },
    { key: { email: 'owner.accra@demo.invalid' }, scope: { owners: [ids.owner.get('OWN-02')!] } },
    { key: { email: 'adviser@demo.invalid' }, scope: { owners: [ids.owner.get('OWN-01')!] } },
    { key: { phone: '+233200000011' }, scope: { properties: [ids.property.get('ACC-LEG')!] } },
    { key: { phone: '+233200000012' }, scope: { properties: [ids.property.get('ACC-OSU')!] } },
  ];
  for (const { key, scope } of scopes) {
    const [found] = await withSystem(database, {}, (tx) =>
      tx
        .select({ id: schema.person.id })
        .from(schema.person)
        .where(
          key.email
            ? eq(schema.person.email, key.email)
            : eq(schema.person.phoneNumber, key.phone!),
        ),
    );
    if (!found) continue;
    await withCompany(database, { companyId: AGENCY, actorKind: 'system' }, (tx) =>
      tx
        .update(schema.membership)
        .set({ scope, updatedAt: new Date() })
        .where(
          sql`${schema.membership.personId} = ${found.id} and ${schema.membership.status} = 'active' and ${schema.membership.scope} is distinct from ${JSON.stringify(scope)}::jsonb`,
        ),
    );
  }
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
  const created = await ensureRegister(database, {
    owners: app.get(OwnersService),
    register: app.get(RegisterService),
    read: app.get(RegisterReadService),
    meters: app.get(MetersService),
  });
  await ensureScopes(database);
  console.log(`Seeded ${COMPANIES.length} companies and ${PEOPLE.length} people.`);
  console.log(
    `Register: ${created} new properties (agency: ACC-LEG, ACC-ELG, ACC-OSU; landlord: TEM-EST).`,
  );
  console.log(`Staff password: ${DEMO_PASSWORD}`);
  console.log(
    `TOTP for every demo staff member: otpauth://totp/Rent%20Platform:demo?secret=${base32(DEMO_TOTP_SECRET)}&issuer=Rent%20Platform`,
  );
  console.log('Tenant sign-in: +233 20 000 0021; read the code at http://localhost:4010');
} finally {
  await app.close();
}
