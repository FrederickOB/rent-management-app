import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { company } from './company';
import { person } from './identity';
import { document, rule } from './platform';
import { tenant } from './tenancy';

/**
 * Data protection requests under Act 843 (M11 decision 5), the tenant's export, the nightly
 * retention review, and the operations console's records (decision 9). Security, triggers and
 * grants are in 0068_m11_security.sql.
 */
const tsNow = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const ts = () => timestamp({ withTimezone: true });
const day = () => date({ mode: 'string' });
const companyId = () =>
  uuid()
    .notNull()
    .references(() => company.id);
const id = () =>
  uuid()
    .primaryKey()
    .default(sql`uuidv7()`);

/**
 * A request from a tenant about their personal data: access, correction, erasure or objection.
 * The landlord is the controller, so the register is the company's. `due_on` comes from the rules
 * row `data_protection.request_response_days` as of the day received (null while it has no value,
 * OQ-65), with the rule used. `result` lists, for an erasure, what was anonymised and what is held
 * under retention and until when.
 */
export const dataProtectionRequest = pgTable(
  'data_protection_request',
  {
    id: id(),
    companyId: companyId(),
    tenantId: uuid().notNull(),
    kind: text().notNull(),
    receivedOn: day().notNull(),
    dueOn: day(),
    dueRuleId: uuid().references(() => rule.id),
    status: text().notNull().default('received'),
    notes: text(),
    outcome: text(),
    /** Erasure: messaging to the tenant stopped on every channel, at once. */
    messagingStoppedAt: ts(),
    result: jsonb(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
    completedAt: ts(),
  },
  (t) => [
    unique('data_protection_request_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'data_protection_request_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    index('data_protection_request_tenant_idx').on(t.companyId, t.tenantId),
    index('data_protection_request_status_idx').on(t.companyId, t.status, t.receivedOn),
    check(
      'data_protection_request_kind_check',
      sql`${t.kind} in ('access', 'correction', 'erasure', 'objection')`,
    ),
    check(
      'data_protection_request_status_check',
      sql`${t.status} in ('received', 'in_progress', 'completed', 'refused') and (${t.status} in ('completed', 'refused')) = (${t.completedAt} is not null)`,
    ),
  ],
);

/**
 * An access request's export (decision 5): rendered by a job, stored write-once, downloaded
 * through a short-lived link. Only that tenant's records; its contents are never logged.
 */
export const dataProtectionExport = pgTable(
  'data_protection_export',
  {
    id: id(),
    companyId: companyId(),
    requestId: uuid().notNull(),
    status: text().notNull().default('preparing'),
    documentId: uuid(),
    error: text(),
    requestedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
    readyAt: ts(),
  },
  (t) => [
    unique('data_protection_export_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'data_protection_export_request_fk',
      columns: [t.companyId, t.requestId],
      foreignColumns: [dataProtectionRequest.companyId, dataProtectionRequest.id],
    }),
    foreignKey({
      name: 'data_protection_export_document_fk',
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    index('data_protection_export_request_idx').on(t.companyId, t.requestId, t.createdAt),
    check(
      'data_protection_export_status_check',
      sql`${t.status} in ('preparing', 'ready', 'failed') and (${t.status} = 'ready') = (${t.documentId} is not null)`,
    ),
  ],
);

/**
 * The nightly retention review (decision 5; `retention.review`): per category, the records past a
 * verified retention period, across companies. Counts only; nothing is deleted on a timer. System
 * table: no company, no personal data.
 */
export const retentionReview = pgTable(
  'retention_review',
  {
    id: id(),
    checkedOn: day().notNull().unique(),
    checkedAt: tsNow(),
    /** `[{ category, ruleKey, verified, years, pastRetention }]`, as the console shows it. */
    categories: jsonb().notNull(),
  },
  () => [],
);

/**
 * A platform admin's replay of a webhook or retry of a dead-lettered job (decision 9), with its
 * reason, in the platform company (so its audit chain holds it). Append-only.
 */
export const opsAction = pgTable(
  'ops_action',
  {
    id: id(),
    companyId: companyId(),
    kind: text().notNull(),
    /** The webhook inbox id or the pg-boss job id. */
    targetId: text().notNull(),
    /** The queue or provider, for the console's lists. */
    targetName: text(),
    reason: text().notNull(),
    personId: uuid()
      .notNull()
      .references(() => person.id),
    outcome: text(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('ops_action_company_id_id_key').on(t.companyId, t.id),
    index('ops_action_target_idx').on(t.companyId, t.kind, t.targetId, t.createdAt),
    // M11: a platform admin's re-run of a day's reconciliation (`pnpm ops:reconcile`).
    check(
      'ops_action_kind_check',
      sql`${t.kind} in ('webhook_replay', 'job_retry', 'reconcile_run')`,
    ),
    check('ops_action_reason_check', sql`length(trim(${t.reason})) between 5 and 500`),
  ],
);

/**
 * The worker's heartbeat (decision 9): one row per worker instance, beaten every 30 seconds, read
 * by `/health/worker` and the console. System table: no company, no personal data.
 */
export const workerHeartbeat = pgTable(
  'worker_heartbeat',
  {
    instance: text().primaryKey(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    beatAt: timestamp({ withTimezone: true }).notNull(),
    beats: integer().notNull().default(0),
  },
  () => [],
);
