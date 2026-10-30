/**
 * Accra demo dataset (CLAUDE.md section 14). M1 seeded companies and users; M2 adds owners,
 * properties, units, meters and each person's scope; M3 adds tenants and their leases, recorded
 * as signed on paper (decision 7), and one lease out for e-signing; M4a adds their money. Every
 * person is fictional and flagged as a test contact, and only fake providers are configured
 * locally, so nothing is ever sent.
 *
 *   pnpm db:seed
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { eq, schema, sql, withCompany, withSystem, type Database } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { defaultCompanySettings } from '@rent/domain/settings';
import type { StoragePort } from '@rent/integrations';
import type { Actor, CompanyKind, MembershipRole } from '@rent/domain/policy';
import type { Availability } from '@rent/domain/portfolio';
import { symmetricEncrypt } from 'better-auth/crypto';
import {
  CONFIG,
  CoreModule,
  DATABASE,
  loadConfig,
  STORAGE_PORT,
  type AppConfig,
} from '../src/core';
import { OwnersService } from '../src/companies/owners.service';
import { IdentityModule, PersonAccounts } from '../src/identity';
import {
  MetersService,
  PortfolioModule,
  RegisterReadService,
  RegisterService,
  type NewProperty,
} from '../src/portfolio';
import {
  LeaseSigningService,
  LeasesService,
  TenancyModule,
  TenantsService,
  type TenantInput,
} from '../src/tenancy';
import { ApprovalsService } from '../src/approvals';
import {
  BillingModule,
  BillingReadService,
  InvoicingService,
  MoneyService,
  SubledgerCheckService,
} from '../src/billing';
import { LedgerModule } from '../src/ledger';

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
  // A tenant for the Expo app sign-in. In M3 she rents from both the agency and the landlord.
  { name: 'Ama Tenant (demo)', phone: '+233200000021', staff: false, memberships: [] },
];

@Module({
  imports: [
    CoreModule.forRoot({ config, applicationName: 'rent-seed' }),
    IdentityModule,
    PortfolioModule,
    TenancyModule,
    LedgerModule,
    BillingModule,
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
async function actorFor(database: Database, companyId: string, signIn: string): Promise<Actor> {
  const result = await withSystem(database, {}, (tx) =>
    tx.execute<{
      person_id: string;
      membership_id: string;
      role: string;
      kind: CompanyKind;
      nominated_approver: boolean;
      scope: { owners?: string[]; properties?: string[] } | null;
    }>(
      sql`select p.id as person_id, m.membership_id, m.role, m.company_kind as kind, m.nominated_approver, m.scope
          from person p, app.memberships_for_person(p.id) m
          where (p.email = ${signIn} or p.phone_number = ${signIn}) and m.company_id = ${companyId} and m.status = 'active'`,
    ),
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no active membership for ${signIn}`);
  return {
    kind: 'staff',
    personId: row.person_id,
    companyId,
    companyKind: row.kind,
    membershipId: row.membership_id,
    role: row.role as 'owner' | 'agency_admin',
    nominatedApprover: row.nominated_approver,
    scope: row.scope ?? {},
    // Caretakers are found by phone, as they sign in (CLAUDE.md section 10); staff by email.
    authMethod: signIn.startsWith('+') ? 'phone_otp' : 'password_totp',
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
      // The Osu building's owner charges VAT on commercial rent (CT-04, M4a).
      vatRegistered: true,
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

interface DemoTenancy {
  readonly companyId: string;
  readonly actorEmail: string;
  readonly what: string;
  readonly tenant: TenantInput;
  readonly unitCode: string;
  /** Months before today that the lease started (anchored on today's day of the month). */
  readonly startedMonthsAgo: number;
  /**
   * Anchors the lease on another day: it starts `startedMonthsAgo` months before this many days
   * ago, so a line falls due exactly that many days ago (the 45- and 95-day arrears, M4a 4.21).
   */
  readonly anchorDaysAgo?: number;
  /** Bills from the lease start (M4a decision 1); otherwise from the first period from today. */
  readonly billFromStart?: boolean;
  readonly months: number;
  /** Ends this many days from today instead of after `months`. */
  readonly endsInDays?: number;
  readonly monthlyRentMinor: number;
  readonly cycle: 'monthly' | 'quarterly' | 'six_monthly' | 'annual';
  readonly initialAdvanceMonths?: number;
  readonly depositMinor?: number;
  readonly serviceChargeMonthlyMinor?: number;
}

const smsConsent = { sms: true };

// Fictional tenancies on the M2 units (M3 plan 4.18). Phones come from the fake +233 20 000 00xx
// block, and no ID number is seeded. The units the M2 end-to-end tests change by hand stay free:
// ACC-LEG-B2-06 (under repair), ACC-OSU-G-03, ACC-OSU-G-04 (not lettable) and ACC-ELG-B1-08.
const TENANCIES: DemoTenancy[] = [
  {
    companyId: AGENCY,
    actorEmail: 'manager.one@demo.invalid',
    what: 'a monthly payer',
    tenant: {
      kind: 'individual',
      displayName: 'Kwame Monthly (demo)',
      phone: '+233200000031',
      occupation: 'Teacher',
      consent: smsConsent,
    },
    unitCode: 'ACC-LEG-B1-01',
    startedMonthsAgo: 3,
    months: 12,
    monthlyRentMinor: 80_000,
    cycle: 'monthly',
    depositMinor: 160_000,
    billFromStart: true,
  },
  {
    companyId: AGENCY,
    actorEmail: 'manager.one@demo.invalid',
    what: 'a one-year advance, billed annually',
    tenant: {
      kind: 'individual',
      displayName: 'Efua Annual (demo)',
      phone: '+233200000032',
      occupation: 'Nurse',
      consent: smsConsent,
    },
    unitCode: 'ACC-LEG-B1-02',
    startedMonthsAgo: 2,
    months: 12,
    monthlyRentMinor: 70_000,
    cycle: 'annual',
    billFromStart: true,
  },
  {
    companyId: AGENCY,
    actorEmail: 'manager.one@demo.invalid',
    what: 'a two-year residential advance (over the unverified cap; no flag under `off`)',
    tenant: {
      kind: 'individual',
      displayName: 'Yaw Two-Year (demo)',
      phone: '+233200000033',
      occupation: 'Engineer',
      consent: smsConsent,
    },
    unitCode: 'ACC-ELG-B1-04',
    startedMonthsAgo: 1,
    months: 24,
    monthlyRentMinor: 150_000,
    cycle: 'annual',
    initialAdvanceMonths: 24,
    depositMinor: 300_000,
    billFromStart: true,
  },
  {
    companyId: AGENCY,
    actorEmail: 'manager.two@demo.invalid',
    what: 'a commercial company tenant with a signatory and a finance contact (withholds tax from M5)',
    tenant: {
      kind: 'company',
      displayName: 'Osu Pharmacy Ltd (demo)',
      legalName: 'Osu Pharmacy Limited (demo)',
      businessType: 'Pharmacy',
      registrationNumber: 'CS000000001',
      email: 'accounts@pharmacy.invalid',
      contacts: [
        {
          kind: 'signatory',
          name: 'Kofi Director (demo)',
          phone: '+233200000034',
          position: 'Managing Director',
          consent: smsConsent,
        },
        { kind: 'finance', name: 'Finance Desk (demo)', email: 'finance@pharmacy.invalid' },
      ],
    },
    unitCode: 'ACC-OSU-G-01',
    startedMonthsAgo: 4,
    months: 36,
    monthlyRentMinor: 300_000,
    cycle: 'quarterly',
    depositMinor: 900_000,
    serviceChargeMonthlyMinor: 30_000,
    billFromStart: true,
  },
  {
    companyId: AGENCY,
    actorEmail: 'manager.one@demo.invalid',
    what: 'a lease that expires in 60 days (renewal reminders)',
    tenant: {
      kind: 'individual',
      displayName: 'Akua Expiring (demo)',
      phone: '+233200000035',
      consent: smsConsent,
    },
    unitCode: 'ACC-ELG-B1-01',
    startedMonthsAgo: 10,
    months: 12,
    endsInDays: 60,
    monthlyRentMinor: 180_000,
    cycle: 'monthly',
    depositMinor: 360_000,
  },
  {
    companyId: AGENCY,
    actorEmail: 'manager.two@demo.invalid',
    what: 'a tenancy 45 days in arrears: billed from its start, partly paid, then nothing',
    tenant: {
      kind: 'individual',
      displayName: 'Kofi Arrears-45 (demo)',
      phone: '+233200000036',
      consent: smsConsent,
    },
    unitCode: 'ACC-LEG-B2-01',
    startedMonthsAgo: 3,
    anchorDaysAgo: 45,
    billFromStart: true,
    months: 12,
    monthlyRentMinor: 40_000,
    cycle: 'monthly',
  },
  {
    companyId: AGENCY,
    actorEmail: 'manager.two@demo.invalid',
    what: 'a tenancy 95 days in arrears: billed from its start, partly paid, then nothing',
    tenant: {
      kind: 'individual',
      displayName: 'Esi Arrears-95 (demo)',
      phone: '+233200000037',
      consent: smsConsent,
    },
    unitCode: 'ACC-LEG-B2-02',
    startedMonthsAgo: 2,
    anchorDaysAgo: 95,
    billFromStart: true,
    months: 12,
    monthlyRentMinor: 40_000,
    cycle: 'monthly',
  },
  {
    companyId: AGENCY,
    actorEmail: 'manager.two@demo.invalid',
    what: 'a tenancy partly paid this month',
    tenant: {
      kind: 'individual',
      displayName: 'Kojo Partial (demo)',
      phone: '+233200000038',
      consent: smsConsent,
    },
    unitCode: 'ACC-LEG-B2-03',
    startedMonthsAgo: 2,
    months: 12,
    monthlyRentMinor: 45_000,
    cycle: 'monthly',
    billFromStart: true,
  },
  {
    companyId: AGENCY,
    actorEmail: 'manager.one@demo.invalid',
    what: 'a tenancy holding an overpayment as credit',
    tenant: {
      kind: 'individual',
      displayName: 'Adwoa Credit (demo)',
      phone: '+233200000039',
      consent: smsConsent,
    },
    unitCode: 'ACC-ELG-B1-02',
    startedMonthsAgo: 2,
    months: 12,
    monthlyRentMinor: 180_000,
    cycle: 'monthly',
    depositMinor: 360_000,
    billFromStart: true,
  },
  // One person who rents from both the agency and the self-managing landlord (TL-01), on the demo
  // tenant phone, so both tenancies show in the tenant app.
  {
    companyId: AGENCY,
    actorEmail: 'manager.one@demo.invalid',
    what: 'the demo tenant’s flat, rented from the agency',
    tenant: {
      kind: 'individual',
      displayName: 'Ama Tenant (demo)',
      phone: '+233200000021',
      occupation: 'Accountant',
      consent: smsConsent,
    },
    unitCode: 'ACC-ELG-B1-05',
    startedMonthsAgo: 2,
    months: 12,
    monthlyRentMinor: 220_000,
    cycle: 'monthly',
    depositMinor: 440_000,
    billFromStart: true,
  },
  {
    companyId: LANDLORD,
    actorEmail: 'landlord@demo.invalid',
    what: 'the demo tenant’s house, rented from the landlord',
    tenant: {
      kind: 'individual',
      displayName: 'Ama Tenant (demo)',
      phone: '+233200000021',
      occupation: 'Accountant',
      consent: smsConsent,
    },
    unitCode: 'TEM-EST-B1-01',
    startedMonthsAgo: 6,
    months: 24,
    monthlyRentMinor: 450_000,
    cycle: 'six_monthly',
    depositMinor: 900_000,
    billFromStart: true,
  },
];

const PAPER_SCAN = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

/**
 * Tenants and their leases (M3), recorded through the services as signed on paper. Idempotent:
 * a tenant is found by name in its company, and a unit that already has a lease is skipped.
 */
async function ensureTenancies(
  database: Database,
  services: {
    tenants: TenantsService;
    leases: LeasesService;
    storage: StoragePort;
    cfg: AppConfig;
  },
): Promise<number> {
  const today = toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
  let created = 0;
  for (const t of TENANCIES) {
    const actor = await actorFor(database, t.companyId, t.actorEmail);
    const found = await withCompany(
      database,
      { companyId: t.companyId, actorKind: 'system' },
      async (tx) => {
        const [unit] = await tx
          .select({ id: schema.unit.id })
          .from(schema.unit)
          .where(eq(schema.unit.code, t.unitCode));
        const leased = unit
          ? await tx.execute<{ id: string }>(
              sql`select id from lease where unit_id = ${unit.id} and status <> 'cancelled' limit 1`,
            )
          : null;
        const [tenant] = await tx
          .select({ id: schema.tenant.id })
          .from(schema.tenant)
          .where(eq(schema.tenant.displayName, t.tenant.displayName));
        return { unitId: unit?.id, leased: (leased?.rows.length ?? 0) > 0, tenantId: tenant?.id };
      },
    );
    if (!found.unitId || found.leased) continue;
    const tenantId =
      found.tenantId ??
      (await services.tenants.create(actor, t.tenant, { isTestContact: true })).tenant.id;
    const anchor = toIsoDate(addDays(parseBusinessDate(today), -(t.anchorDaysAgo ?? 0)));
    const start = toIsoDate(addMonths(parseBusinessDate(anchor), -t.startedMonthsAgo));
    const end = t.endsInDays
      ? toIsoDate(addDays(parseBusinessDate(today), t.endsInDays))
      : toIsoDate(addDays(addMonths(parseBusinessDate(start), t.months), -1));
    const signedOn = toIsoDate(addDays(parseBusinessDate(start), -7));
    const upload = await services.leases.createUpload(actor, {
      contentType: 'application/pdf',
      sizeBytes: PAPER_SCAN.length,
    });
    // The scan goes where the browser's presigned upload would put it.
    await services.storage.put({
      bucket: services.cfg.S3_BUCKET_FILES,
      key: upload.fields.key!,
      body: PAPER_SCAN,
      contentType: 'application/pdf',
    });
    const signer =
      t.tenant.kind === 'company'
        ? { role: 'signatory' as const, name: t.tenant.contacts![0]!.name }
        : { role: 'tenant' as const, name: t.tenant.displayName };
    await services.leases.recordPaper(actor, {
      unitId: found.unitId,
      tenantId,
      startDate: start,
      endDate: end,
      monthlyRentMinor: t.monthlyRentMinor,
      cycle: t.cycle,
      initialAdvanceMonths: t.initialAdvanceMonths ?? null,
      depositMinor: t.depositMinor ?? null,
      serviceChargeMonthlyMinor: t.serviceChargeMonthlyMinor ?? null,
      noticeDays: t.tenant.kind === 'company' ? 90 : 30,
      parties: [{ ...signer, paperSignedOn: signedOn }],
      scanUploadId: upload.uploadId,
      signedOn,
      billingStartDate: t.billFromStart ? start : null,
    });
    created += 1;
  }
  return created;
}

/** The lease out for e-signing (M3 plan 4.18), on a flat no other demo or test lease uses. */
const SIGNING_UNIT = 'ACC-ELG-B1-03';
const SIGNING_TENANT: TenantInput = {
  kind: 'individual',
  displayName: 'Kojo Signing (demo)',
  phone: '+233200000040',
  email: 'kojo.signing@demo.invalid',
  occupation: 'Pharmacist',
  consent: { sms: true, email: true },
  contacts: [
    {
      kind: 'guarantor',
      name: 'Adjoa Guarantor (demo)',
      phone: '+233200000042',
      relationship: 'Sister',
      consent: { sms: true },
    },
  ],
};

/**
 * One lease issued for e-signing and waiting on its signatures (M3 plan 4.18): the tenant and a
 * guarantor, both with SMS consent; the first manager for the landlord and the second as the
 * witness, both staff, who get their links by email. The worker renders the PDF and sends the
 * links when it runs. Idempotent: skipped once the flat has a lease.
 */
async function ensureSigningLease(
  database: Database,
  services: { tenants: TenantsService; leases: LeasesService; signing: LeaseSigningService },
): Promise<boolean> {
  const actor = await actorFor(database, AGENCY, 'manager.one@demo.invalid');
  const witness = await actorFor(database, AGENCY, 'manager.two@demo.invalid');
  const found = await withCompany(
    database,
    { companyId: AGENCY, actorKind: 'system' },
    async (tx) => {
      const [unit] = await tx
        .select({ id: schema.unit.id })
        .from(schema.unit)
        .where(eq(schema.unit.code, SIGNING_UNIT));
      const leased = unit
        ? await tx.execute<{ id: string }>(
            sql`select id from lease where unit_id = ${unit.id} and status <> 'cancelled' limit 1`,
          )
        : null;
      const [tenant] = await tx
        .select({ id: schema.tenant.id })
        .from(schema.tenant)
        .where(eq(schema.tenant.displayName, SIGNING_TENANT.displayName));
      return { unitId: unit?.id, leased: (leased?.rows.length ?? 0) > 0, tenantId: tenant?.id };
    },
  );
  if (!found.unitId || found.leased || witness.kind !== 'staff') return false;
  const tenantId =
    found.tenantId ??
    (await services.tenants.create(actor, SIGNING_TENANT, { isTestContact: true })).tenant.id;
  const today = toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
  const start = toIsoDate(addMonths(parseBusinessDate(today), 1));
  const draft = await services.leases.createDraft(actor, {
    unitId: found.unitId,
    tenantId,
    startDate: start,
    endDate: toIsoDate(addDays(addMonths(parseBusinessDate(start), 12), -1)),
    monthlyRentMinor: 160_000,
    cycle: 'monthly',
    depositMinor: 320_000,
    noticeDays: 30,
  });
  await services.leases.updateDraft(actor, draft.id, {
    parties: [
      ...draft.parties.map((p) => ({
        role: p.role,
        name: p.name,
        phone: p.phone,
        email: p.email,
        tenantContactId: p.tenantContactId,
        staffPersonId: p.staffPersonId,
      })),
      {
        role: 'witness' as const,
        name: 'Akosua Manager (demo)',
        email: 'manager.two@demo.invalid',
        staffPersonId: witness.personId,
      },
    ],
  });
  await services.signing.issue(actor, draft.id);
  return true;
}

// Money (M4a plan 4.21): through the real services, approved by a second person, so the ledger,
// receipts and balances are what production would hold. Amounts are pesewas.
type MoneyStep =
  | {
      readonly kind: 'cash';
      /** Who received the money: a person seeded above, by email or phone. */
      readonly collector: string;
      readonly approver: string;
      readonly amountMinor: number;
      /** Days after the lease start, or 'today'. */
      readonly receivedOn: number | 'today';
      readonly method?: 'cash' | 'cheque';
    }
  | {
      readonly kind: 'transfer';
      readonly recorder: string;
      readonly approver: string;
      readonly into: 'owner_account' | 'agency_account';
      /** A fixed amount, or the deposit and every invoice issued so far. */
      readonly amountMinor: number | 'all_invoiced';
      readonly receivedOn: number | 'today';
    };

interface DemoMoney {
  readonly companyId: string;
  readonly unitCode: string;
  readonly steps: readonly MoneyStep[];
}

const KOJO = '+233200000011';
const MONEY: DemoMoney[] = [
  {
    // Paid up in cash: the first two months to a manager, the last two to the caretaker Kojo.
    companyId: AGENCY,
    unitCode: 'ACC-LEG-B1-01',
    steps: [
      {
        kind: 'cash',
        collector: 'manager.one@demo.invalid',
        approver: 'manager.two@demo.invalid',
        amountMinor: 240_000,
        receivedOn: 0,
      },
      {
        kind: 'cash',
        collector: 'manager.one@demo.invalid',
        approver: 'manager.two@demo.invalid',
        amountMinor: 80_000,
        receivedOn: 31,
      },
      {
        kind: 'cash',
        collector: KOJO,
        approver: 'manager.one@demo.invalid',
        amountMinor: 80_000,
        receivedOn: 61,
      },
      {
        kind: 'cash',
        collector: KOJO,
        approver: 'manager.one@demo.invalid',
        amountMinor: 80_000,
        receivedOn: 'today',
      },
    ],
  },
  {
    // A one-year advance: twelve months in one cash payment at the start.
    companyId: AGENCY,
    unitCode: 'ACC-LEG-B1-02',
    steps: [
      {
        kind: 'cash',
        collector: 'manager.one@demo.invalid',
        approver: 'agency.admin@demo.invalid',
        amountMinor: 840_000,
        receivedOn: 0,
      },
    ],
  },
  {
    // The two-year advance (worked example A): the deposit in cash, then GH₵36,000 by transfer.
    companyId: AGENCY,
    unitCode: 'ACC-ELG-B1-04',
    steps: [
      {
        kind: 'cash',
        collector: 'manager.one@demo.invalid',
        approver: 'accountant@demo.invalid',
        amountMinor: 300_000,
        receivedOn: 0,
      },
      {
        kind: 'transfer',
        recorder: 'manager.one@demo.invalid',
        approver: 'accountant@demo.invalid',
        into: 'owner_account',
        amountMinor: 3_600_000,
        receivedOn: 0,
      },
    ],
  },
  {
    // The commercial company tenant: its deposit and both quarters with VAT, into the agency's account.
    companyId: AGENCY,
    unitCode: 'ACC-OSU-G-01',
    steps: [
      {
        kind: 'transfer',
        recorder: 'accountant@demo.invalid',
        approver: 'agency.admin@demo.invalid',
        into: 'agency_account',
        amountMinor: 'all_invoiced',
        receivedOn: 'today',
      },
    ],
  },
  {
    // 45 days in arrears: three months and part of the fourth, then nothing.
    companyId: AGENCY,
    unitCode: 'ACC-LEG-B2-01',
    steps: [
      {
        kind: 'cash',
        collector: 'manager.two@demo.invalid',
        approver: 'manager.one@demo.invalid',
        amountMinor: 130_000,
        receivedOn: 70,
      },
    ],
  },
  {
    // 95 days in arrears: two months and part of the third, then nothing.
    companyId: AGENCY,
    unitCode: 'ACC-LEG-B2-02',
    steps: [
      {
        kind: 'cash',
        collector: 'manager.two@demo.invalid',
        approver: 'manager.one@demo.invalid',
        amountMinor: 95_000,
        receivedOn: 40,
      },
    ],
  },
  {
    // A part payment: two months and GH₵200 towards this one.
    companyId: AGENCY,
    unitCode: 'ACC-LEG-B2-03',
    steps: [
      {
        kind: 'cash',
        collector: 'manager.two@demo.invalid',
        approver: 'accountant@demo.invalid',
        amountMinor: 110_000,
        receivedOn: 'today',
        method: 'cheque',
      },
    ],
  },
  {
    // An overpayment: the deposit, three months and GH₵500 more, held as credit.
    companyId: AGENCY,
    unitCode: 'ACC-ELG-B1-02',
    steps: [
      {
        kind: 'transfer',
        recorder: 'manager.one@demo.invalid',
        approver: 'accountant@demo.invalid',
        into: 'owner_account',
        amountMinor: 360_000 + 3 * 180_000 + 50_000,
        receivedOn: 'today',
      },
    ],
  },
  {
    // The demo tenant's flat: the deposit and every month so far.
    companyId: AGENCY,
    unitCode: 'ACC-ELG-B1-05',
    steps: [
      {
        kind: 'transfer',
        recorder: 'manager.one@demo.invalid',
        approver: 'agency.admin@demo.invalid',
        into: 'owner_account',
        amountMinor: 440_000 + 3 * 220_000,
        receivedOn: 'today',
      },
    ],
  },
  {
    // The demo tenant's house: the deposit and the first six months in cash, approved by the
    // landlord's nominated approver; the next six months are due today.
    companyId: LANDLORD,
    unitCode: 'TEM-EST-B1-01',
    steps: [
      {
        kind: 'cash',
        collector: 'landlord@demo.invalid',
        approver: 'approver@demo.invalid',
        amountMinor: 900_000 + 6 * 450_000,
        receivedOn: 0,
      },
    ],
  },
];

/** A photo, proof or slip where the browser's presigned upload would put it. */
async function moneyUpload(
  services: { money: MoneyService; storage: StoragePort; cfg: AppConfig },
  actor: Actor,
  purpose: 'cash_photo' | 'transfer_proof' | 'banking_slip',
): Promise<string> {
  const upload = await services.money.createUpload(actor, {
    purpose,
    contentType: 'application/pdf',
    sizeBytes: PAPER_SCAN.length,
  });
  await services.storage.put({
    bucket: services.cfg.S3_BUCKET_FILES,
    key: upload.fields.key!,
    body: PAPER_SCAN,
    contentType: 'application/pdf',
  });
  return upload.uploadId;
}

/**
 * The demo money (M4a plan 4.21), once: billing's reaction to each signed lease (the worker would
 * run it too; both are idempotent), then each lease's payments, the caretaker's banking and one
 * transfer nobody has matched. A lease that already has money is left alone.
 */
async function ensureMoney(
  database: Database,
  services: {
    money: MoneyService;
    invoicing: InvoicingService;
    approvals: ApprovalsService;
    read: BillingReadService;
    subledger: SubledgerCheckService;
    storage: StoragePort;
    cfg: AppConfig;
  },
): Promise<{ payments: number; problems: number }> {
  const today = toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
  const leaseOf = async (companyId: string, unitCode: string) =>
    withCompany(database, { companyId, actorKind: 'system' }, async (tx) => {
      const rows = await tx.execute<{ id: string; start_date: string; paid: boolean }>(
        sql`select l.id, l.start_date::text, exists (select 1 from cash_record c where c.lease_id = l.id)
              or exists (select 1 from direct_receipt d where d.lease_id = l.id) as paid
            from lease l join unit u on u.id = l.unit_id
            where u.code = ${unitCode} and l.status in ('signed', 'active', 'ending', 'holding_over')
            order by l.start_date desc limit 1`,
      );
      return rows.rows[0] ?? null;
    });
  for (const companyId of [AGENCY, LANDLORD]) {
    const signed = await withCompany(database, { companyId, actorKind: 'system' }, (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from lease where status in ('signed', 'active', 'ending', 'holding_over') order by start_date`,
      ),
    );
    for (const { id } of signed.rows) await services.invoicing.onLeaseSigned(companyId, id);
  }
  let payments = 0;
  for (const demo of MONEY) {
    const lease = await leaseOf(demo.companyId, demo.unitCode);
    if (!lease || lease.paid) continue;
    for (const step of demo.steps) {
      const receivedOn =
        step.receivedOn === 'today'
          ? today
          : toIsoDate(addDays(parseBusinessDate(lease.start_date), step.receivedOn));
      const on = receivedOn > today ? today : receivedOn;
      const approver = await actorFor(database, demo.companyId, step.approver);
      if (step.kind === 'cash') {
        const collector = await actorFor(database, demo.companyId, step.collector);
        const recorded = await services.money.recordCash(collector, {
          leaseId: lease.id,
          method: step.method ?? 'cash',
          amountMinor: step.amountMinor,
          receivedOn: on,
          payerName: 'The tenant (demo)',
          chequeNumber: step.method === 'cheque' ? '004512' : null,
          chequeBank: step.method === 'cheque' ? 'GCB Bank (demo)' : null,
          photoUploadId: await moneyUpload(services, collector, 'cash_photo'),
        });
        await services.approvals.decide(approver, recorded.approvalId, { decision: 'approve' });
      } else {
        const recorder = await actorFor(database, demo.companyId, step.recorder);
        let amount = step.amountMinor;
        if (amount === 'all_invoiced') {
          const card = await services.read.leaseBilling(recorder, lease.id);
          const invoices = await services.read.invoices(recorder, { leaseId: lease.id });
          amount = invoices.reduce((sum, i) => sum + i.outstandingMinor, 0) - card.creditMinor;
        }
        const recorded = await services.money.recordTransfer(recorder, {
          leaseId: lease.id,
          receivedInto: step.into,
          amountMinor: amount,
          receivedOn: on,
          senderReference: `DEMO ${demo.unitCode}`,
          proofUploadId: await moneyUpload(services, recorder, 'transfer_proof'),
        });
        await services.approvals.decide(approver, recorded.approvalId, { decision: 'approve' });
      }
      payments += 1;
    }
  }
  // The caretaker Kojo banks one of the two cash payments he holds; the other stays in hand.
  const kojo = await actorFor(database, AGENCY, KOJO);
  const banked = await withCompany(database, { companyId: AGENCY, actorKind: 'system' }, (tx) =>
    tx.execute<{ n: number }>(
      sql`select count(*)::int as n from cash_banking where collector_person_id = ${kojo.kind === 'staff' ? kojo.personId : null}`,
    ),
  );
  if (kojo.kind === 'staff' && banked.rows[0]!.n === 0) {
    const ownerId = (
      await withCompany(database, { companyId: AGENCY, actorKind: 'system' }, (tx) =>
        tx
          .select({ id: schema.owner.id })
          .from(schema.owner)
          .where(eq(schema.owner.reference, 'OWN-01')),
      )
    )[0]?.id;
    const holding = (await services.read.collectorsCash(kojo)).find((c) => c.ownerId === ownerId);
    if (ownerId && holding && holding.heldMinor >= 80_000) {
      const banking = await services.money.recordBanking(kojo, {
        collectorPersonId: kojo.personId,
        ownerId,
        bankedInto: 'owner_account',
        amountMinor: 80_000,
        bankedOn: today,
        slipUploadId: await moneyUpload(services, kojo, 'banking_slip'),
      });
      const approver = await actorFor(database, AGENCY, 'manager.one@demo.invalid');
      await services.approvals.decide(approver, banking.approvalId, { decision: 'approve' });
    }
  }
  // One transfer into the agency's account that nobody has matched to a lease yet (P23).
  const unmatched = await withCompany(database, { companyId: AGENCY, actorKind: 'system' }, (tx) =>
    tx.execute<{ n: number }>(
      sql`select count(*)::int as n from direct_receipt where sender_reference = 'UNKNOWN TRF 0001 (demo)'`,
    ),
  );
  if (unmatched.rows[0]!.n === 0) {
    const accountant = await actorFor(database, AGENCY, 'accountant@demo.invalid');
    const recorded = await services.money.recordTransfer(accountant, {
      receivedInto: 'agency_account',
      amountMinor: 50_000,
      receivedOn: today,
      senderReference: 'UNKNOWN TRF 0001 (demo)',
      note: 'Arrived without a reference',
      proofUploadId: await moneyUpload(services, accountant, 'transfer_proof'),
    });
    const admin = await actorFor(database, AGENCY, 'agency.admin@demo.invalid');
    await services.approvals.decide(admin, recorded.approvalId, { decision: 'approve' });
  }
  let problems = 0;
  for (const companyId of [AGENCY, LANDLORD]) {
    await services.invoicing.generateAll(companyId, today);
    await services.invoicing.accrueAll(companyId, today);
    problems += (await services.subledger.check(companyId)).mismatches.length;
  }
  return { payments, problems };
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
  const storage = app.get<StoragePort>(STORAGE_PORT);
  await storage.ensureBuckets({ files: cfg.S3_BUCKET_FILES, evidence: cfg.S3_BUCKET_EVIDENCE });
  const leases = await ensureTenancies(database, {
    tenants: app.get(TenantsService),
    leases: app.get(LeasesService),
    storage,
    cfg,
  });
  const signing = await ensureSigningLease(database, {
    tenants: app.get(TenantsService),
    leases: app.get(LeasesService),
    signing: app.get(LeaseSigningService),
  });
  const money = await ensureMoney(database, {
    money: app.get(MoneyService),
    invoicing: app.get(InvoicingService),
    approvals: app.get(ApprovalsService),
    read: app.get(BillingReadService),
    subledger: app.get(SubledgerCheckService),
    storage,
    cfg,
  });
  console.log(`Seeded ${COMPANIES.length} companies and ${PEOPLE.length} people.`);
  console.log(
    `Register: ${created} new properties (agency: ACC-LEG, ACC-ELG, ACC-OSU; landlord: TEM-EST).`,
  );
  console.log(
    `Tenancies: ${leases} new paper leases of ${TENANCIES.length}; +233 20 000 0021 rents from both companies.`,
  );
  console.log(
    signing
      ? `E-signing: ${SIGNING_UNIT} issued for signature; the worker sends the links (tenant +233 20 000 0040).`
      : `E-signing: ${SIGNING_UNIT} already has its lease.`,
  );
  console.log(
    `Money: ${money.payments} new payments; the sub-ledger check found ${money.problems} mismatches.`,
  );
  console.log(`Staff password: ${DEMO_PASSWORD}`);
  console.log(
    `TOTP for every demo staff member: otpauth://totp/Rent%20Platform:demo?secret=${base32(DEMO_TOTP_SECRET)}&issuer=Rent%20Platform`,
  );
  console.log('Tenant sign-in: +233 20 000 0021; read the code at http://localhost:4010');
} finally {
  await app.close();
}
