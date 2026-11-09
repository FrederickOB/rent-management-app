/**
 * Accra demo dataset (CLAUDE.md section 14). M1 seeded companies and users; M2 adds owners,
 * properties, units, meters and each person's scope; M3 adds tenants and their leases, recorded
 * as signed on paper (decision 7), and one lease out for e-signing; M4a adds their money; M4b adds
 * settlement accounts and agreements, provider payments through the fake provider (some through
 * the pay page, some with no intent), a settlement with its P22 entries, and one reconciliation
 * exception, and reports the auto-match rate (M4b done criterion 3). M5 adds rent tax on every
 * receipt (the tax module's hooks), the commercial tenant's withholding with one certificate
 * confirmed and one waiting, a GRA payment settling part of an owner's rent tax, a VAT payment,
 * one early termination with its refund waiting for approval, and a second landlord company under
 * `advance_rent_policy = warn` with a flagged advance (plan 5.10). M6 adds messaging (plan 4.14,
 * scripts/seed-messaging.ts): WhatsApp numbers and template approvals, consent and a STOP, the
 * inbox's conversations through the real pipeline, a reported repair, a broadcast and the plans.
 * M9 adds owner reporting (plan 4.10, scripts/seed-reporting.ts): the agency's two owners' fee
 * terms, charged on every receipt, fixed fees, last month's statements issued with one later
 * correction, a remittance with fees retained, an owner funding and the dashboards' rollup. Every
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
import { allocate, format, money as moneyOf, multiplyBps } from '@rent/domain/money';
import { defaultCompanySettings, type CompanySettings } from '@rent/domain/settings';
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
import { EntitlementsService } from '../src/companies/entitlements.service';
import {
  ArtisansService,
  ExpensesService,
  InspectionsService,
  MaintenanceModule,
  MaintenanceService,
} from '../src/maintenance';
import { MoveInReportService, MoveOutModule, MoveOutService } from '../src/moveout';
import {
  BroadcastsService,
  InboundService,
  InboxService,
  MessagingConsentService,
  MessagingModule,
  MessagingSettingsService,
} from '../src/messaging';
import { ensureMessaging } from './seed-messaging';
import { ensureMaintenance } from './seed-maintenance';
import { ensureFeeTerms, ensureReporting } from './seed-reporting';
import { ensureSubscriptions } from './seed-subscription';
import {
  ManagementFeesService,
  OwnerMoneyService,
  OwnerStatementsService,
  ReportingDashboardModule,
  ReportingMoneyModule,
  ReportingRollupService,
  ReportingStatementsModule,
} from '../src/reporting';
import { ensureNotices } from './seed-notices';
import {
  NoticeAcknowledgementsService,
  NoticesModule,
  NoticesService,
  NoticeTrackingService,
} from '../src/notices';
import { TasksModule } from '../src/tasks';
import { AuditService } from '../src/audit';
import { DocumentsService } from '../src/documents';
import { EsignService } from '../src/esign';
import { IdentityModule, PersonAccounts } from '../src/identity';
import {
  MetersService,
  PortfolioModule,
  RegisterReadService,
  RegisterService,
  type NewProperty,
} from '../src/portfolio';
import {
  LeaseLifecycleService,
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
  TerminationService,
} from '../src/billing';
import { RulesService } from '../src/rules';
import {
  SubscriptionBillingService,
  SubscriptionCoreService,
  SubscriptionLifecycleService,
  SubscriptionModule,
  SubscriptionPaymentsService,
} from '../src/subscription';
import { GraService, TaxModule, TaxReportService, WithholdingService } from '../src/tax';
import { LedgerModule } from '../src/ledger';
import {
  PayLinksService,
  PaymentsModule,
  PayPageService,
  ReconciliationService,
  SettlementAccountsService,
  WebhooksService,
} from '../src/payments';
import { chargeReference } from '@rent/domain/payments';
import type { PaymentProviders } from '../src/core/payment-providers';
import { PAYMENT_PROVIDERS } from '../src/core/tokens';
import type { Clock } from '../src/core/clock';
import type { PaymentsPort, PaymentsTestControls, PaymentWebhookRequest } from '@rent/integrations';
import { generate } from 'otplib';

const config = loadConfig();
const host = new URL(config.DATABASE_URL).hostname;
if (config.NODE_ENV === 'production' || !['localhost', '127.0.0.1', 'postgres'].includes(host)) {
  console.error('The demo seed runs only against a local development database.');
  process.exit(1);
}

/** One documented TOTP secret for every demo staff member (dev only; see README). */
export const DEMO_TOTP_SECRET = 'rent-demo-totp-secret-2026-local';
export const DEMO_PASSWORD = 'demo-password-2026';

const COMPANIES: {
  id: string;
  kind: CompanyKind;
  legalName: string;
  displayName: string;
  /** Settings other than the PRD defaults (M5: one company with advance warnings on). */
  settings?: Partial<CompanySettings>;
}[] = [
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
  // M5 (plan 5.10): a landlord whose company flags advances over the limit (AR-05, OQ-28), so the
  // compliance report has data while the main companies stay `off`.
  {
    id: '019a3000-0000-7000-8000-000000000004',
    kind: 'landlord',
    legalName: 'Abokobi Homes (demo, advance warnings on)',
    displayName: 'Abokobi Homes',
    settings: { advanceRentPolicy: 'warn' },
  },
];
const [PLATFORM, AGENCY, LANDLORD, ABOKOBI] = COMPANIES.map((c) => c.id) as [
  string,
  string,
  string,
  string,
];
/** The companies that bill rent (every one but the platform). */
const BILLING_COMPANIES = [AGENCY, LANDLORD, ABOKOBI];

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
  // M5: the landlord with advance warnings on, and her manager (a second person for cash).
  {
    name: 'Akua Abokobi-Landlord (demo)',
    email: 'abokobi.landlord@demo.invalid',
    staff: true,
    memberships: [{ companyId: ABOKOBI, role: 'owner' }],
  },
  {
    name: 'Fiifi Abokobi-Manager (demo)',
    email: 'abokobi.manager@demo.invalid',
    staff: true,
    memberships: [{ companyId: ABOKOBI, role: 'property_manager' }],
  },
];

/**
 * The seed's clock: the system clock, which M4b moves back while it records settlement accounts,
 * so they are approved and past their 24 hours by the time the seed ends (ADR-008).
 */
const seedClock: Clock & { offsetMs: number } = {
  offsetMs: 0,
  now() {
    return new Date(Date.now() + this.offsetMs);
  },
};

@Module({
  imports: [
    CoreModule.forRoot({ config, clock: seedClock, applicationName: 'rent-seed' }),
    IdentityModule,
    PortfolioModule,
    TenancyModule,
    LedgerModule,
    BillingModule,
    PaymentsModule,
    // M5: rent tax is assessed on every receipt once this module starts (its billing hooks).
    TaxModule,
    // M6: messaging, the bot and the maintenance stub (plan 4.14).
    MaintenanceModule,
    MessagingModule,
    // M7: staff tasks and legal notices (plan 4.13).
    TasksModule,
    NoticesModule,
    MoveOutModule,
    // M9: management fees on every receipt once this module starts (its billing hooks), owner
    // statements, remittances and the dashboards' rollup (plan 4.10).
    ReportingMoneyModule,
    ReportingStatementsModule,
    ReportingDashboardModule,
    // M10: subscriptions, their invoices and paying (plan 4.11).
    SubscriptionModule,
  ],
})
class SeedModule {}

async function ensureCompanies(database: Database) {
  for (const c of COMPANIES) {
    const existing = await withCompany(database, { companyId: c.id, actorKind: 'system' }, (tx) =>
      tx.select({ id: schema.company.id }).from(schema.company).where(eq(schema.company.id, c.id)),
    );
    if (existing.length > 0) continue;
    const settings = { ...defaultCompanySettings(), ...(c.settings ?? {}) };
    await withSystem(database, { actorKind: 'system' }, (tx) =>
      tx.execute(
        sql`select app.create_company(${c.id}::uuid, ${c.kind}, ${c.legalName}, ${c.displayName}, 'GH', 'Africa/Accra', ${c.displayName}, ${JSON.stringify(settings)}::jsonb)`,
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

/** M5: the warn landlord's one house (Abokobi, a code no other demo property uses). */
const ABOKOBI_PROPERTIES: DemoProperty[] = [
  {
    areaCode: 'ACC',
    propertyPart: 'ABK',
    name: 'Abokobi family house (demo)',
    propertyType: 'house',
    use: 'residential',
    address: {
      region: 'Greater Accra',
      town: 'Abokobi',
      latitude: '5.7366',
      longitude: '-0.2008',
    },
    units: [{ unitType: 'detached_house', count: 1, bedrooms: 3, amenities: ['parking'] }],
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
  const abokobi = await actorFor(database, ABOKOBI, 'abokobi.landlord@demo.invalid');
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
    [abokobi, ABOKOBI_PROPERTIES],
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
  for (const companyId of BILLING_COMPANIES)
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
  readonly cycle: 'monthly' | 'quarterly' | 'six_monthly' | 'annual' | 'two_yearly';
  readonly initialAdvanceMonths?: number;
  readonly depositMinor?: number;
  readonly serviceChargeMonthlyMinor?: number;
  /** M5: a break clause from the lease start that credits the unused days (AR-04). */
  readonly breakClauseCreditsUnusedDays?: boolean;
}

const smsConsent = { sms: true };

// Fictional tenancies on the M2 units (M3 plan 4.18). Phones come from the fake +233 20 000 00xx
// block, and no ID number is seeded. The units the M2 end-to-end tests change by hand stay free:
// ACC-LEG-B2-06 (under repair), ACC-OSU-G-03, ACC-OSU-G-04 (not lettable) and ACC-ELG-B1-08.
const TENANCIES: DemoTenancy[] = [
  // M8 (plan 4.14): two chamber-and-hall tenancies for the move-out demos, with deposits paid.
  {
    companyId: AGENCY,
    actorEmail: 'manager.one@demo.invalid',
    what: 'a move-out in progress (M8)',
    tenant: {
      kind: 'individual',
      displayName: 'Nana Move-Out (demo)',
      phone: '+233200000061',
      consent: smsConsent,
    },
    unitCode: 'ACC-LEG-B1-05',
    startedMonthsAgo: 4,
    months: 12,
    monthlyRentMinor: 60_000,
    cycle: 'monthly',
    depositMinor: 120_000,
    billFromStart: true,
  },
  {
    companyId: AGENCY,
    actorEmail: 'manager.one@demo.invalid',
    what: 'an early end through the move-out flow (M8)',
    tenant: {
      kind: 'individual',
      displayName: 'Akosua Early-Out (demo)',
      phone: '+233200000062',
      consent: smsConsent,
    },
    unitCode: 'ACC-LEG-B1-06',
    startedMonthsAgo: 4,
    months: 12,
    monthlyRentMinor: 60_000,
    cycle: 'monthly',
    depositMinor: 120_000,
    billFromStart: true,
  },
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
  // M4b: the demo tenant's second flat from the agency, on the two-yearly cycle (decision 9),
  // paid two years ahead through the pay page; a MoMo payer; and an office tenant whose payment
  // arrived with no reference, for the unmatched queue's suggestions.
  {
    companyId: AGENCY,
    actorEmail: 'manager.one@demo.invalid',
    what: 'the demo tenant’s second flat, billed every two years and paid by card through the pay page',
    tenant: {
      kind: 'individual',
      displayName: 'Ama Tenant (demo)',
      phone: '+233200000021',
      occupation: 'Accountant',
      consent: smsConsent,
    },
    unitCode: 'ACC-ELG-B1-06',
    startedMonthsAgo: 0,
    months: 24,
    monthlyRentMinor: 160_000,
    cycle: 'two_yearly',
    billFromStart: true,
  },
  {
    companyId: AGENCY,
    actorEmail: 'manager.one@demo.invalid',
    what: 'a monthly payer who pays by MoMo through the pay page',
    tenant: {
      kind: 'individual',
      displayName: 'Abena MoMo (demo)',
      phone: '+233200000041',
      occupation: 'Trader',
      consent: smsConsent,
    },
    unitCode: 'ACC-ELG-B1-07',
    startedMonthsAgo: 1,
    months: 12,
    monthlyRentMinor: 120_000,
    cycle: 'monthly',
    billFromStart: true,
  },
  {
    companyId: AGENCY,
    actorEmail: 'manager.two@demo.invalid',
    what: 'an office tenant whose MoMo payment arrived with no reference (the unmatched queue)',
    tenant: {
      kind: 'individual',
      displayName: 'Kwesi Queue (demo)',
      phone: '+233200000042',
      occupation: 'Consultant',
      consent: smsConsent,
    },
    unitCode: 'ACC-OSU-F1-01',
    startedMonthsAgo: 0,
    months: 12,
    monthlyRentMinor: 90_000,
    cycle: 'monthly',
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
  // M5 (plan 5.10): an early termination. Six months paid ahead at the start; the tenant moved out
  // ten days ago, in the month that started 15 days ago, under a break clause that credits the
  // unused days. Its settlement and refund wait for a second person (ensureTax).
  {
    companyId: AGENCY,
    actorEmail: 'manager.one@demo.invalid',
    what: 'an early termination: six months paid ahead, moved out ten days ago (AR-04)',
    tenant: {
      kind: 'individual',
      displayName: 'Kweku Early-End (demo)',
      phone: '+233200000043',
      occupation: 'Banker',
      consent: smsConsent,
    },
    unitCode: 'ACC-LEG-B1-03',
    startedMonthsAgo: 3,
    anchorDaysAgo: 15,
    months: 12,
    monthlyRentMinor: 60_000,
    cycle: 'monthly',
    billFromStart: true,
    breakClauseCreditsUnusedDays: true,
  },
  // M5: the warn landlord's tenant, who pays the whole year ahead in cash (flagged, AR-05).
  {
    companyId: ABOKOBI,
    actorEmail: 'abokobi.manager@demo.invalid',
    what: 'a year paid ahead in a company with advance warnings on (flagged over the limit)',
    tenant: {
      kind: 'individual',
      displayName: 'Yaa Year-Ahead (demo)',
      phone: '+233200000044',
      occupation: 'Lecturer',
      consent: smsConsent,
    },
    unitCode: 'ACC-ABK-B1-01',
    startedMonthsAgo: 0,
    months: 12,
    monthlyRentMinor: 100_000,
    cycle: 'monthly',
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
      // A break the tenant may use from the second month, crediting the unused days (AR-04).
      breakClause: t.breakClauseCreditsUnusedDays
        ? {
            fromDate: toIsoDate(addMonths(parseBusinessDate(start), 1)),
            party: 'tenant',
            noticeDays: 30,
            creditUnusedDays: true,
          }
        : null,
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
  /**
   * M5 (TX-04): the tenant withheld tax on the rent of this many of its first started months,
   * at the rule's rate, recorded before its money so the money pays the rest (BC-07).
   */
  readonly withholdMonths?: number;
  readonly steps: readonly MoneyStep[];
}

const KOJO = '+233200000011';
const MONEY: DemoMoney[] = [
  // M8: each move-out demo paid its deposit and most of its rent in cash on the first day.
  ...(
    [
      ['ACC-LEG-B1-05', 300_000],
      ['ACC-LEG-B1-06', 400_000],
    ] as const
  ).map(([unitCode, amountMinor]): DemoMoney => ({
    companyId: AGENCY,
    unitCode,
    steps: [
      {
        kind: 'cash',
        collector: 'manager.one@demo.invalid',
        approver: 'manager.two@demo.invalid',
        amountMinor,
        receivedOn: 0,
      },
    ],
  })),
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
    // The commercial company tenant: its deposit and both quarters with VAT, into the agency's
    // account, net of the 15% it withheld on its first two months' rent (M5, TX-04).
    companyId: AGENCY,
    unitCode: 'ACC-OSU-G-01',
    withholdMonths: 2,
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
    // M5: the early termination's six months ahead, in cash at the start.
    companyId: AGENCY,
    unitCode: 'ACC-LEG-B1-03',
    steps: [
      {
        kind: 'cash',
        collector: 'manager.one@demo.invalid',
        approver: 'manager.two@demo.invalid',
        amountMinor: 6 * 60_000,
        receivedOn: 0,
      },
    ],
  },
  {
    // M5: twelve months ahead in cash, over the six-month limit, in the company under `warn`.
    companyId: ABOKOBI,
    unitCode: 'ACC-ABK-B1-01',
    steps: [
      {
        kind: 'cash',
        collector: 'abokobi.manager@demo.invalid',
        approver: 'abokobi.landlord@demo.invalid',
        amountMinor: 12 * 100_000,
        receivedOn: 0,
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
 * M5 (TX-04, P19): a corporate tenant's withholding on the rent of its first started months, at
 * the rate the rules table gives for the lease's use as of today (`withholding_tax.rate.*`,
 * unverified), recorded by a manager before its money so the money pays everything else. Once:
 * a lease with withholding already is left alone.
 */
async function withholdFirstMonths(
  database: Database,
  services: { withholding: WithholdingService; rules: RulesService },
  demo: DemoMoney,
  leaseId: string,
  today: string,
): Promise<void> {
  const facts = await withCompany(
    database,
    { companyId: demo.companyId, actorKind: 'system' },
    async (tx) => {
      const done = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from withholding where lease_id = ${leaseId}`,
      );
      const lines = await tx.execute<{ id: string; amount_minor: string }>(
        sql`select il.id, il.amount_minor from invoice_line il
            join invoice_line_accrual a on a.company_id = il.company_id and a.invoice_line_id = il.id
            where il.lease_id = ${leaseId} and il.kind = 'rent' order by il.period_start limit ${demo.withholdMonths ?? 0}`,
      );
      const [lease] = await tx
        .select({ use: schema.lease.use })
        .from(schema.lease)
        .where(eq(schema.lease.id, leaseId));
      return { done: done.rows[0]!.n > 0, lines: lines.rows, use: lease?.use ?? 'commercial' };
    },
  );
  if (facts.done) return;
  const rule = await services.rules.resolve(
    'GH',
    `withholding_tax.rate.${facts.use}`,
    parseBusinessDate(today),
  );
  const bps = (rule.value as { bps: number }).bps;
  const manager = await actorFor(database, demo.companyId, 'manager.two@demo.invalid');
  for (const line of facts.lines)
    await services.withholding.record(manager, {
      leaseId,
      valueDate: today,
      lines: [
        {
          lineId: line.id,
          amountMinor: multiplyBps(moneyOf(Number(line.amount_minor)), bps).amountMinor,
        },
      ],
      note: 'Withheld by the tenant on this month’s rent (demo)',
    });
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
    withholding: WithholdingService;
    rules: RulesService;
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
  for (const companyId of BILLING_COMPANIES) {
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
    if (demo.withholdMonths) await withholdFirstMonths(database, services, demo, lease.id, today);
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
  for (const companyId of BILLING_COMPANIES) {
    await services.invoicing.generateAll(companyId, today);
    await services.invoicing.accrueAll(companyId, today);
    problems += (await services.subledger.check(companyId)).mismatches.length;
  }
  return { payments, problems };
}

// Provider payments (M4b plan 4.13): settlement accounts and agreements, then payments through
// the fake provider, then a settlement and P22. Account numbers are fictional.
const DEMO_ACCOUNTS: {
  readonly companyId: string;
  readonly requester: string;
  readonly approver: string | null;
  readonly holder: 'owner' | 'agency';
  readonly ownerReference: string | null;
  readonly accountNumber: string;
  readonly accountName: string;
}[] = [
  {
    companyId: AGENCY,
    requester: 'agency.admin@demo.invalid',
    approver: null,
    holder: 'owner',
    ownerReference: 'OWN-01',
    accountNumber: '0010000000101',
    accountName: 'Owner A (demo)',
  },
  {
    companyId: AGENCY,
    requester: 'agency.admin@demo.invalid',
    approver: null,
    holder: 'owner',
    ownerReference: 'OWN-02',
    accountNumber: '0010000000202',
    accountName: 'Owner B (demo)',
  },
  {
    companyId: AGENCY,
    requester: 'agency.admin@demo.invalid',
    approver: null,
    holder: 'agency',
    ownerReference: null,
    accountNumber: '0010000000303',
    accountName: 'Agency client account (demo)',
  },
  {
    companyId: LANDLORD,
    requester: 'landlord@demo.invalid',
    approver: 'approver@demo.invalid',
    holder: 'owner',
    ownerReference: null,
    accountNumber: '0010000000404',
    accountName: 'Kwabena Landlord (demo)',
  },
];

/** The demo TOTP code now: the agency's sole admin confirms her own requests after cooling off (OQ-29). */
const demoTotp = async (): Promise<string> =>
  (await generate({ secret: base32(DEMO_TOTP_SECRET) })) as unknown as string;

async function ensureSettlementAccounts(
  database: Database,
  services: { accounts: SettlementAccountsService; approvals: ApprovalsService },
): Promise<number> {
  const owners = async (companyId: string) =>
    withCompany(database, { companyId, actorKind: 'system' }, (tx) =>
      tx.select({ id: schema.owner.id, reference: schema.owner.reference }).from(schema.owner),
    );
  const pending: {
    companyId: string;
    accountId: string;
    approvalId: string;
    approver: string | null;
    requester: string;
  }[] = [];
  // Requested 49 hours ago and confirmed 25 hours ago, on the seed's clock, so each is past its
  // 24 hours now: the database itself refuses to activate one sooner.
  seedClock.offsetMs = -49 * 3_600_000;
  try {
    for (const demo of DEMO_ACCOUNTS) {
      const exists = await withCompany(
        database,
        { companyId: demo.companyId, actorKind: 'system' },
        (tx) =>
          tx.execute<{ n: number }>(
            sql`select count(*)::int as n from settlement_account where account_name = ${demo.accountName}`,
          ),
      );
      if (exists.rows[0]!.n > 0) continue;
      const list = await owners(demo.companyId);
      const ownerId =
        demo.holder !== 'agency'
          ? (demo.ownerReference ? list.find((o) => o.reference === demo.ownerReference) : list[0])
              ?.id
          : null;
      const requester = await actorFor(database, demo.companyId, demo.requester);
      const { accountId, approvalId } = await services.accounts.request(requester, {
        holder: demo.holder,
        ownerId: ownerId ?? null,
        bankCode: 'FAKEBANK1',
        accountNumber: demo.accountNumber,
        accountName: demo.accountName,
      });
      pending.push({
        companyId: demo.companyId,
        accountId,
        approvalId,
        approver: demo.approver,
        requester: demo.requester,
      });
    }
    seedClock.offsetMs = -25 * 3_600_000;
    for (const p of pending) {
      const mode = (
        await withCompany(database, { companyId: p.companyId, actorKind: 'system' }, (tx) =>
          tx.execute<{ mode: string }>(
            sql`select mode from approval_request where id = ${p.approvalId}`,
          ),
        )
      ).rows[0]?.mode;
      if (mode === 'single_user')
        // Nobody else in the agency may decide a company-level request: its admin confirms her own
        // after the cooling-off, with her authenticator code (OQ-29).
        await services.approvals.decide(
          await actorFor(database, p.companyId, p.requester),
          p.approvalId,
          {
            decision: 'self_confirm',
            code: await demoTotp(),
          },
        );
      else
        await services.approvals.decide(
          await actorFor(database, p.companyId, p.approver ?? 'owner.accra@demo.invalid'),
          p.approvalId,
          { decision: 'approve' },
        );
    }
  } finally {
    seedClock.offsetMs = 0;
  }
  for (const p of pending) await services.accounts.ready(p.companyId, p.accountId);
  // Where each agency owner's rent goes (decision 6): owner A's own account, owner B's through
  // the agency's client account. Each is a request a second person approves, in force 24 hours
  // after approval (M4b review item 1): asked 74 hours ago on the seed's clock and confirmed by
  // the agency's sole admin after her cooling-off 49 hours ago (OQ-29), so in force today.
  const admin = await actorFor(database, AGENCY, 'agency.admin@demo.invalid');
  const agreements = await services.accounts.agreements(admin);
  const asked: string[] = [];
  seedClock.offsetMs = -74 * 3_600_000;
  try {
    const askedOn = toIsoDate(businessDateOf(instantFrom(seedClock.now()), 'Africa/Accra'));
    for (const owner of await owners(AGENCY)) {
      const current = agreements.find((a) => a.ownerId === owner.id);
      if (current?.destination || current?.openRequest) continue;
      const view = await services.accounts.setAgreement(admin, owner.id, {
        destination: owner.reference === 'OWN-01' ? 'owner_account' : 'agency_client_account',
        effectiveFrom: askedOn,
      });
      if (view.openRequest) asked.push(view.openRequest.approvalId);
    }
    seedClock.offsetMs = -49 * 3_600_000;
    for (const approvalId of asked)
      await services.approvals.decide(admin, approvalId, {
        decision: 'self_confirm',
        code: await demoTotp(),
      });
  } finally {
    seedClock.offsetMs = 0;
  }
  return pending.length;
}

type FakePort = PaymentsPort & PaymentsTestControls;

/**
 * Provider payments through the fake provider (M4b plan 4.13), once: two through the pay page
 * (with intent metadata), one that names a lease's payment reference, two with neither (the
 * unmatched queue, one from the tenant's own phone), one paid short of what was asked (a
 * reconciliation exception), then a settlement with its P22 entries. Returns the auto-match rate.
 */
async function ensureProviderPayments(
  database: Database,
  services: {
    providers: PaymentProviders;
    links: PayLinksService;
    page: PayPageService;
    webhooks: WebhooksService;
    reconciliation: ReconciliationService;
    read: BillingReadService;
  },
): Promise<{
  created: boolean;
  provider: { auto: number; total: number };
  transfers: { withLease: number; total: number };
}> {
  const port = services.providers.get('paystack') as FakePort;
  const sys = { companyId: AGENCY, actorKind: 'system' as const };
  const already = await withCompany(database, sys, (tx) =>
    tx.execute<{ n: number }>(sql`select count(*)::int as n from payment_intent`),
  );
  const created = already.rows[0]!.n === 0;
  const leaseOf = async (unitCode: string) =>
    (
      await withCompany(database, sys, (tx) =>
        tx.execute<{ id: string }>(
          sql`select l.id from lease l join unit u on u.id = l.unit_id where u.code = ${unitCode}
              and l.status in ('signed', 'active', 'ending', 'holding_over') order by l.start_date desc limit 1`,
        ),
      )
    ).rows[0]?.id;
  const deliver = async (webhook: PaymentWebhookRequest | null) => {
    if (!webhook) return;
    await services.webhooks.intake('paystack', Buffer.from(webhook.rawBody), webhook.headers);
    const claimed = await withSystem(database, {}, (tx) =>
      tx.execute<{ id: string }>(sql`select id from app.claim_webhook_inbox(100)`),
    );
    for (const row of claimed.rows) await services.webhooks.process(row.id);
  };
  /** Pays a lease's oldest open invoice through the pay page; `paid` defaults to what was asked. */
  const throughPage = async (
    unitCode: string,
    method: 'momo' | 'card',
    amount: (due: number, max: number) => number,
    paid?: (asked: number) => number,
  ) => {
    const leaseId = await leaseOf(unitCode);
    if (!leaseId) return;
    const invoices = await withCompany(database, sys, (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from invoice where lease_id = ${leaseId} order by due_date, number`,
      ),
    );
    for (const { id } of invoices.rows) {
      const url = await withCompany(database, sys, async (tx) => {
        const invoice = await services.links.invoice(tx, id);
        if (await services.links.unavailableReason(tx, AGENCY, invoice)) return null;
        return (await services.links.mint(tx, invoice)).url;
      });
      if (!url) continue;
      const token = url.split('/p/')[1]!;
      const page = await services.page.open(token, { ip: '127.0.0.1', userAgent: 'seed' });
      const asked = amount(page.dueNowMinor, page.amounts.maxMinor);
      const intent = await services.page.start(
        token,
        { ip: '127.0.0.1', userAgent: 'seed' },
        {
          amountMinor: asked,
          method,
          ...(method === 'momo'
            ? { momo: { phone: '024 000 0041', network: 'mtn' as const } }
            : {}),
          submissionId: `seed-${unitCode}-${id}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64),
        },
      );
      await deliver(
        await port.completeCharge(chargeReference(intent.intentId), {
          status: 'success',
          feesMinor: Math.floor(asked / 50),
          ...(paid ? { amountMinor: paid(asked) } : {}),
        }),
      );
      return;
    }
  };
  const subaccount = async (accountName: string) =>
    (
      await withCompany(database, sys, (tx) =>
        tx.execute<{ code: string }>(
          sql`select s.subaccount_code as code from provider_subaccount s join settlement_account a on a.id = s.settlement_account_id
              where a.account_name = ${accountName} and s.provider = 'paystack'`,
        ),
      )
    ).rows[0]?.code;
  if (created) {
    // Through the pay page: Abena by MoMo, her first month, but GH₵200 short of what the page
    // asked (posted as received and flagged for a person: the reconciliation exception); Ama two
    // years ahead by card.
    await throughPage(
      'ACC-ELG-B1-07',
      'momo',
      (due) => Math.min(due, 120_000),
      (asked) => asked - 20_000,
    );
    await throughPage('ACC-ELG-B1-06', 'card', (_due, max) => max);
    const ownerAccount = await subaccount('Owner A (demo)');
    const agencyAccount = await subaccount('Agency client account (demo)');
    const abena = await leaseOf('ACC-ELG-B1-07');
    const admin = await actorFor(database, AGENCY, 'agency.admin@demo.invalid');
    if (ownerAccount && abena) {
      // The next month by MoMo straight to the owner's subaccount, naming her payment reference.
      const reference = (await services.read.leaseBilling(admin, abena)).paymentReference;
      await deliver(
        (
          await port.payExternal({
            subaccountCode: ownerAccount,
            amountMinor: 120_000,
            channel: 'momo',
            payerPhone: '+233200000041',
            narration: `Rent ${reference ?? ''}`,
            feesMinor: 2_400,
          })
        ).webhook,
      );
      // Money from a phone nobody knows, into owner A's account: it waits for a person.
      await deliver(
        (
          await port.payExternal({
            subaccountCode: ownerAccount,
            amountMinor: 75_000,
            channel: 'momo',
            payerPhone: '+233200000099',
            feesMinor: 1_500,
          })
        ).webhook,
      );
    }
    const kwesi = await leaseOf('ACC-OSU-F1-01');
    if (agencyAccount && kwesi) {
      // Kwesi's month, from his own phone with no reference, into the agency's client account.
      const due = (await services.read.leaseBilling(admin, kwesi)).dueNowMinor;
      await deliver(
        (
          await port.payExternal({
            subaccountCode: agencyAccount,
            amountMinor: due > 0 ? due : 90_000,
            channel: 'momo',
            payerPhone: '+233200000042',
          })
        ).webhook,
      );
    }
    // The provider pays out, and P22 posts per book.
    for (const settlement of await port.settle())
      await services.reconciliation.settlement('paystack', settlement);
  }
  const counts = await withCompany(database, sys, (tx) =>
    tx.execute<{ kind: string; auto: number; total: number }>(
      sql`select 'provider' as kind,
            count(*) filter (where p.source_type = 'payment_intent' or p.lease_id is not null)::int as auto,
            count(*)::int as total
          from payment p where p.source_type in ('payment_intent', 'provider_charge')
          union all
          select 'transfer', count(*) filter (where d.lease_id is not null)::int, count(*)::int
          from direct_receipt d`,
    ),
  );
  const row = (kind: string) => counts.rows.find((r) => r.kind === kind) ?? { auto: 0, total: 0 };
  return {
    created,
    provider: { auto: row('provider').auto, total: row('provider').total },
    transfers: { withLease: row('transfer').auto, total: row('transfer').total },
  };
}

/** A file where the browser's presigned upload would put it (M5 evidence). */
async function evidenceUpload(
  services: { storage: StoragePort; cfg: AppConfig },
  create: (input: { contentType: string; sizeBytes: number }) => Promise<{
    uploadId: string;
    fields: Record<string, string>;
  }>,
): Promise<string> {
  const upload = await create({ contentType: 'application/pdf', sizeBytes: PAPER_SCAN.length });
  await services.storage.put({
    bucket: services.cfg.S3_BUCKET_FILES,
    key: upload.fields.key!,
    body: PAPER_SCAN,
    contentType: 'application/pdf',
  });
  return upload.uploadId;
}

/**
 * M5 (plan 5.10), once each: the commercial tenant's withholding certificates (one confirmed by a
 * user for its owner, never its uploader; one waiting), a GRA payment settling the oldest of owner
 * A's open rent tax items, a VAT payment for the VAT-registered owner's first month, and the early
 * termination: the move-out recorded, billing's end of lease run, and its settlement and refund
 * asked for, waiting for a second person.
 */
async function ensureTax(
  database: Database,
  services: {
    withholding: WithholdingService;
    gra: GraService;
    reports: TaxReportService;
    termination: TerminationService;
    lifecycle: LeaseLifecycleService;
    invoicing: InvoicingService;
    storage: StoragePort;
    cfg: AppConfig;
  },
): Promise<void> {
  const today = toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
  const sys = { companyId: AGENCY, actorKind: 'system' as const };
  const manager = await actorFor(database, AGENCY, 'manager.two@demo.invalid');
  const accountant = await actorFor(database, AGENCY, 'accountant@demo.invalid');
  const owners = new Map(
    (
      await withCompany(database, sys, (tx) =>
        tx.select({ id: schema.owner.id, reference: schema.owner.reference }).from(schema.owner),
      )
    ).map((o) => [o.reference, o.id]),
  );

  // 1. Certificates for the commercial tenant's withholding (TX-04, decision 3).
  const withheld = await withCompany(database, sys, (tx) =>
    tx.execute<{ id: string; owner_id: string; certificates: number }>(
      sql`select w.id, w.owner_id,
            (select count(*)::int from withholding_certificate c where c.withholding_id = w.id) as certificates
          from withholding w order by w.value_date, w.created_at, w.id`,
    ),
  );
  for (const [i, w] of withheld.rows.entries()) {
    if (w.certificates > 0) continue;
    await services.withholding.uploadCertificate(manager, w.id, {
      uploadId: await evidenceUpload(services, (input) =>
        services.withholding.createUpload(manager, input),
      ),
      certificateNumber: `WHT-DEMO-${String(i + 1).padStart(4, '0')}`,
      issuedOn: today,
    });
  }
  const first = withheld.rows[0];
  if (first) {
    const [waiting] = (
      await withCompany(database, sys, (tx) =>
        tx.execute<{ id: string; confirmed: number }>(
          sql`select c.id, (select count(*)::int from withholding_certificate x
                where x.status = 'confirmed' and x.company_id = c.company_id) as confirmed
              from withholding_certificate c
              where c.withholding_id = ${first.id} and c.status = 'awaiting_confirmation'`,
        ),
      )
    ).rows;
    if (waiting && waiting.confirmed === 0) {
      // A user for that owner confirms it; the agency admin only for an owner with no user.
      let confirmer = await actorFor(database, AGENCY, 'agency.admin@demo.invalid');
      for (const signIn of ['owner.accra@demo.invalid', 'owner.london@demo.invalid']) {
        const candidate = await actorFor(database, AGENCY, signIn);
        if (candidate.kind === 'staff' && candidate.scope.owners?.includes(first.owner_id))
          confirmer = candidate;
      }
      await services.withholding.confirmCertificate(confirmer, waiting.id);
    }
  }

  // 2. Rent tax paid to GRA for owner A's oldest open item; the rest stays on the due list.
  const graDone = await withCompany(database, sys, (tx) =>
    tx.execute<{ n: number }>(sql`select count(*)::int as n from gra_payment`),
  );
  const ownerA = owners.get('OWN-01');
  if (graDone.rows[0]!.n === 0 && ownerA) {
    const [oldest] = await services.reports.dueList(accountant, { ownerId: ownerA });
    if (oldest)
      await services.gra.recordGraPayment(accountant, {
        ownerId: ownerA,
        paidOn: today,
        amountMinor: oldest.outstandingMinor,
        graReceiptNumber: 'GRA-DEMO-0001',
        receiptUploadId: await evidenceUpload(services, (input) =>
          services.gra.createUpload(accountant, input),
        ),
        paidFrom: 'owner_account',
        items: [{ itemId: oldest.id, amountMinor: oldest.outstandingMinor }],
        note: 'Rent tax on the oldest receipt (demo)',
      });
  }

  // 3. VAT and levies paid with the return for the VAT-registered owner's first VAT month (P33):
  // half of what it owes, so the VAT screens have a payment and a balance still to pay.
  const vatDone = await withCompany(database, sys, (tx) =>
    tx.execute<{ n: number }>(sql`select count(*)::int as n from vat_payment`),
  );
  const ownerB = owners.get('OWN-02');
  if (vatDone.rows[0]!.n === 0 && ownerB) {
    const firstVat = await withCompany(database, sys, (tx) =>
      tx.execute<{ month: string | null }>(
        sql`select to_char(min(e.value_date), 'YYYY-MM') as month from journal_entry e
            join journal_line l on l.company_id = e.company_id and l.entry_id = e.id
            join book b on b.company_id = l.company_id and b.id = l.book_id
            where e.rule = 'P32' and l.account_code = '2210' and b.owner_id = ${ownerB}`,
      ),
    );
    const month = firstVat.rows[0]?.month;
    if (month) {
      const report = await services.gra.vatReport(accountant, { ownerId: ownerB, month });
      const [half] = allocate(moneyOf(report.totals.outstandingMinor), [1, 1]);
      if (half && half.amountMinor > 0)
        await services.gra.recordVatPayment(accountant, {
          ownerId: ownerB,
          periodMonth: month,
          paidOn: today,
          amountMinor: half.amountMinor,
          graReceiptNumber: 'GRA-VAT-DEMO-0001',
          receiptUploadId: await evidenceUpload(services, (input) =>
            services.gra.createUpload(accountant, input),
          ),
          paidFrom: 'agency_account',
          note: 'VAT, NHIL and GETFund with the return (demo)',
        });
    }
  }

  // 4. The early termination (AR-04): moved out ten days ago; its refund waits for approval.
  const [early] = (
    await withCompany(database, sys, (tx) =>
      tx.execute<{ id: string; status: string; asked: number }>(
        sql`select l.id, l.status,
              (select count(*)::int from early_termination t where t.lease_id = l.id) as asked
            from lease l join unit u on u.id = l.unit_id
            where u.code = 'ACC-LEG-B1-03' and l.status <> 'cancelled'
            order by l.start_date desc limit 1`,
      ),
    )
  ).rows;
  if (early && early.asked === 0) {
    const leaseManager = await actorFor(database, AGENCY, 'manager.one@demo.invalid');
    if (['active', 'holding_over', 'ending'].includes(early.status))
      await services.lifecycle.recordMoveOut(leaseManager, early.id, {
        moveOutDate: toIsoDate(addDays(parseBusinessDate(today), -10)),
        note: 'Left early under the break clause (demo)',
      });
    await services.invoicing.onLeaseEnded(AGENCY, early.id);
    // Asked by manager.one; it waits for a second person's approval (`lease.refund`).
    await services.termination.request(leaseManager, early.id, {
      charges: [{ description: 'Agreed early termination charge (demo)', amountMinor: 50_000 }],
      deductions: [],
      note: 'The tenant gave notice under the break clause (demo)',
    });
  }
}

/** What M5 seeded, per billing company, for the summary. */
async function taxSummary(database: Database) {
  const out: string[] = [];
  for (const companyId of BILLING_COMPANIES) {
    const name = COMPANIES.find((c) => c.id === companyId)!.displayName;
    const row = (
      await withCompany(database, { companyId, actorKind: 'system' }, (tx) =>
        tx.execute<{
          items: number;
          tax: string;
          gra: number;
          gra_total: string;
          withholdings: number;
          confirmed: number;
          waiting: number;
          vat: number;
          terminations: string | null;
          flagged: number;
        }>(
          sql`select
                (select count(*)::int from rent_tax_item) as items,
                (select coalesce(sum(tax_minor), 0)::bigint from rent_tax_item) as tax,
                (select count(*)::int from gra_payment) as gra,
                (select coalesce(sum(amount_minor), 0)::bigint from gra_payment) as gra_total,
                (select count(*)::int from withholding) as withholdings,
                (select count(*)::int from withholding_certificate where status = 'confirmed') as confirmed,
                (select count(*)::int from withholding_certificate where status = 'awaiting_confirmation') as waiting,
                (select count(*)::int from vat_payment) as vat,
                (select string_agg(status || ' (refund ' || refund_minor || ')', ', ') from early_termination) as terminations,
                (select count(*)::int from payment_advance where flagged) as flagged`,
        ),
      )
    ).rows[0]!;
    out.push(
      `  ${name}: ${row.items} rent tax items (${format(moneyOf(Number(row.tax)))} net); ${row.gra} GRA payments (${format(moneyOf(Number(row.gra_total)))}); ${row.withholdings} withholdings, certificates ${row.confirmed} confirmed and ${row.waiting} waiting; ${row.vat} VAT payments; early terminations: ${row.terminations ?? 'none'}; ${row.flagged} advances flagged over the limit.`,
    );
  }
  return out;
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
  // M9: the agency's fee terms, before any money, so every receipt is charged its fee.
  const feeTerms = await ensureFeeTerms({ database, clock: seedClock, agency: AGENCY });
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
    withholding: app.get(WithholdingService),
    rules: app.get(RulesService),
    storage,
    cfg,
  });
  const accountsSeeded = await ensureSettlementAccounts(database, {
    accounts: app.get(SettlementAccountsService),
    approvals: app.get(ApprovalsService),
  });
  const provider = await ensureProviderPayments(database, {
    providers: app.get<PaymentProviders>(PAYMENT_PROVIDERS),
    links: app.get(PayLinksService),
    page: app.get(PayPageService),
    webhooks: app.get(WebhooksService),
    reconciliation: app.get(ReconciliationService),
    read: app.get(BillingReadService),
  });
  await ensureTax(database, {
    withholding: app.get(WithholdingService),
    gra: app.get(GraService),
    reports: app.get(TaxReportService),
    termination: app.get(TerminationService),
    lifecycle: app.get(LeaseLifecycleService),
    invoicing: app.get(InvoicingService),
    storage,
    cfg,
  });
  const messaging = await ensureMessaging({
    database,
    config: cfg,
    clock: seedClock,
    entitlements: app.get(EntitlementsService),
    settings: app.get(MessagingSettingsService),
    consent: app.get(MessagingConsentService),
    inbound: app.get(InboundService),
    inbox: app.get(InboxService),
    broadcasts: app.get(BroadcastsService),
    companies: { platform: PLATFORM, agency: AGENCY, landlord: LANDLORD },
    actor: (companyId, signIn) => actorFor(database, companyId, signIn),
  });
  const notices = await ensureNotices({
    database,
    config: cfg,
    clock: seedClock,
    storage,
    notices: app.get(NoticesService),
    tracking: app.get(NoticeTrackingService),
    acks: app.get(NoticeAcknowledgementsService),
    approvals: app.get(ApprovalsService),
    tenants: app.get(TenantsService),
    leases: app.get(LeasesService),
    esign: app.get(EsignService),
    documents: app.get(DocumentsService),
    audit: app.get(AuditService),
    agency: AGENCY,
    actor: (companyId, signIn) => actorFor(database, companyId, signIn),
    paperScan: PAPER_SCAN,
  });
  const maintenance = await ensureMaintenance({
    database,
    config: cfg,
    storage,
    maintenance: app.get(MaintenanceService),
    artisans: app.get(ArtisansService),
    expenses: app.get(ExpensesService),
    inspections: app.get(InspectionsService),
    reports: app.get(MoveInReportService),
    moveOuts: app.get(MoveOutService),
    approvals: app.get(ApprovalsService),
    agency: AGENCY,
    landlord: LANDLORD,
    actor: (companyId, signIn) => actorFor(database, companyId, signIn),
  });
  const reporting = await ensureReporting({
    database,
    config: cfg,
    clock: seedClock,
    storage,
    fees: app.get(ManagementFeesService),
    money: app.get(OwnerMoneyService),
    statements: app.get(OwnerStatementsService),
    rollup: app.get(ReportingRollupService),
    billing: app.get(MoneyService),
    approvals: app.get(ApprovalsService),
    agency: AGENCY,
    billingCompanies: BILLING_COMPANIES,
    actor: (companyId, signIn) => actorFor(database, companyId, signIn),
  });
  // M10 (plan 4.11): after the rent data, so last month's snapshots count the seeded leases.
  const subscriptions = await ensureSubscriptions({
    database,
    core: app.get(SubscriptionCoreService),
    billing: app.get(SubscriptionBillingService),
    lifecycle: app.get(SubscriptionLifecycleService),
    payments: app.get(SubscriptionPaymentsService),
    providers: app.get<PaymentProviders>(PAYMENT_PROVIDERS),
    webhooks: app.get(WebhooksService),
    agency: AGENCY,
    landlord: LANDLORD,
    others: [ABOKOBI],
    actor: (companyId, signIn) => actorFor(database, companyId, signIn),
  });
  let checkProblems = 0;
  for (const companyId of BILLING_COMPANIES)
    checkProblems += (await app.get(SubledgerCheckService).check(companyId)).mismatches.length;
  console.log(`Seeded ${COMPANIES.length} companies and ${PEOPLE.length} people.`);
  console.log(
    `Register: ${created} new properties (agency: ACC-LEG, ACC-ELG, ACC-OSU; landlord: TEM-EST; Abokobi Homes: ACC-ABK).`,
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
  console.log(
    `Payments: ${accountsSeeded} new settlement accounts; provider payments ${provider.created ? 'created' : 'already there'}; the sub-ledger check after them found ${checkProblems} mismatches.`,
  );
  const rate = (a: number, t: number) =>
    t === 0 ? 'none yet' : `${a} of ${t} (${Math.floor((a * 1000) / t) / 10}%)`;
  console.log(
    `Auto-match rate (M4b done criterion 3): provider payments ${rate(provider.provider.auto, provider.provider.total)}; direct transfers recorded against a lease ${rate(provider.transfers.withLease, provider.transfers.total)}, counted separately.`,
  );
  console.log('Maintenance, inspections, expenses and move-out (M8):');
  for (const line of maintenance) console.log(line);
  console.log('Rent tax and advance rent (M5):');
  for (const line of await taxSummary(database)) console.log(line);
  console.log(
    `Messaging (M6): agency on Growth, ${COMPANIES[2]!.displayName} on Starter; ${messaging.numbers} new WhatsApp numbers (shared ${'100000000000001'}, agency ${'100000000000002'}); ${messaging.consents} new WhatsApp consents; broadcast ${messaging.broadcast}; ${messaging.repairs} reported repairs.`,
  );
  console.log(
    `Messaging inbound: ${Object.entries(messaging.inbound)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}; agency conversations by state: ${JSON.stringify(messaging.conversations)}.`,
  );
  console.log(
    `Notices (M7): ${Object.entries(notices)
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ')}.`,
  );
  console.log(`Owner reporting (M9): ${feeTerms} new fee terms.`);
  for (const line of reporting) console.log(line);
  console.log('Subscriptions (M10):');
  for (const line of subscriptions) console.log(line);
  console.log(`Staff password: ${DEMO_PASSWORD}`);
  console.log(
    `TOTP for every demo staff member: otpauth://totp/Rent%20Platform:demo?secret=${base32(DEMO_TOTP_SECRET)}&issuer=Rent%20Platform`,
  );
  console.log('Tenant sign-in: +233 20 000 0021; read the code at http://localhost:4010');
  // A ledger that disagrees with its sub-ledgers is never a usable demo: fail loudly.
  if (money.problems + checkProblems > 0)
    throw new Error(
      `The sub-ledger check found ${money.problems + checkProblems} mismatches; the demo data is not consistent`,
    );
} finally {
  await app.close();
}
