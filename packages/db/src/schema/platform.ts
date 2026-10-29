import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, company, country, membership } from './company';
import { person } from './identity';

const tsNow = () => timestamp({ withTimezone: true }).notNull().defaultNow();

/** Legal, tax and regulatory values (TX-08). Global and append-only: a change is a new row. */
export const rule = pgTable(
  'rule',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    country: char({ length: 2 })
      .notNull()
      .references(() => country.code),
    key: text().notNull(),
    value: jsonb(),
    effectiveFrom: date({ mode: 'string' }).notNull(),
    effectiveTo: date({ mode: 'string' }),
    source: text().notNull(),
    verificationStatus: text().notNull(),
    verifiedBy: text(),
    verifiedAt: timestamp({ withTimezone: true }),
    notes: text(),
    createdBy: text().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    index('rule_lookup_idx').on(t.country, t.key, t.effectiveFrom, t.createdAt),
    check(
      'rule_status_check',
      sql`${t.verificationStatus} in ('verified', 'from_prd', 'unverified')`,
    ),
    check(
      'rule_verified_by_check',
      sql`${t.verificationStatus} <> 'verified' or ${t.verifiedBy} is not null`,
    ),
    check(
      'rule_dates_check',
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/** Head of each company's audit hash chain (AD-07). Written only by audit.append(). */
export const auditChainHead = pgTable('audit_chain_head', {
  companyId: uuid()
    .primaryKey()
    .references(() => company.id),
  lastSeq: bigint({ mode: 'number' }).notNull(),
  lastHash: bytea().notNull(),
  updatedAt: tsNow(),
});

/** Append-only, hash-chained audit events (AD-07, CLAUDE.md section 6). */
export const auditEvent = pgTable(
  'audit_event',
  {
    companyId: uuid()
      .notNull()
      .references(() => company.id),
    seq: bigint({ mode: 'number' }).notNull(),
    occurredAt: timestamp({ withTimezone: true, precision: 6 }).notNull(),
    actorPersonId: uuid(),
    actorKind: text().notNull(),
    requestId: text(),
    action: text().notNull(),
    recordType: text(),
    recordId: text(),
    data: jsonb(),
    prevHash: bytea().notNull(),
    hash: bytea().notNull(),
    hashVersion: smallint().notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.seq] }),
    index('audit_event_actor_idx').on(t.companyId, t.actorPersonId, t.occurredAt),
    index('audit_event_record_idx').on(t.companyId, t.recordType, t.recordId),
    index('audit_event_time_idx').on(t.companyId, t.occurredAt),
  ],
);

/** Where each chain head was anchored in write-once storage (append-only). */
export const auditAnchor = pgTable(
  'audit_anchor',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    companyId: uuid()
      .notNull()
      .references(() => company.id),
    anchorDate: date({ mode: 'string' }).notNull(),
    seq: bigint({ mode: 'number' }).notNull(),
    hash: bytea().notNull(),
    storageKey: text().notNull(),
    storageVersionId: text(),
    objectSha256: text().notNull(),
    anchoredAt: tsNow(),
  },
  (t) => [
    unique('audit_anchor_company_id_id_key').on(t.companyId, t.id),
    unique('audit_anchor_per_day').on(t.companyId, t.anchorDate),
  ],
);

/** Two-person approvals (AD-05). Only `status`, `closed_at` and `close_reason` change, through checked transitions. */
export const approvalRequest = pgTable(
  'approval_request',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    companyId: uuid()
      .notNull()
      .references(() => company.id),
    actionType: text().notNull(),
    subjectType: text().notNull(),
    subjectId: text().notNull(),
    payload: jsonb().notNull(),
    payloadHash: text().notNull(),
    initiatedBy: uuid()
      .notNull()
      .references(() => person.id),
    initiatorMembershipId: uuid().notNull(),
    mode: text().notNull(),
    requiredApprovals: integer().notNull().default(1),
    status: text().notNull(),
    coolingOffUntil: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    closedAt: timestamp({ withTimezone: true }),
    closeReason: text(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('approval_request_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      columns: [t.companyId, t.initiatorMembershipId],
      foreignColumns: [membership.companyId, membership.id],
    }),
    index('approval_request_open_idx').on(t.companyId, t.status, t.expiresAt),
    check('approval_request_mode_check', sql`${t.mode} in ('two_person', 'single_user')`),
    check(
      'approval_request_status_check',
      sql`${t.status} in ('pending', 'cooling_off', 'approved', 'rejected', 'cancelled', 'expired')`,
    ),
    check('approval_request_required_check', sql`${t.requiredApprovals} >= 1`),
  ],
);

/** Each approver's decision (append-only). The initiator rule is enforced by trigger. */
export const approvalDecision = pgTable(
  'approval_decision',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    companyId: uuid()
      .notNull()
      .references(() => company.id),
    requestId: uuid().notNull(),
    decidedBy: uuid()
      .notNull()
      .references(() => person.id),
    decidedByMembershipId: uuid().notNull(),
    kind: text().notNull(),
    reason: text(),
    payloadHash: text().notNull(),
    stepUpVerified: boolean().notNull().default(false),
    decidedAt: tsNow(),
  },
  (t) => [
    unique('approval_decision_company_id_id_key').on(t.companyId, t.id),
    unique('approval_decision_once_per_person').on(t.requestId, t.decidedBy),
    foreignKey({
      columns: [t.companyId, t.requestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    foreignKey({
      columns: [t.companyId, t.decidedByMembershipId],
      foreignColumns: [membership.companyId, membership.id],
    }),
    check('approval_decision_kind_check', sql`${t.kind} in ('approve', 'reject', 'self_confirm')`),
  ],
);

/** Transactional outbox (ADR-005). The relay marks events published through a system function. */
export const outboxEvent = pgTable(
  'outbox_event',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    companyId: uuid()
      .notNull()
      .references(() => company.id),
    type: text().notNull(),
    payload: jsonb().notNull(),
    idempotencyKey: text().notNull(),
    createdAt: tsNow(),
    publishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique('outbox_event_company_id_id_key').on(t.companyId, t.id),
    unique('outbox_event_idempotency_key').on(t.companyId, t.idempotencyKey),
    index('outbox_event_unpublished_idx')
      .on(t.createdAt)
      .where(sql`${t.publishedAt} is null`),
  ],
);

/** Job effects with no natural unique key (append-only). */
export const processedJob = pgTable(
  'processed_job',
  {
    companyId: uuid()
      .notNull()
      .references(() => company.id),
    key: text().notNull(),
    jobName: text().notNull(),
    processedAt: tsNow(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.key] })],
);

/** A stored file and its fingerprint (append-only). */
export const document = pgTable(
  'document',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    companyId: uuid()
      .notNull()
      .references(() => company.id),
    kind: text().notNull(),
    contentType: text().notNull(),
    sizeBytes: bigint({ mode: 'number' }).notNull(),
    sha256: text().notNull(),
    bucket: text().notNull(),
    storageKey: text().notNull(),
    storageVersionId: text(),
    writeOnce: boolean().notNull(),
    retentionMode: text(),
    retainUntil: timestamp({ withTimezone: true }),
    templateKey: text(),
    templateVersion: integer(),
    dataSnapshot: jsonb(),
    dataSnapshotSha256: text(),
    originalFilename: text(),
    createdBy: uuid(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('document_company_id_id_key').on(t.companyId, t.id),
    check('document_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'document_retention_check',
      sql`${t.retentionMode} is null or ${t.retentionMode} in ('GOVERNANCE', 'COMPLIANCE')`,
    ),
  ],
);

/** A request to render a template to PDF; its status changes as the worker runs. */
export const documentRenderRequest = pgTable(
  'document_render_request',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    companyId: uuid()
      .notNull()
      .references(() => company.id),
    templateKey: text().notNull(),
    templateVersion: integer().notNull(),
    data: jsonb().notNull(),
    status: text().notNull().default('pending'),
    documentId: uuid(),
    attempts: integer().notNull().default(0),
    lastError: text(),
    requestedBy: uuid(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('document_render_request_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    check(
      'document_render_request_status_check',
      sql`${t.status} in ('pending', 'rendered', 'failed')`,
    ),
  ],
);

/** A presigned upload waiting to be confirmed and processed (CLAUDE.md section 10). */
export const uploadIntent = pgTable(
  'upload_intent',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    companyId: uuid()
      .notNull()
      .references(() => company.id),
    purpose: text().notNull(),
    storageKey: text().notNull(),
    contentType: text().notNull(),
    maxBytes: integer().notNull(),
    status: text().notNull().default('pending'),
    documentId: uuid(),
    rejectReason: text(),
    createdBy: uuid().notNull(),
    createdAt: tsNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    unique('upload_intent_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    check(
      'upload_intent_status_check',
      sql`${t.status} in ('pending', 'confirmed', 'processed', 'rejected')`,
    ),
  ],
);
