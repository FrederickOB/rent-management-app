import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  type AnyPgColumn,
  foreignKey,
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
import { company } from './company';
import { person } from './identity';
import { document, documentRenderRequest } from './platform';
import { lease, leaseParty, tenantContact } from './tenancy';

/**
 * The e-signature engine's tables (TL-07; CLAUDE.md section 9; M3 plan 4.8). One engine serves
 * leases now and notices from M7. Every row carries the property (and, for tenancy documents, the
 * tenant) it belongs to, so the scope policies filter it without joins.
 */
const tsNow = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const ts = () => timestamp({ withTimezone: true });
const companyId = () =>
  uuid()
    .notNull()
    .references(() => company.id);
const id = () =>
  uuid()
    .primaryKey()
    .default(sql`uuidv7()`);
const sha256 = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} is null or ${column} ~ '^[0-9a-f]{64}$'`);

/**
 * A document sent for signature. It opens (pending) once the frozen PDF exists; it completes when
 * every required signer has signed, and the final PDF with its certificate page is stored.
 */
export const signingRequest = pgTable(
  'signing_request',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    tenantId: uuid(),
    subjectType: text().notNull(),
    leaseId: uuid(),
    /** M7: the notice a `notice` request acknowledges (the FK is in 0037_notices_security.sql). */
    noticeId: uuid(),
    /** M8: the move-in inspection a `move_in_report` request signs (the FK is in 0041). */
    inspectionId: uuid(),
    /** M7 (plan 4.5): `all_required` (M3, leases) or `any_one` (a company's signatories, LN-07). */
    completionRule: text().notNull().default('all_required'),
    /** M7 (decision 6): when set, every link of the request expires then, none is superseded. */
    linksExpireAt: ts(),
    /** preparing (the PDF is rendering), pending, completed, declined, cancelled. */
    status: text().notNull().default('preparing'),
    renderRequestId: uuid(),
    /** The frozen PDF signers see, and its SHA-256. */
    documentId: uuid(),
    documentSha256: text(),
    /** The same document as HTML for the signing page, stored write-once with its own hash. */
    htmlDocumentId: uuid(),
    htmlSha256: text(),
    /** The signed PDF with the certificate page appended, and its SHA-256. */
    finalDocumentId: uuid(),
    finalSha256: text(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
    openedAt: ts(),
    completedAt: ts(),
    declinedAt: ts(),
    declineReason: text(),
    cancelledAt: ts(),
    cancelReason: text(),
  },
  (t) => [
    unique('signing_request_company_id_id_key').on(t.companyId, t.id),
    unique('signing_request_scope_key').on(t.companyId, t.propertyId, t.id),
    // The rows under a request name its tenant, which drives tenant-scope RLS (M3 review).
    unique('signing_request_tenant_key').on(t.companyId, t.propertyId, t.tenantId, t.id),
    foreignKey({
      name: 'signing_request_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'signing_request_render_fk',
      columns: [t.companyId, t.renderRequestId],
      foreignColumns: [documentRenderRequest.companyId, documentRenderRequest.id],
    }),
    foreignKey({
      name: 'signing_request_document_fk',
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'signing_request_html_fk',
      columns: [t.companyId, t.htmlDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'signing_request_final_fk',
      columns: [t.companyId, t.finalDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    index('signing_request_lease_idx').on(t.companyId, t.leaseId),
    // One lease out for signature at a time; notices on the same lease are their own requests.
    uniqueIndex('signing_request_one_open')
      .on(t.companyId, t.leaseId)
      .where(
        sql`${t.leaseId} is not null and ${t.status} in ('preparing', 'pending') and ${t.subjectType} = 'lease'`,
      ),
    index('signing_request_notice_idx').on(t.companyId, t.noticeId),
    check(
      'signing_request_subject_check',
      sql`${t.subjectType} in ('lease', 'notice', 'move_in_report')`,
    ),
    // M8 (plan 4.7): a move-in report names its inspection and lease; every party signs.
    check(
      'signing_request_move_in_check',
      sql`(${t.subjectType} = 'move_in_report') = (${t.inspectionId} is not null) and (${t.subjectType} <> 'move_in_report' or (${t.leaseId} is not null and ${t.tenantId} is not null))`,
    ),
    uniqueIndex('signing_request_one_move_in_report')
      .on(t.companyId, t.inspectionId)
      .where(sql`${t.inspectionId} is not null and ${t.status} <> 'cancelled'`),
    check(
      'signing_request_notice_check',
      sql`(${t.subjectType} = 'notice') = (${t.noticeId} is not null) and (${t.subjectType} <> 'notice' or ${t.tenantId} is not null)`,
    ),
    check(
      'signing_request_completion_check',
      sql`${t.completionRule} in ('all_required', 'any_one') and (${t.subjectType} = 'notice' or ${t.completionRule} = 'all_required')`,
    ),
    check(
      'signing_request_lease_check',
      sql`${t.subjectType} <> 'lease' or (${t.leaseId} is not null and ${t.tenantId} is not null)`,
    ),
    check(
      'signing_request_status_check',
      sql`${t.status} in ('preparing', 'pending', 'completed', 'declined', 'cancelled')`,
    ),
    check(
      'signing_request_document_check',
      sql`${t.status} in ('preparing', 'cancelled') or (${t.documentId} is not null and ${t.documentSha256} is not null)`,
    ),
    check(
      'signing_request_final_check',
      sql`${t.status} <> 'completed' or (${t.finalDocumentId} is not null and ${t.finalSha256} is not null and ${t.completedAt} is not null)`,
    ),
    sha256('signing_request_document_sha_check', t.documentSha256),
    sha256('signing_request_html_sha_check', t.htmlSha256),
    sha256('signing_request_final_sha_check', t.finalSha256),
  ],
);

/**
 * One person who signs a request, with their name and contact details snapshotted when the
 * request opens. Codes go to the phone, or to the email for a signatory with only an email.
 */
export const signer = pgTable(
  'signer',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    tenantId: uuid(),
    signingRequestId: uuid().notNull(),
    leasePartyId: uuid(),
    signerRole: text().notNull(),
    /** Who the snapshot came from, for consent and messages: tenant, tenant_contact, staff or other. */
    subjectType: text().notNull(),
    tenantContactId: uuid(),
    staffPersonId: uuid().references(() => person.id),
    name: text().notNull(),
    phone: text(),
    email: text(),
    required: boolean().notNull().default(true),
    position: smallint().notNull(),
    status: text().notNull().default('pending'),
    firstOpenedAt: ts(),
    lastOpenedAt: ts(),
    signedAt: ts(),
    declinedAt: ts(),
    declineReason: text(),
    /** Five wrong codes lock signing for 30 minutes (CLAUDE.md section 9). */
    failedCodeAttempts: integer().notNull().default(0),
    lockedUntil: ts(),
    isTestContact: boolean().notNull().default(false),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('signer_company_id_id_key').on(t.companyId, t.id),
    unique('signer_scope_key').on(t.companyId, t.propertyId, t.id),
    unique('signer_position_key').on(t.companyId, t.signingRequestId, t.position),
    unique('signer_tenant_key').on(t.companyId, t.propertyId, t.tenantId, t.id),
    foreignKey({
      name: 'signer_request_fk',
      columns: [t.companyId, t.propertyId, t.signingRequestId],
      foreignColumns: [signingRequest.companyId, signingRequest.propertyId, signingRequest.id],
    }),
    // A signer names its request's tenant (match simple: a signer with no tenant is hidden from
    // every tenant session, which fails closed).
    foreignKey({
      name: 'signer_request_tenant_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.signingRequestId],
      foreignColumns: [
        signingRequest.companyId,
        signingRequest.propertyId,
        signingRequest.tenantId,
        signingRequest.id,
      ],
    }),
    foreignKey({
      name: 'signer_lease_party_fk',
      columns: [t.companyId, t.leasePartyId],
      foreignColumns: [leaseParty.companyId, leaseParty.id],
    }),
    foreignKey({
      name: 'signer_contact_fk',
      columns: [t.companyId, t.tenantId, t.tenantContactId],
      foreignColumns: [tenantContact.companyId, tenantContact.tenantId, tenantContact.id],
    }),
    index('signer_request_idx').on(t.companyId, t.signingRequestId),
    check(
      'signer_role_check',
      sql`${t.signerRole} in ('tenant', 'signatory', 'landlord', 'guarantor', 'witness')`,
    ),
    check(
      'signer_subject_check',
      sql`${t.subjectType} in ('tenant', 'tenant_contact', 'staff', 'other') and (${t.subjectType} <> 'tenant_contact' or ${t.tenantContactId} is not null) and (${t.subjectType} <> 'staff' or ${t.staffPersonId} is not null) and (${t.subjectType} <> 'tenant' or ${t.tenantId} is not null)`,
    ),
    check('signer_status_check', sql`${t.status} in ('pending', 'signed', 'declined')`),
    check('signer_contact_check', sql`${t.phone} is not null or ${t.email} is not null`),
    check('signer_position_check', sql`${t.position} >= 1`),
  ],
);

/**
 * A secure link (CLAUDE.md section 9): 256 random bits in the URL, only the SHA-256 stored. One
 * recipient and one purpose each: signing and the signed copy now (migration 0009 added the
 * copy), pay links in M4b and job sheets in M8.
 */
export const secureLink = pgTable(
  'secure_link',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    tenantId: uuid(),
    purpose: text().notNull(),
    tokenHash: text().notNull(),
    signerId: uuid(),
    /** The message that carried the link, when one did (the FK is in the security migration). */
    messageId: uuid(),
    /** A pay link's invoice (M4b plan 4.3); the FK is in the M4b security migration. */
    invoiceId: uuid(),
    /** A receipt link's receipt (M4b plan 4.6); the FK is in the M4b security migration. */
    receiptId: uuid(),
    /** M8 (decision 6): a job sheet's job and artisan; the FKs are in 0041. */
    jobId: uuid(),
    artisanId: uuid(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: ts(),
    revokeReason: text(),
    firstOpenedAt: ts(),
    /** M7 (plan 4.5): the first open's address and device, as evidence for that token. */
    firstOpenIp: text(),
    firstOpenUserAgent: text(),
    lastOpenedAt: ts(),
    openCount: integer().notNull().default(0),
    usedAt: ts(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('secure_link_company_id_id_key').on(t.companyId, t.id),
    unique('secure_link_scope_key').on(t.companyId, t.propertyId, t.id),
    uniqueIndex('secure_link_token_hash_key').on(t.tokenHash),
    foreignKey({
      name: 'secure_link_signer_fk',
      columns: [t.companyId, t.propertyId, t.signerId],
      foreignColumns: [signer.companyId, signer.propertyId, signer.id],
    }),
    foreignKey({
      name: 'secure_link_signer_tenant_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.signerId],
      foreignColumns: [signer.companyId, signer.propertyId, signer.tenantId, signer.id],
    }),
    index('secure_link_signer_idx').on(t.companyId, t.signerId),
    check(
      'secure_link_purpose_check',
      sql`${t.purpose} in ('sign', 'signed_copy', 'pay', 'receipt', 'job_sheet')`,
    ),
    check(
      'secure_link_signer_check',
      sql`${t.purpose} not in ('sign', 'signed_copy') or ${t.signerId} is not null`,
    ),
    check(
      'secure_link_pay_check',
      sql`(${t.purpose} = 'pay') = (${t.invoiceId} is not null) and (${t.purpose} = 'receipt') = (${t.receiptId} is not null)`,
    ),
    check(
      'secure_link_job_sheet_check',
      sql`(${t.purpose} = 'job_sheet') = (${t.jobId} is not null and ${t.artisanId} is not null)`,
    ),
    index('secure_link_job_idx')
      .on(t.companyId, t.jobId)
      .where(sql`${t.jobId} is not null`),
    index('secure_link_invoice_idx')
      .on(t.companyId, t.invoiceId)
      .where(sql`${t.invoiceId} is not null`),
    check('secure_link_token_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('secure_link_revoke_check', sql`(${t.revokedAt} is null) = (${t.revokeReason} is null)`),
  ],
);

/**
 * A one-time code for signing: 6 digits stored as an HMAC, 10 minutes, 5 attempts. Codes go
 * straight to the SMS or email port, so no plaintext code is ever stored.
 */
export const otpChallenge = pgTable(
  'otp_challenge',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    tenantId: uuid(),
    signerId: uuid().notNull(),
    secureLinkId: uuid().notNull(),
    channel: text().notNull(),
    destinationMasked: text().notNull(),
    /** A keyed hash of the destination, for the per-phone send limit. */
    destinationHash: text().notNull(),
    codeHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    consumedAt: ts(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('otp_challenge_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'otp_challenge_signer_fk',
      columns: [t.companyId, t.propertyId, t.signerId],
      foreignColumns: [signer.companyId, signer.propertyId, signer.id],
    }),
    foreignKey({
      name: 'otp_challenge_signer_tenant_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.signerId],
      foreignColumns: [signer.companyId, signer.propertyId, signer.tenantId, signer.id],
    }),
    foreignKey({
      name: 'otp_challenge_link_fk',
      columns: [t.companyId, t.propertyId, t.secureLinkId],
      foreignColumns: [secureLink.companyId, secureLink.propertyId, secureLink.id],
    }),
    index('otp_challenge_link_idx').on(t.companyId, t.secureLinkId, t.createdAt),
    index('otp_challenge_destination_idx').on(t.companyId, t.destinationHash, t.createdAt),
    check('otp_challenge_channel_check', sql`${t.channel} in ('sms', 'email')`),
    check('otp_challenge_attempts_check', sql`${t.attempts} between 0 and ${t.maxAttempts}`),
  ],
);

/**
 * Signature evidence (append-only): the method, the typed name or drawn image, the consent text
 * version and hash, the server time, how the signer was verified, IP, device and document hash.
 */
export const signature = pgTable(
  'signature',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    tenantId: uuid(),
    signingRequestId: uuid().notNull(),
    signerId: uuid().notNull(),
    method: text().notNull(),
    typedName: text(),
    drawingDocumentId: uuid(),
    consentVersion: text().notNull(),
    consentSha256: text().notNull(),
    signedAt: tsNow(),
    verifiedChannel: text().notNull(),
    verifiedDestinationMasked: text().notNull(),
    ipAddress: text().notNull(),
    userAgent: text().notNull(),
    documentSha256: text().notNull(),
    otpChallengeId: uuid(),
  },
  (t) => [
    unique('signature_company_id_id_key').on(t.companyId, t.id),
    unique('signature_one_per_signer').on(t.companyId, t.signerId),
    foreignKey({
      name: 'signature_request_fk',
      columns: [t.companyId, t.propertyId, t.signingRequestId],
      foreignColumns: [signingRequest.companyId, signingRequest.propertyId, signingRequest.id],
    }),
    foreignKey({
      name: 'signature_request_tenant_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.signingRequestId],
      foreignColumns: [
        signingRequest.companyId,
        signingRequest.propertyId,
        signingRequest.tenantId,
        signingRequest.id,
      ],
    }),
    foreignKey({
      name: 'signature_signer_fk',
      columns: [t.companyId, t.propertyId, t.signerId],
      foreignColumns: [signer.companyId, signer.propertyId, signer.id],
    }),
    foreignKey({
      name: 'signature_drawing_fk',
      columns: [t.companyId, t.drawingDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'signature_otp_fk',
      columns: [t.companyId, t.otpChallengeId],
      foreignColumns: [otpChallenge.companyId, otpChallenge.id],
    }),
    check('signature_method_check', sql`${t.method} in ('typed', 'drawn')`),
    check(
      'signature_method_fields_check',
      sql`(${t.method} = 'typed' and ${t.typedName} is not null) or (${t.method} = 'drawn' and ${t.drawingDocumentId} is not null)`,
    ),
    check('signature_channel_check', sql`${t.verifiedChannel} in ('sms', 'email')`),
    check('signature_document_sha_check', sql`${t.documentSha256} ~ '^[0-9a-f]{64}$'`),
    check('signature_consent_sha_check', sql`${t.consentSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** The signing timeline (append-only): opened, code sent, signed, declined, recalled and so on. */
export const signingEvent = pgTable(
  'signing_event',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    tenantId: uuid(),
    signingRequestId: uuid().notNull(),
    signerId: uuid(),
    kind: text().notNull(),
    data: jsonb(),
    ipAddress: text(),
    userAgent: text(),
    occurredAt: tsNow(),
  },
  (t) => [
    unique('signing_event_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'signing_event_request_fk',
      columns: [t.companyId, t.propertyId, t.signingRequestId],
      foreignColumns: [signingRequest.companyId, signingRequest.propertyId, signingRequest.id],
    }),
    foreignKey({
      name: 'signing_event_request_tenant_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.signingRequestId],
      foreignColumns: [
        signingRequest.companyId,
        signingRequest.propertyId,
        signingRequest.tenantId,
        signingRequest.id,
      ],
    }),
    foreignKey({
      name: 'signing_event_signer_fk',
      columns: [t.companyId, t.propertyId, t.signerId],
      foreignColumns: [signer.companyId, signer.propertyId, signer.id],
    }),
    index('signing_event_request_idx').on(t.companyId, t.signingRequestId, t.occurredAt),
    check('signing_event_kind_check', sql`${t.kind} ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)*$'`),
  ],
);
