import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  schema,
  sql,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import {
  appendPdfPages,
  renderTemplateContent,
  renderTemplateHtml,
  signingCertificateV1,
  type Branding,
  type SigningCertificateData,
} from '@rent/documents';
import {
  dueSigningReminders,
  maskEmail,
  SIGNED_COPY_LINK_DAYS,
  SIGNER_ROLE_LABELS,
  SIGNING_LINK_DAYS,
  signingCompleteBy,
  verificationLabel,
  type SignerLinkPurpose,
  type SignerRole,
  type SignerStatus,
  type SigningRequestStatus,
} from '@rent/domain/esign';
import { maskPhone } from '@rent/domain/phone';
import { signingReminderHoursOf } from '@rent/domain/settings';
import { reminderToSend } from '@rent/domain/tenancy';
import { v7 as uuidv7 } from 'uuid';
import { AuditService } from '../audit/audit.service';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { isUniqueViolation } from '../core/db-errors';
import { conflict, notFound } from '../core/errors';
import { queueMessage } from '../core/messages';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, CONFIG, DATABASE } from '../core/tokens';
import { DocumentsService, type PdfRender } from '../documents/documents.service';
import type {
  IssuedLink,
  LandlordContact,
  NewLeaseSigningRequest,
  NewNoticeSigningRequest,
  NoticeFacts,
  SignerProgress,
  SignerSubject,
  SigningProgressView,
  TenantSigningRequest,
} from './esign.types';
import {
  companyFacts,
  completionOf,
  isNoticeRequest,
  requestRow,
  revokeLinks,
  signedByAll,
  signerRow,
  signersOf,
  signingEvent,
  signsAsTenant,
  type CompanyFacts,
  type RequestRow,
  type SignerRow,
} from './records';
import { newToken, tokenHash } from './secrets';

/** Events and jobs of the e-signing engine (architecture section 10). */
export const SIGNING_REQUESTED_EVENT = 'signing.requested';
export const SIGNING_COMPLETED_EVENT = 'signing.completed';
export const SIGNING_DECLINED_EVENT = 'signing.declined';
export const SIGNING_FINALISE_JOB = 'esign.finalise';
export const SIGNING_REMINDERS_JOB = 'esign.signing-reminders';
export const EXPIRE_LINKS_JOB = 'housekeeping.expire-links-and-codes';
/**
 * M7 (plan 4.5): what happens on a notice's request, for the notices module: a signer's first
 * open (with the device), a signature, and completion. Leases keep SIGNING_COMPLETED_EVENT.
 */
export const NOTICE_SIGNING_EVENT = 'esign.notice-event';
export type NoticeSigningEventKind = 'opened' | 'signed' | 'completed';

const DAY_MS = 86_400_000;

/** What the messaging module needs to reach a signer: the snapshot taken when the request opened. */
export interface SignerContact {
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly subject: SignerSubject;
  readonly tenantId: string | null;
  readonly propertyId: string;
  readonly isTestContact: boolean;
}

/** The document a request is about, from its frozen data snapshot. */
interface DocumentFacts {
  readonly title: string;
  readonly reference: string;
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly data: Record<string, unknown>;
}

const branding = (company: CompanyFacts): Branding => ({
  senderName: company.senderName,
  primaryColour: company.primaryColour,
  accentColour: company.accentColour,
});

const subjectOf = (row: SignerRow): SignerSubject => {
  switch (row.subjectType) {
    case 'tenant':
      return { type: 'tenant' };
    case 'tenant_contact':
      return { type: 'tenant_contact', contactId: row.tenantContactId! };
    case 'staff':
      return { type: 'staff', personId: row.staffPersonId! };
    default:
      return { type: 'other' };
  }
};

/**
 * The e-signature engine (TL-07; CLAUDE.md section 9; ADR-007; M3 plan 4.8): one engine for
 * leases now and notices from M7. A request opens once its frozen PDF exists; each signer gets a
 * secure link; the last required signature queues finalisation, which appends the signing
 * certificate, stores the signed copy write-once with both fingerprints in the audit chain,
 * emits signing.completed and sends every party their copy. The signing page's own actions
 * (codes, signatures, declining) are in SigningPageService.
 */
@Injectable()
export class EsignService {
  /** Document HTML is immutable once stored, so a few are kept in memory for the signing page. */
  private readonly htmlCache = new Map<string, string>();
  /** M7: what the signing page says about a notice, from the notices module (it owns them). */
  private noticeFacts: ((tx: Tx, noticeId: string) => Promise<NoticeFacts | null>) | null = null;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** M7: the notices module registers how a notice is described on its signing page. */
  useNoticeFacts(fn: (tx: Tx, noticeId: string) => Promise<NoticeFacts | null>): void {
    this.noticeFacts = fn;
  }

  /** M7: a notice's facts for the signing page, in the page's transaction. */
  async describeNotice(tx: Tx, noticeId: string): Promise<NoticeFacts | null> {
    return this.noticeFacts ? this.noticeFacts(tx, noticeId) : null;
  }

  // Requests -------------------------------------------------------------------------------------

  /**
   * Opens a signing request for a lease in the caller's transaction, with each signer's name and
   * phone or email snapshotted. It waits as `preparing` until the frozen PDF is rendered.
   */
  async openRequest(tx: Tx, input: NewLeaseSigningRequest): Promise<string> {
    const now = this.clock.now();
    let id: string;
    try {
      const [row] = await tx
        .insert(schema.signingRequest)
        .values({
          companyId: input.companyId,
          propertyId: input.propertyId,
          tenantId: input.tenantId,
          subjectType: 'lease',
          leaseId: input.leaseId,
          status: 'preparing',
          renderRequestId: input.renderRequestId,
          createdBy: input.createdBy,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: schema.signingRequest.id });
      id = row!.id;
    } catch (error) {
      if (isUniqueViolation(error, 'signing_request_one_open'))
        throw conflict('signing_open', 'This lease is already out for signature');
      throw error;
    }
    await tx.insert(schema.signer).values(
      input.signers.map((s, i) => ({
        companyId: input.companyId,
        propertyId: input.propertyId,
        tenantId: input.tenantId,
        signingRequestId: id,
        leasePartyId: s.leasePartyId,
        signerRole: s.role,
        subjectType: s.subject.type,
        tenantContactId: s.subject.type === 'tenant_contact' ? s.subject.contactId : null,
        staffPersonId: s.subject.type === 'staff' ? s.subject.personId : null,
        name: s.name,
        phone: s.phone,
        email: s.email,
        required: s.required,
        position: i + 1,
        isTestContact: s.isTestContact,
        createdAt: now,
        updatedAt: now,
      })),
    );
    const request = { ...input, id };
    await signingEvent(tx, request, 'request.created', now, {
      data: { signers: input.signers.length, renderRequestId: input.renderRequestId },
    });
    await this.audit.append(tx, {
      companyId: input.companyId,
      action: 'signing.requested',
      recordType: 'signing_request',
      recordId: id,
      data: { leaseId: input.leaseId, signers: input.signers.map((s) => s.role) },
    });
    await enqueueOutbox(tx, {
      companyId: input.companyId,
      type: SIGNING_REQUESTED_EVENT,
      payload: { signingRequestId: id, leaseId: input.leaseId },
      idempotencyKey: `${SIGNING_REQUESTED_EVENT}:${id}`,
    });
    return id;
  }

  /**
   * M7 (plan 4.5): opens a notice's request for one party in the caller's transaction (the issue),
   * with each signer snapshotted. It waits as `preparing` until the notice's PDF is rendered; the
   * notices module then sends every link itself, on every channel at once (decision 6).
   */
  async openNoticeRequest(
    tx: Tx,
    input: NewNoticeSigningRequest,
  ): Promise<{ readonly requestId: string; readonly signerIds: readonly string[] }> {
    const now = this.clock.now();
    const [row] = await tx
      .insert(schema.signingRequest)
      .values({
        companyId: input.companyId,
        propertyId: input.propertyId,
        tenantId: input.tenantId,
        subjectType: 'notice',
        leaseId: input.leaseId,
        noticeId: input.noticeId,
        completionRule: input.completionRule,
        linksExpireAt: input.linksExpireAt,
        status: 'preparing',
        renderRequestId: input.renderRequestId,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.signingRequest.id });
    const id = row!.id;
    const signers = await tx
      .insert(schema.signer)
      .values(
        input.signers.map((s, i) => ({
          companyId: input.companyId,
          propertyId: input.propertyId,
          tenantId: input.tenantId,
          signingRequestId: id,
          leasePartyId: s.leasePartyId,
          signerRole: s.role,
          subjectType: s.subject.type,
          tenantContactId: s.subject.type === 'tenant_contact' ? s.subject.contactId : null,
          staffPersonId: s.subject.type === 'staff' ? s.subject.personId : null,
          name: s.name,
          phone: s.phone,
          email: s.email,
          required: s.required,
          position: i + 1,
          isTestContact: s.isTestContact,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning({ id: schema.signer.id, position: schema.signer.position });
    const request = { ...input, id };
    await signingEvent(tx, request, 'request.created', now, {
      data: {
        signers: input.signers.length,
        renderRequestId: input.renderRequestId,
        noticeId: input.noticeId,
        completionRule: input.completionRule,
      },
    });
    await this.audit.append(tx, {
      companyId: input.companyId,
      action: 'signing.requested',
      recordType: 'signing_request',
      recordId: id,
      data: {
        noticeId: input.noticeId,
        completionRule: input.completionRule,
        signers: input.signers.map((s) => s.role),
      },
    });
    return {
      requestId: id,
      signerIds: signers.sort((a, b) => a.position - b.position).map((x) => x.id),
    };
  }

  /**
   * M7 (plan 4.8): closes a notice's open requests when the notice closes or is superseded, in the
   * caller's transaction. Links are not revoked: they still open the notice, read-only.
   */
  async closeForNotice(
    tx: Tx,
    noticeId: string,
    input: { readonly reason: string; readonly by: string | null },
  ): Promise<number> {
    const open = await tx
      .select()
      .from(schema.signingRequest)
      .where(
        and(
          eq(schema.signingRequest.noticeId, noticeId),
          inArray(schema.signingRequest.status, ['preparing', 'pending']),
        ),
      )
      .for('update');
    const now = this.clock.now();
    const reason = input.reason.trim().slice(0, 500) || 'Closed';
    for (const request of open) {
      await tx
        .update(schema.signingRequest)
        .set({ status: 'cancelled', cancelledAt: now, cancelReason: reason, updatedAt: now })
        .where(eq(schema.signingRequest.id, request.id));
      await signingEvent(tx, request, 'request.cancelled', now, { data: { reason, noticeId } });
      await this.audit.append(tx, {
        companyId: request.companyId,
        action: 'signing.cancelled',
        recordType: 'signing_request',
        recordId: request.id,
        data: { noticeId, reason, by: input.by },
      });
    }
    return open.length;
  }

  /** M7: a notice's requests and their signers, in the caller's transaction. */
  async noticeRequests(
    tx: Tx,
    noticeId: string,
  ): Promise<{ readonly request: RequestRow; readonly signers: readonly SignerRow[] }[]> {
    const requests = await tx
      .select()
      .from(schema.signingRequest)
      .where(eq(schema.signingRequest.noticeId, noticeId))
      .orderBy(asc(schema.signingRequest.createdAt));
    const out = [];
    for (const request of requests) out.push({ request, signers: await signersOf(tx, request.id) });
    return out;
  }

  /**
   * The frozen PDF exists (documents.rendered): stores the same words as HTML write-once with
   * their own hash, opens the request and queues every signer's link (plan 4.8). A request
   * recalled meanwhile stays closed. Idempotent.
   */
  async onDocumentRendered(companyId: string, renderRequestId: string): Promise<boolean> {
    const ctx = { companyId, actorKind: 'system' as const };
    const found = await withCompany(this.database, ctx, async (tx) => {
      // M7: a notice's parties each have a request on the same render.
      const requests = await tx
        .select()
        .from(schema.signingRequest)
        .where(
          and(
            eq(schema.signingRequest.renderRequestId, renderRequestId),
            eq(schema.signingRequest.status, 'preparing'),
          ),
        );
      if (requests.length === 0) return null;
      const rendered = await this.documents.renderedDocument(tx, renderRequestId);
      if (!rendered || rendered.status !== 'rendered' || !rendered.documentId || !rendered.sha256)
        return null;
      return { requests, rendered, company: await companyFacts(tx, companyId) };
    });
    if (!found) return false;
    const { requests, rendered, company } = found;
    const html = renderTemplateContent(
      rendered.templateKey,
      rendered.templateVersion,
      rendered.data,
      branding(company),
    );
    const file = await this.documents.storeWriteOnce({
      companyId,
      countryCode: company.countryCode,
      key: `documents/${companyId}/${renderRequestId}/${uuidv7()}.html`,
      bytes: Buffer.from(html, 'utf8'),
      contentType: 'text/html',
    });
    return withCompany(this.database, ctx, async (tx) => {
      let opened = false;
      let htmlDocumentId: string | null = null;
      for (const request of requests) {
        const current = await requestRow(tx, request.id, { lock: true });
        if (current.status !== 'preparing') continue;
        const now = this.clock.now();
        htmlDocumentId ??= await this.documents.recordWriteOnce(tx, file, {
          kind: 'signing_html',
          templateKey: rendered.templateKey,
          templateVersion: rendered.templateVersion,
          dataSnapshot: rendered.data,
          createdBy: current.createdBy,
        });
        await tx
          .update(schema.signingRequest)
          .set({
            status: 'pending',
            documentId: rendered.documentId,
            documentSha256: rendered.sha256,
            htmlDocumentId,
            htmlSha256: file.sha256,
            openedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.signingRequest.id, current.id));
        await signingEvent(tx, current, 'request.opened', now, {
          data: { documentSha256: rendered.sha256, htmlSha256: file.sha256 },
        });
        await this.audit.append(tx, {
          companyId,
          action: 'signing.opened',
          recordType: 'signing_request',
          recordId: current.id,
          data: {
            documentId: rendered.documentId,
            documentSha256: rendered.sha256,
            htmlDocumentId,
            htmlSha256: file.sha256,
          },
        });
        opened = true;
        // A notice's links go from the notices module, every channel at once (M7 decision 6).
        if (isNoticeRequest(current)) continue;
        const facts = documentFactsOf(rendered);
        for (const signer of await signersOf(tx, current.id))
          await queueMessage(tx, companyId, {
            messageId: uuidv7(),
            recipient: { type: 'signer', signerId: signer.id },
            purpose: 'signing_link',
            subject: `Please sign: ${facts.title}`,
            body: `${company.senderName} has sent you a document to read and sign: ${facts.title}. Open {{link}} to read it and sign. The link works for ${SIGNING_LINK_DAYS} days.`,
            link: { purpose: 'sign', targetId: signer.id },
            propertyId: current.propertyId,
            related: { type: 'signing_request', id: current.id },
            requestedBy: current.createdBy,
          });
      }
      return opened;
    });
  }

  /**
   * Closes a lease's open request when staff recall it (plan 4.7), in the caller's transaction:
   * the request is cancelled and its links revoked. A request everyone has signed cannot be
   * recalled. Returns the request closed, if there was one.
   */
  async cancelForLease(
    tx: Tx,
    leaseId: string,
    input: { readonly reason: string; readonly by: string | null },
  ): Promise<string | null> {
    const latest = await this.latestFor(tx, leaseId, { lock: true });
    if (!latest) return null;
    if (latest.status === 'completed')
      throw conflict(
        'signing_complete',
        'Everyone has signed this lease; it can no longer be recalled',
      );
    const allSigned = signingCompleteBy(
      'all_required',
      (await signersOf(tx, latest.id)).map((s) => ({
        required: s.required,
        status: s.status as SignerStatus,
      })),
    );
    if (latest.status === 'pending' && allSigned)
      throw conflict(
        'signing_complete',
        'Everyone has signed this lease and its signed copy is being prepared',
      );
    if (latest.status !== 'preparing' && latest.status !== 'pending') return null;
    const now = this.clock.now();
    const reason = input.reason.trim().slice(0, 500) || 'Recalled';
    await tx
      .update(schema.signingRequest)
      .set({ status: 'cancelled', cancelledAt: now, cancelReason: reason, updatedAt: now })
      .where(eq(schema.signingRequest.id, latest.id));
    const revoked = await revokeLinks(tx, { requestId: latest.id }, 'request_closed', now);
    await signingEvent(tx, latest, 'request.cancelled', now, { data: { reason, revoked } });
    await this.audit.append(tx, {
      companyId: latest.companyId,
      action: 'signing.cancelled',
      recordType: 'signing_request',
      recordId: latest.id,
      data: { leaseId, reason, by: input.by },
    });
    return latest.id;
  }

  /** A request's status and lease, for the tenancy module's guards (it cannot read these tables). */
  async requestState(
    tx: Tx,
    requestId: string,
  ): Promise<{ readonly status: SigningRequestStatus; readonly leaseId: string | null } | null> {
    const [row] = await tx
      .select({ status: schema.signingRequest.status, leaseId: schema.signingRequest.leaseId })
      .from(schema.signingRequest)
      .where(eq(schema.signingRequest.id, requestId));
    return row ? { status: row.status as SigningRequestStatus, leaseId: row.leaseId } : null;
  }

  /** The lease's request still out for signature (preparing or pending), if any. */
  async openRequestFor(
    tx: Tx,
    leaseId: string,
  ): Promise<{ readonly id: string; readonly status: SigningRequestStatus } | null> {
    const [row] = await tx
      .select({ id: schema.signingRequest.id, status: schema.signingRequest.status })
      .from(schema.signingRequest)
      .where(
        and(
          eq(schema.signingRequest.leaseId, leaseId),
          inArray(schema.signingRequest.status, ['preparing', 'pending']),
        ),
      );
    return row ? { id: row.id, status: row.status as SigningRequestStatus } : null;
  }

  // Links -----------------------------------------------------------------------------------------

  /**
   * A single-use signing link for one signer, made in the caller's transaction (staff hand-over,
   * decision 2). It revokes the signer's earlier link. The raw token leaves only in the result.
   */
  async issueLink(
    tx: Tx,
    input: {
      readonly signingRequestId: string;
      readonly signerId: string;
      readonly createdBy: string | null;
    },
  ): Promise<IssuedLink> {
    const request = await requestRow(tx, input.signingRequestId, { lock: true });
    const signer = await signerRow(tx, input.signerId, { lock: true });
    if (signer.signingRequestId !== request.id) throw notFound('Signer');
    this.assertLinkable(request, signer, 'sign', await signersOf(tx, request.id));
    return this.mint(tx, request, signer, 'sign', { createdBy: input.createdBy, via: 'handover' });
  }

  /**
   * The link a message carries (the messaging module's `sign` and `signed_copy` link resolvers),
   * made at send time so the raw token is never stored (plan 4.8). Refuses with a 409 when what it
   * links to has closed, which the send job records as "not sent". The signer's earlier link keeps
   * working until this message is sent (messageLinkSent), so a reminder that fails never leaves
   * them without one (review finding 10).
   */
  async messageLinkUrl(
    companyId: string,
    signerId: string,
    messageId: string,
    purpose: SignerLinkPurpose,
  ): Promise<string> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const found = await signerRow(tx, signerId);
      const request = await requestRow(tx, found.signingRequestId, { lock: true });
      const signer = await signerRow(tx, signerId, { lock: true });
      this.assertLinkable(request, signer, purpose, await signersOf(tx, request.id));
      return (await this.mint(tx, request, signer, purpose, { messageId, via: 'message' })).url;
    });
  }

  /**
   * A message carrying a signer's new link was sent: their earlier links of that purpose stop
   * working, in the transaction that records the send. If the new link was replaced meanwhile (a
   * hand-over, the tenant app) or its request closed, nothing changes. The request is locked
   * first, in the engine's order, so this never crosses a signer acting at the same moment.
   */
  async messageLinkSent(
    tx: Tx,
    signerId: string,
    messageId: string,
    purpose: SignerLinkPurpose,
  ): Promise<void> {
    const request = await requestRow(tx, (await signerRow(tx, signerId)).signingRequestId, {
      lock: true,
    });
    // M7 decision 6: one token per message, and every one stays valid until the notice's expiry.
    if (isNoticeRequest(request)) return;
    const [sent] = await tx
      .select({ id: schema.secureLink.id })
      .from(schema.secureLink)
      .where(
        and(
          eq(schema.secureLink.signerId, signerId),
          eq(schema.secureLink.messageId, messageId),
          eq(schema.secureLink.purpose, purpose),
          sql`${schema.secureLink.revokedAt} is null`,
        ),
      )
      .orderBy(desc(schema.secureLink.createdAt))
      .limit(1);
    if (!sent) return;
    await revokeLinks(tx, { signerId, purpose }, 'superseded', this.clock.now(), sent.id);
  }

  /**
   * A message meant to carry a signer's new link was not sent: that link reached nobody, so it is
   * revoked, and the link the signer already has keeps working.
   */
  async messageLinkNotSent(tx: Tx, signerId: string, messageId: string): Promise<void> {
    const signer = await signerRow(tx, signerId);
    const request = await requestRow(tx, signer.signingRequestId, { lock: true });
    const now = this.clock.now();
    const revoked = await tx.execute<{ id: string }>(
      sql`update secure_link set revoked_at = ${now}, revoke_reason = 'not_delivered'
          where signer_id = ${signerId} and message_id = ${messageId} and revoked_at is null
          returning id`,
    );
    if (revoked.rows.length === 0) return;
    await signingEvent(tx, request, 'link.not_delivered', now, {
      signerId,
      data: { linkIds: revoked.rows.map((r) => r.id), messageId },
    });
  }

  /**
   * A fresh signing link for the tenant app's own signer (GET /me/signing). The caller has checked,
   * in the tenant's own scoped transaction, that the signer is theirs (tenantSigner).
   */
  async tenantAppLink(companyId: string, signerId: string): Promise<IssuedLink> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const found = await signerRow(tx, signerId);
      const request = await requestRow(tx, found.signingRequestId, { lock: true });
      const signer = await signerRow(tx, signerId, { lock: true });
      if (!signsAsTenant(signer.subjectType)) throw notFound('Signer');
      this.assertLinkable(request, signer, 'sign', await signersOf(tx, request.id));
      return this.mint(tx, request, signer, 'sign', { via: 'tenant_app' });
    });
  }

  /** The snapshot a message to a signer goes to (the messaging module's `signer` recipients). */
  async signerContact(tx: Tx, signerId: string): Promise<SignerContact | null> {
    const [row] = await tx.select().from(schema.signer).where(eq(schema.signer.id, signerId));
    if (!row) return null;
    return {
      name: row.name,
      phone: row.phone,
      email: row.email,
      subject: subjectOf(row),
      tenantId: row.tenantId,
      propertyId: row.propertyId,
      isTestContact: row.isTestContact,
    };
  }

  private assertLinkable(
    request: RequestRow,
    signer: SignerRow,
    purpose: SignerLinkPurpose,
    signers: readonly SignerRow[],
  ) {
    if (purpose === 'signed_copy') {
      if (request.status !== 'completed')
        throw conflict('link_unavailable', 'The signed copy is not ready');
      return;
    }
    if (request.status !== 'pending')
      throw conflict(
        'link_unavailable',
        request.status === 'preparing'
          ? 'The document is still being prepared; links go out once it is ready'
          : 'This document is no longer out for signature',
      );
    if (signer.status !== 'pending')
      throw conflict('link_unavailable', 'This person has already signed or declined');
    if (signedByAll(signers, completionOf(request)))
      throw conflict(
        'link_unavailable',
        'Everyone who must sign has signed; the signed copy is being prepared',
      );
  }

  private async mint(
    tx: Tx,
    request: RequestRow,
    signer: SignerRow,
    purpose: SignerLinkPurpose,
    options: {
      readonly messageId?: string;
      readonly createdBy?: string | null;
      readonly via: 'message' | 'handover' | 'tenant_app';
    },
  ): Promise<IssuedLink> {
    const now = this.clock.now();
    const token = newToken();
    const days = purpose === 'sign' ? SIGNING_LINK_DAYS : SIGNED_COPY_LINK_DAYS;
    const notice = isNoticeRequest(request);
    // M7 (LN-02, decision 6): a notice's signing links all expire at the notice's link expiry.
    const expiresAt =
      notice && purpose === 'sign' && request.linksExpireAt
        ? request.linksExpireAt
        : new Date(now.getTime() + days * DAY_MS);
    // A newer link to the same signer revokes the last (plan 4.8): at once for a hand-over or the
    // tenant app, which staff or the tenant hold themselves; for a message only once it is sent.
    // A notice's links are never superseded (M7 decision 6).
    if (options.via !== 'message' && !notice)
      await revokeLinks(tx, { signerId: signer.id, purpose }, 'superseded', now);
    const [link] = await tx
      .insert(schema.secureLink)
      .values({
        companyId: signer.companyId,
        propertyId: signer.propertyId,
        tenantId: signer.tenantId,
        purpose,
        tokenHash: tokenHash(token),
        signerId: signer.id,
        messageId: options.messageId ?? null,
        expiresAt,
        createdBy: options.createdBy ?? null,
        createdAt: now,
      })
      .returning({ id: schema.secureLink.id });
    await signingEvent(tx, request, 'link.created', now, {
      signerId: signer.id,
      data: { linkId: link!.id, purpose, via: options.via, expiresAt: expiresAt.toISOString() },
    });
    return { url: `${this.config.LINKS_ORIGIN}/l/${token}`, expiresAt };
  }

  // Finalisation ------------------------------------------------------------------------------------

  /**
   * `esign.finalise` (plan 4.8): once every required signer has signed, builds the signing
   * certificate, appends it to the frozen PDF (checked against its fingerprint first), stores the
   * signed copy write-once, records both hashes in the audit chain, emits signing.completed and
   * sends every signer a link to their copy. Idempotent: a closed request is left alone.
   */
  async finalise(
    companyId: string,
    requestId: string,
    render: PdfRender,
  ): Promise<'completed' | 'skipped'> {
    const ctx = { companyId, actorKind: 'system' as const };
    const loaded = await withCompany(this.database, ctx, async (tx) => {
      const request = await requestRow(tx, requestId);
      if (request.status !== 'pending' || !request.documentId || !request.documentSha256)
        return null;
      const signers = await signersOf(tx, requestId);
      const complete = signingCompleteBy(
        completionOf(request),
        signers.map((s) => ({ required: s.required, status: s.status as SignerStatus })),
      );
      if (!complete) return null;
      const signatures = await tx
        .select()
        .from(schema.signature)
        .where(eq(schema.signature.signingRequestId, requestId));
      return {
        request,
        signers,
        signatures,
        company: await companyFacts(tx, companyId),
        facts: await this.documentFacts(tx, request),
      };
    });
    if (!loaded) return 'skipped';
    const { request, signers, signatures, company, facts } = loaded;

    const frozen = await this.documents.documentFile(companyId, request.documentId!);
    if (!frozen || !frozen.intact || frozen.sha256 !== request.documentSha256)
      throw new Error('The frozen document no longer matches its fingerprint');

    const bySigner = new Map(signatures.map((s) => [s.signerId, s]));
    const signed = signers.filter((s) => s.status === 'signed' && bySigner.has(s.id));
    const completedAt = new Date(
      Math.max(...signed.map((s) => bySigner.get(s.id)!.signedAt.getTime())),
    );
    const certificate: SigningCertificateData = {
      documentTitle: facts.title.slice(0, 200),
      reference: facts.reference.slice(0, 60),
      documentSha256: request.documentSha256!,
      completedAt: completedAt.toISOString(),
      timeZone: company.timeZone,
      signers: signed.map((s) => {
        const sig = bySigner.get(s.id)!;
        return {
          role: SIGNER_ROLE_LABELS[s.signerRole as SignerRole],
          name: s.name.slice(0, 200),
          signedAt: sig.signedAt.toISOString(),
          method: sig.method as 'typed' | 'drawn',
          verification: verificationLabel(
            sig.verifiedChannel as 'sms' | 'email',
            sig.verifiedDestinationMasked,
          ),
          ipAddress: sig.ipAddress.slice(0, 64),
          device: sig.userAgent.slice(0, 300) || 'unknown',
          consentVersion: sig.consentVersion,
        };
      }),
    };
    const certificatePdf = await render(
      renderTemplateHtml(
        signingCertificateV1.key,
        signingCertificateV1.version,
        certificate,
        branding(company),
      ),
    );
    const final = Buffer.from(await appendPdfPages(frozen.bytes, certificatePdf));
    const file = await this.documents.storeWriteOnce({
      companyId,
      countryCode: company.countryCode,
      key: `documents/${companyId}/signed/${requestId}/${uuidv7()}.pdf`,
      bytes: final,
      contentType: 'application/pdf',
    });

    return withCompany(this.database, ctx, async (tx) => {
      const current = await requestRow(tx, requestId, { lock: true });
      if (current.status !== 'pending') return 'skipped';
      // Under the request's lock, the signatures must be exactly those on the certificate. No
      // action is accepted once everyone required has signed (review finding 9), so this holds;
      // if it ever did not, the job fails and is retried with a fresh certificate.
      const present = await tx
        .select({ signerId: schema.signature.signerId })
        .from(schema.signature)
        .where(eq(schema.signature.signingRequestId, requestId));
      const certified = new Set(signed.map((x) => x.id));
      if (present.length !== certified.size || present.some((p) => !certified.has(p.signerId)))
        throw new Error('A signature changed while the signed copy was prepared; finalising again');
      const now = this.clock.now();
      const finalDocumentId = await this.documents.recordWriteOnce(tx, file, {
        kind: 'signed_pdf',
        templateKey: signingCertificateV1.key,
        templateVersion: signingCertificateV1.version,
        dataSnapshot: certificate as unknown as Record<string, unknown>,
        createdBy: current.createdBy,
      });
      await tx
        .update(schema.signingRequest)
        .set({
          status: 'completed',
          finalDocumentId,
          finalSha256: file.sha256,
          completedAt,
          updatedAt: now,
        })
        .where(eq(schema.signingRequest.id, requestId));
      const notice = isNoticeRequest(current);
      // A notice's links still open it, now acknowledged (M7 plan 4.8); a lease's close.
      const revoked = notice ? 0 : await revokeLinks(tx, { requestId }, 'request_closed', now);
      await signingEvent(tx, current, 'request.completed', now, {
        data: { documentSha256: current.documentSha256, finalSha256: file.sha256, revoked },
      });
      // Both fingerprints go into the audit chain (CLAUDE.md section 9).
      await this.audit.append(tx, {
        companyId,
        action: 'signing.completed',
        recordType: 'signing_request',
        recordId: requestId,
        data: {
          leaseId: current.leaseId,
          documentId: current.documentId,
          documentSha256: current.documentSha256,
          finalDocumentId,
          finalSha256: file.sha256,
          completedAt: completedAt.toISOString(),
        },
      });
      if (notice)
        await enqueueOutbox(tx, {
          companyId,
          type: NOTICE_SIGNING_EVENT,
          payload: {
            kind: 'completed',
            signingRequestId: requestId,
            noticeId: current.noticeId,
            at: completedAt.toISOString(),
            finalDocumentId,
            finalSha256: file.sha256,
          },
          idempotencyKey: `${NOTICE_SIGNING_EVENT}:completed:${requestId}`,
        });
      else
        await enqueueOutbox(tx, {
          companyId,
          type: SIGNING_COMPLETED_EVENT,
          payload: {
            signingRequestId: requestId,
            leaseId: current.leaseId,
            completedAt: completedAt.toISOString(),
            finalDocumentId,
          },
          idempotencyKey: `${SIGNING_COMPLETED_EVENT}:${requestId}`,
        });
      for (const signer of signers)
        await queueMessage(tx, companyId, {
          messageId: uuidv7(),
          recipient: { type: 'signer', signerId: signer.id },
          purpose: 'signed_copy',
          subject: notice ? `Acknowledged: ${facts.title}` : `Signed by everyone: ${facts.title}`,
          body: notice
            ? `The receipt of ${facts.title} from ${company.senderName} has been acknowledged. Download the acknowledged copy at {{link}}. The link works for ${SIGNED_COPY_LINK_DAYS} days.`
            : `Everyone has signed ${facts.title} with ${company.senderName}. Download your signed copy at {{link}}. The link works for ${SIGNED_COPY_LINK_DAYS} days.`,
          link: { purpose: 'signed_copy', targetId: signer.id },
          propertyId: current.propertyId,
          related: { type: 'signing_request', id: requestId },
          requestedBy: null,
        });
      if (current.createdBy && !notice)
        await queueMessage(tx, companyId, {
          recipient: { type: 'staff', personId: current.createdBy },
          purpose: 'staff_notice',
          subject: `Signed by everyone: ${facts.title}`,
          body: `Everyone has signed ${facts.title} (reference ${facts.reference}). The signed copy, with its signing certificate, is on the lease, and each signer has been sent a link to their copy.`,
          channels: ['email'],
          propertyId: current.propertyId,
          related: { type: 'signing_request', id: requestId },
        });
      return 'completed';
    });
  }

  /**
   * Checks a request's stored documents against their fingerprints (M1 verifyFingerprint) and the
   * signed copy's hash against the audit chain's signing.completed event.
   */
  async verify(
    companyId: string,
    requestId: string,
  ): Promise<{ frozen: boolean; signed: boolean | null; audited: boolean | null }> {
    const { request, audited } = await withCompany(
      this.database,
      { companyId, actorKind: 'system' },
      async (tx) => {
        const found = await requestRow(tx, requestId);
        const data = (await this.audit.eventData(tx, {
          action: 'signing.completed',
          recordType: 'signing_request',
          recordId: requestId,
        })) as { finalSha256?: string; documentSha256?: string } | null;
        return {
          request: found,
          audited: found.finalSha256
            ? data?.finalSha256 === found.finalSha256 &&
              data?.documentSha256 === found.documentSha256
            : null,
        };
      },
    );
    const frozen = request.documentId
      ? await this.documents.documentFile(companyId, request.documentId)
      : null;
    const signed = request.finalDocumentId
      ? await this.documents.documentFile(companyId, request.finalDocumentId)
      : null;
    return {
      frozen: Boolean(frozen?.intact && frozen.sha256 === request.documentSha256),
      signed: request.finalDocumentId
        ? Boolean(signed?.intact && signed.sha256 === request.finalSha256)
        : null,
      audited,
    };
  }

  // Jobs --------------------------------------------------------------------------------------------

  /**
   * `esign.signing-reminders` for one company (every 15 minutes; plan 4.8): unsigned signers are
   * reminded 24 hours, 3 days and 7 days after the links went out (company settings), each step
   * once, and after a gap only the latest. Each reminder carries a fresh link that revokes the last.
   */
  async remindUnsigned(companyId: string): Promise<number> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const now = this.clock.now();
      const company = await companyFacts(tx, companyId);
      const hours = signingReminderHoursOf(company.settings);
      const rows = await tx
        .select({ signer: schema.signer, request: schema.signingRequest })
        .from(schema.signer)
        .innerJoin(
          schema.signingRequest,
          and(
            eq(schema.signingRequest.companyId, schema.signer.companyId),
            eq(schema.signingRequest.id, schema.signer.signingRequestId),
          ),
        )
        .where(
          and(
            eq(schema.signingRequest.status, 'pending'),
            eq(schema.signer.status, 'pending'),
            // M7: a notice has its own ladder (notices.ladder), never these reminders.
            eq(schema.signingRequest.subjectType, 'lease'),
          ),
        )
        .orderBy(asc(schema.signer.signingRequestId), asc(schema.signer.position));
      let sent = 0;
      const factsByRequest = new Map<string, DocumentFacts>();
      const complete = new Map<string, boolean>();
      for (const { signer, request } of rows) {
        if (!request.openedAt) continue;
        // Optional signers are not reminded once everyone who must sign has signed.
        if (!complete.has(request.id))
          complete.set(request.id, signedByAll(await signersOf(tx, request.id)));
        if (complete.get(request.id)) continue;
        const due = dueSigningReminders(now.getTime() - request.openedAt.getTime(), hours);
        if (due.length === 0) continue;
        const prefix = `${SIGNING_REMINDERS_JOB}:${signer.id}:`;
        const done = await tx.execute<{ key: string }>(
          sql`select key from processed_job where key like ${`${prefix}%`}`,
        );
        const sentKeys = new Set(done.rows.map((r) => r.key.slice(prefix.length)));
        const { send, skip } = reminderToSend(due, sentKeys);
        for (const step of [...skip, ...(send ? [send] : [])])
          await tx
            .insert(schema.processedJob)
            .values({ companyId, key: `${prefix}${step.key}`, jobName: SIGNING_REMINDERS_JOB })
            .onConflictDoNothing();
        if (!send) continue;
        let facts = factsByRequest.get(request.id);
        if (!facts) {
          facts = await this.documentFacts(tx, request);
          factsByRequest.set(request.id, facts);
        }
        await queueMessage(tx, companyId, {
          messageId: uuidv7(),
          recipient: { type: 'signer', signerId: signer.id },
          purpose: 'signing_reminder',
          subject: `Reminder: please sign ${facts.title}`,
          body: `A reminder from ${company.senderName}: ${facts.title} is waiting for your signature. Open {{link}} to read it and sign. This link replaces the one sent before.`,
          link: { purpose: 'sign', targetId: signer.id },
          propertyId: request.propertyId,
          related: { type: 'signing_request', id: request.id },
        });
        sent += 1;
      }
      return sent;
    });
  }

  /**
   * `housekeeping.expire-links-and-codes` for one company (hourly): links past their expiry are
   * revoked as expired, links left open on a closed request are revoked, and code locks that
   * have run their 30 minutes are lifted. Codes themselves die by time: an expired code never
   * verifies, and its record stays as evidence of the send.
   */
  async expireLinksAndCodes(
    companyId: string,
  ): Promise<{ expired: number; closed: number; unlocked: number }> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const now = this.clock.now();
      const expired = await tx.execute<{ id: string }>(
        sql`update secure_link set revoked_at = ${now}, revoke_reason = 'expired'
            where revoked_at is null and expires_at <= ${now} returning id`,
      );
      const closed = await tx.execute<{ id: string }>(
        sql`update secure_link l set revoked_at = ${now}, revoke_reason = 'request_closed'
            where l.revoked_at is null and l.purpose = 'sign' and exists (
              select 1 from signer s join signing_request r on r.company_id = s.company_id and r.id = s.signing_request_id
              where s.company_id = l.company_id and s.id = l.signer_id and r.status <> 'pending'
                and r.subject_type = 'lease')
            returning l.id`,
      );
      const unlocked = await tx.execute<{ id: string }>(
        sql`update signer set failed_code_attempts = 0, locked_until = null, updated_at = ${now}
            where locked_until is not null and locked_until <= ${now} returning id`,
      );
      return {
        expired: expired.rows.length,
        closed: closed.rows.length,
        unlocked: unlocked.rows.length,
      };
    });
  }

  // Views -------------------------------------------------------------------------------------------

  /** Signing progress of a lease's latest request, in the caller's (staff) transaction. */
  async progressForLease(tx: Tx, leaseId: string): Promise<SigningProgressView | null> {
    const request = await this.latestFor(tx, leaseId);
    if (!request) return null;
    const signers = await signersOf(tx, request.id);
    const links = signers.length
      ? await tx
          .select()
          .from(schema.secureLink)
          .where(
            inArray(
              schema.secureLink.signerId,
              signers.map((s) => s.id),
            ),
          )
          .orderBy(desc(schema.secureLink.createdAt))
      : [];
    return {
      requestId: request.id,
      status: request.status as SigningRequestStatus,
      createdAt: request.createdAt,
      openedAt: request.openedAt,
      completedAt: request.completedAt,
      declinedAt: request.declinedAt,
      declineReason: request.declineReason,
      cancelledAt: request.cancelledAt,
      cancelReason: request.cancelReason,
      documentSha256: request.documentSha256,
      finalSha256: request.finalSha256,
      frozenDocument: request.documentId !== null,
      signedDocument: request.finalDocumentId !== null,
      signers: signers.map((s): SignerProgress => {
        // A link whose message was never sent reached nobody: it is not link activity.
        const own = links.filter((l) => l.signerId === s.id && l.revokeReason !== 'not_delivered');
        const last = own.find((l) => l.purpose === 'sign') ?? null;
        return {
          id: s.id,
          role: s.signerRole as SignerRole,
          roleLabel: SIGNER_ROLE_LABELS[s.signerRole as SignerRole],
          name: s.name,
          phoneMasked: s.phone ? maskPhone(s.phone) : null,
          emailMasked: s.email ? maskEmail(s.email) : null,
          codeChannel: s.phone ? 'sms' : 'email',
          required: s.required,
          position: s.position,
          status: s.status as SignerStatus,
          firstOpenedAt: s.firstOpenedAt,
          lastOpenedAt: s.lastOpenedAt,
          signedAt: s.signedAt,
          declinedAt: s.declinedAt,
          declineReason: s.declineReason,
          lockedUntil:
            s.lockedUntil && s.lockedUntil.getTime() > this.clock.now().getTime()
              ? s.lockedUntil
              : null,
          lastLink: last
            ? {
                createdAt: last.createdAt,
                expiresAt: last.expiresAt,
                via: last.messageId ? 'message' : last.createdBy ? 'handover' : 'tenant_app',
                openedAt: last.firstOpenedAt,
              }
            : null,
          copySent: own.some((l) => l.purpose === 'signed_copy'),
        };
      }),
    };
  }

  /** The frozen PDF (or, once signed, the signed copy) of a lease's latest request. */
  async leaseDocumentId(
    tx: Tx,
    leaseId: string,
    which: 'frozen' | 'signed',
  ): Promise<string | null> {
    const request = await this.latestFor(tx, leaseId);
    if (!request) return null;
    return which === 'frozen' ? request.documentId : request.finalDocumentId;
  }

  /**
   * The signing requests the tenant app lists (GET /me/signing), in the tenant's own scoped
   * transaction: requests out for signature where the tenant signs as themselves.
   */
  async tenantRequests(tx: Tx): Promise<TenantSigningRequest[]> {
    const requests = await tx
      .select()
      .from(schema.signingRequest)
      .where(eq(schema.signingRequest.status, 'pending'))
      .orderBy(desc(schema.signingRequest.openedAt));
    const out: TenantSigningRequest[] = [];
    for (const request of requests) {
      const signers = await signersOf(tx, request.id);
      const own = signers.find((s) => signsAsTenant(s.subjectType));
      if (!own) continue;
      const facts = await this.documentFacts(tx, request);
      out.push({
        signingRequestId: request.id,
        subject: isNoticeRequest(request) ? 'notice' : 'lease',
        noticeId: request.noticeId,
        leaseId: request.leaseId!,
        status: request.status as SigningRequestStatus,
        title: facts.title,
        sentAt: request.openedAt,
        signer: {
          id: own.id,
          name: own.name,
          status: own.status as SignerStatus,
          signedAt: own.signedAt,
        },
        signers: signers.map((s) => ({
          roleLabel: SIGNER_ROLE_LABELS[s.signerRole as SignerRole],
          name: s.name,
          status: s.status as SignerStatus,
        })),
      });
    }
    return out;
  }

  /** Whether a signer is the signed-in tenant's own and can sign now, in their scoped transaction. */
  async tenantSigner(tx: Tx, signerId: string): Promise<boolean> {
    const [row] = await tx
      .select({ status: schema.signer.status, subjectType: schema.signer.subjectType })
      .from(schema.signer)
      .where(eq(schema.signer.id, signerId));
    return row !== undefined && signsAsTenant(row.subjectType) && row.status === 'pending';
  }

  // Shared with the signing page --------------------------------------------------------------------

  /** The document's title and reference, from its frozen data snapshot. */
  async documentFacts(tx: Tx, request: RequestRow): Promise<DocumentFacts> {
    const rendered = request.renderRequestId
      ? await this.documents.renderedDocument(tx, request.renderRequestId)
      : null;
    if (!rendered)
      return {
        title: 'Document',
        reference: request.id,
        templateKey: '',
        templateVersion: 0,
        data: {},
      };
    return documentFactsOf(rendered);
  }

  /** Who a signer contacts about a link: the company and the landlord's signatory (plan 4.8). */
  landlordContact(company: CompanyFacts, signers: readonly SignerRow[]): LandlordContact {
    const landlord = signers.find((s) => s.signerRole === 'landlord');
    return {
      name: company.displayName,
      contactName: landlord?.name ?? null,
      phone: landlord?.phone ?? null,
      email: landlord?.email ?? null,
    };
  }

  /** A request's document as HTML, checked against its stored hash before it is shown. */
  async documentHtml(companyId: string, request: RequestRow): Promise<string | null> {
    if (!request.htmlDocumentId || !request.htmlSha256) return null;
    const cached = this.htmlCache.get(request.htmlDocumentId);
    if (cached !== undefined) return cached;
    const file = await this.documents.documentFile(companyId, request.htmlDocumentId);
    if (!file || !file.intact || file.sha256 !== request.htmlSha256)
      throw new Error('The signing document no longer matches its fingerprint');
    const html = file.bytes.toString('utf8');
    if (this.htmlCache.size >= 50) this.htmlCache.delete(this.htmlCache.keys().next().value!);
    this.htmlCache.set(request.htmlDocumentId, html);
    return html;
  }

  private async latestFor(
    tx: Tx,
    leaseId: string,
    options: { readonly lock?: boolean } = {},
  ): Promise<RequestRow | null> {
    const query = tx
      .select()
      .from(schema.signingRequest)
      .where(eq(schema.signingRequest.leaseId, leaseId))
      .orderBy(desc(schema.signingRequest.createdAt), desc(schema.signingRequest.id))
      .limit(1);
    const [row] = options.lock ? await query.for('update') : await query;
    return row ?? null;
  }
}

function documentFactsOf(rendered: {
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly data: Record<string, unknown>;
}): DocumentFacts {
  const title = typeof rendered.data.title === 'string' ? rendered.data.title : 'Document';
  const reference = typeof rendered.data.reference === 'string' ? rendered.data.reference : '';
  return {
    title,
    reference,
    templateKey: rendered.templateKey,
    templateVersion: rendered.templateVersion,
    data: rendered.data,
  };
}
