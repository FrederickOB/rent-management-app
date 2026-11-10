import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Better Auth tables (ADR-011). Global: no company_id, no RLS. `person` is Better Auth's
 * `user` model. Phone-only people (tenants, caretakers) get a placeholder email on the
 * reserved `.invalid` domain, which is never sent to (see identity module).
 */
const id = () =>
  uuid()
    .primaryKey()
    .default(sql`uuidv7()`);
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const person = pgTable('person', {
  id: id(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  twoFactorEnabled: boolean().default(false),
  phoneNumber: text().unique(),
  phoneNumberVerified: boolean(),
  isTestContact: boolean().notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable(
  'session',
  {
    id: id(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    token: text().notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text(),
    userAgent: text(),
    userId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    /** How the session was authenticated; decides which memberships it may carry (AD-06). */
    authMethod: text().notNull().default('password_totp'),
    /** The company the person is working in; checked against an active membership on every request. */
    activeCompanyId: uuid(),
    /**
     * M11 (founder D2): which app the session belongs to. A tenant-app session acts as the tenant,
     * whatever staff memberships the person holds elsewhere.
     */
    client: text().notNull().default('web'),
  },
  (t) => [
    index().on(t.userId),
    check('session_client_check', sql`${t.client} in ('web', 'tenant_app')`),
  ],
);

export const account = pgTable(
  'account',
  {
    id: id(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: id(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.identifier)],
);

export const twoFactor = pgTable(
  'two_factor',
  {
    id: id(),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    verified: boolean().default(true),
    failedVerificationCount: integer().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
    /** M11 review (TOTP replay): the last time step accepted for this person, sign-in and step-up. */
    lastTotpStep: bigint({ mode: 'number' }),
  },
  (t) => [index().on(t.userId), index().on(t.secret)],
);

export const rateLimit = pgTable('rate_limit', {
  id: id(),
  key: text().notNull().unique(),
  count: integer().notNull(),
  lastRequest: bigint({ mode: 'number' }).notNull(),
});
