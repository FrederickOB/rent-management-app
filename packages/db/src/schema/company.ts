import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { person } from './identity';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** Country configuration (NFR localisation). Facts only; legal values live in `rule`. */
export const country = pgTable('country', {
  code: char({ length: 2 }).primaryKey(),
  name: text().notNull(),
  currency: char({ length: 3 }).notNull(),
  currencyMinorUnit: smallint().notNull(),
  defaultTimeZone: text().notNull(),
  callingCode: text().notNull(),
  idTypes: text().array().notNull(),
  addressFormat: text().notNull(),
  /** Administrative regions, for property addresses (PR-03). */
  regions: text()
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  /** Suggested meter suppliers by utility (PR-05), for example ECG for electricity. */
  meterSuppliers: jsonb().notNull().default({}),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** A landlord, an agency or the platform itself (AD-01). RLS policy on `id`. */
export const company = pgTable(
  'company',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    kind: text().notNull(),
    legalName: text().notNull(),
    displayName: text().notNull(),
    countryCode: char({ length: 2 })
      .notNull()
      .references(() => country.code),
    timeZone: text().notNull().default('Africa/Accra'),
    currency: char({ length: 3 }).notNull().default('GHS'),
    logoDocumentId: uuid(),
    primaryColour: text().notNull().default('#0F766E'),
    accentColour: text().notNull().default('#F59E0B'),
    senderName: text().notNull(),
    settings: jsonb().notNull().default({}),
    status: text().notNull().default('active'),
    /**
     * M10 decision 1: the tier (Starter, Growth or Portfolio), replacing `interim_plan`, and the
     * access read-only gives (decision 11). Set only by the subscription engine and platform
     * admins, through narrow functions: the application role has no UPDATE on either column.
     */
    plan: text().notNull().default('growth'),
    access: text().notNull().default('full'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('company_kind_check', sql`${t.kind} in ('landlord', 'agency', 'platform')`),
    check('company_status_check', sql`${t.status} in ('active', 'suspended', 'archived')`),
    check('company_plan_check', sql`${t.plan} in ('starter', 'growth', 'portfolio')`),
    check('company_access_check', sql`${t.access} in ('full', 'read_only')`),
  ],
);

/** A person's role in a company (AD-03). Role and scope changes are audited with before and after (AD-07). */
export const membership = pgTable(
  'membership',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    companyId: uuid()
      .notNull()
      .references(() => company.id),
    personId: uuid()
      .notNull()
      .references(() => person.id),
    role: text().notNull(),
    scope: jsonb().notNull().default({}),
    nominatedApprover: boolean().notNull().default(false),
    status: text().notNull().default('active'),
    invitedBy: uuid().references(() => person.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique('membership_company_id_id_key').on(t.companyId, t.id),
    uniqueIndex('membership_one_open_per_person')
      .on(t.companyId, t.personId)
      .where(sql`${t.status} in ('invited', 'active')`),
    index().on(t.personId),
    check(
      'membership_role_check',
      sql`${t.role} in ('owner', 'agency_admin', 'property_manager', 'accountant', 'caretaker', 'adviser', 'platform_admin')`,
    ),
    check('membership_status_check', sql`${t.status} in ('invited', 'active', 'revoked')`),
  ],
);

/** Per-company data keys for field encryption, wrapped by KMS. One row per version (append-only). */
export const companyKey = pgTable(
  'company_key',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    companyId: uuid()
      .notNull()
      .references(() => company.id),
    purpose: text().notNull(),
    version: integer().notNull(),
    wrappedKey: bytea().notNull(),
    kmsKeyId: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('company_key_company_id_id_key').on(t.companyId, t.id),
    unique('company_key_version_key').on(t.companyId, t.purpose, t.version),
  ],
);
