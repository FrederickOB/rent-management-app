import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, schema, withCompany, type Database, type Tx } from '@rent/db';
import {
  renderTemplateHtml,
  sha256Hex,
  templates,
  verifyFingerprint,
  withFixedPdfDates,
  type Branding,
} from '@rent/documents';
import { businessDateOf, instantFrom } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import {
  checkDeclaredMedia,
  checkStagedMedia,
  MEDIA_RULES,
  MEDIA_SNIFF_BYTES,
  type MediaKind,
} from '@rent/domain/maintenance';
import { StorageError, type ObjectInfo, type StoragePort } from '@rent/integrations';
import sharp from 'sharp';
import { v7 as uuidv7 } from 'uuid';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { invalid, notFound } from '../core/errors';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, CONFIG, DATABASE, STORAGE_PORT } from '../core/tokens';
import { AuditService } from '../audit/audit.service';
import { RulesService } from '../rules/rules.service';

export const RENDER_PDF_JOB = 'documents.render-pdf';
/**
 * Emitted in the transaction that records a rendered PDF, so whoever asked for it (the e-signing
 * engine, M3) acts once the document and its SHA-256 exist (architecture section 9).
 */
export const DOCUMENT_RENDERED_EVENT = 'documents.rendered';

/** Renders a complete HTML document to PDF bytes: the worker's Chromium pool, or a test's. */
export type PdfRender = (html: string) => Promise<Buffer>;

/** A file stored write-once in the evidence bucket, to be recorded in the caller's transaction. */
export interface WriteOnceFile {
  readonly companyId: string;
  readonly bucket: string;
  readonly storageKey: string;
  readonly storageVersionId: string;
  readonly contentType: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly retentionMode: 'GOVERNANCE' | 'COMPLIANCE';
  readonly retainUntil: Date;
}

/** A render request and, once rendered, its document (ADR-006). */
export interface RenderedDocument {
  readonly renderRequestId: string;
  readonly status: string;
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly data: Record<string, unknown>;
  readonly requestedBy: string | null;
  readonly documentId: string | null;
  readonly sha256: string | null;
}

/** A stored document's bytes, checked against its recorded SHA-256. */
export interface DocumentFile {
  readonly documentId: string;
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly sha256: string;
  /** False when the stored bytes no longer hash to the recorded fingerprint. */
  readonly intact: boolean;
}
const DOWNLOAD_SECONDS = 300;
const UPLOAD_SECONDS = 600;

export interface UploadPurpose {
  readonly purpose:
    | 'logo'
    | 'property_photo'
    | 'property_paper'
    | 'register_import'
    | 'lease_file'
    | 'cash_photo'
    | 'transfer_proof'
    | 'banking_slip'
    | 'gra_receipt'
    | 'withholding_certificate'
    | 'refund_proof'
    | 'message_photo'
    | 'notice_service_photo'
    | 'notice_affidavit'
    | 'notice_received'
    | 'rent_assessment'
    | 'job_media'
    | 'inspection_photo'
    | 'expense_receipt';
  readonly contentTypes: readonly string[];
  readonly maxBytes: number;
}

/**
 * Papers for a lease (M3 decision 7 and plan 4.11): the scan of a lease signed on paper, a
 * stamped copy and a wet-signed formal lease. They are stored write-once as evidence.
 */
export const LEASE_FILE_UPLOAD: UploadPurpose = {
  purpose: 'lease_file',
  contentTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  maxBytes: 20_000_000,
};

/**
 * Proof of money (M4a plan 4.8): a photo of the receipt-book page or the cheque, a transfer's proof
 * (a screenshot or statement line) and a banking slip. Stored write-once as evidence.
 */
const MONEY_PROOF = {
  contentTypes: ['image/jpeg', 'image/png', 'application/pdf'],
  maxBytes: 10_000_000,
} as const;
export const CASH_PHOTO_UPLOAD: UploadPurpose = { purpose: 'cash_photo', ...MONEY_PROOF };
export const TRANSFER_PROOF_UPLOAD: UploadPurpose = { purpose: 'transfer_proof', ...MONEY_PROOF };
export const BANKING_SLIP_UPLOAD: UploadPurpose = { purpose: 'banking_slip', ...MONEY_PROOF };
/**
 * M5: GRA's receipt for rent tax or VAT paid (P18, P33), a withholding certificate (P20) and the
 * proof a refund was paid (P13). Evidence, stored write-once like the money proofs.
 */
export const GRA_RECEIPT_UPLOAD: UploadPurpose = { purpose: 'gra_receipt', ...MONEY_PROOF };
export const WITHHOLDING_CERTIFICATE_UPLOAD: UploadPurpose = {
  purpose: 'withholding_certificate',
  ...MONEY_PROOF,
};
export const REFUND_PROOF_UPLOAD: UploadPurpose = { purpose: 'refund_proof', ...MONEY_PROOF };

/**
 * M6 (plan 4.10): a photo a tenant sends in the app's conversation, checked against its real bytes
 * and kept write-once like the media copied from WhatsApp.
 */
export const MESSAGE_PHOTO_UPLOAD: UploadPurpose = {
  purpose: 'message_photo',
  contentTypes: ['image/jpeg', 'image/png', 'image/webp'],
  maxBytes: 10_000_000,
};

/**
 * M7: a photo of a notice posted on the premises, a sworn affidavit of service, a notice the tenant
 * gave, and a Rent Officer assessment (plan 4.7, 4.9, decision 13 and 3). Evidence, write-once.
 */
const NOTICE_EVIDENCE = {
  contentTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  maxBytes: 20_000_000,
} as const;
export const NOTICE_PHOTO_UPLOAD: UploadPurpose = {
  purpose: 'notice_service_photo',
  ...NOTICE_EVIDENCE,
};
export const NOTICE_AFFIDAVIT_UPLOAD: UploadPurpose = {
  purpose: 'notice_affidavit',
  ...NOTICE_EVIDENCE,
};
export const NOTICE_RECEIVED_UPLOAD: UploadPurpose = {
  purpose: 'notice_received',
  ...NOTICE_EVIDENCE,
};
export const RENT_ASSESSMENT_UPLOAD: UploadPurpose = {
  purpose: 'rent_assessment',
  ...NOTICE_EVIDENCE,
};

/**
 * M8 (decision 2): media for repairs, inspections and expenses. The kinds each purpose takes and
 * their limits are the domain's (MEDIA_RULES); each upload's own limit is its kind's. Staging
 * streams the file and checks its first bytes; nothing is transcoded.
 */
export interface MediaPurpose extends UploadPurpose {
  readonly kinds: readonly MediaKind[];
}
const typesOf = (kinds: readonly MediaKind[]) => kinds.flatMap((k) => MEDIA_RULES[k].contentTypes);
const maxOf = (kinds: readonly MediaKind[]) =>
  Math.max(...kinds.map((k) => MEDIA_RULES[k].maxBytes));
const media = (purpose: MediaPurpose['purpose'], kinds: readonly MediaKind[]): MediaPurpose => ({
  purpose,
  kinds,
  contentTypes: typesOf(kinds),
  maxBytes: maxOf(kinds),
});
export const JOB_MEDIA_UPLOAD = media('job_media', ['image', 'video', 'audio']);
export const INSPECTION_PHOTO_UPLOAD = media('inspection_photo', ['image']);
export const EXPENSE_RECEIPT_UPLOAD = media('expense_receipt', ['image', 'document']);

/** A media upload checked and streamed to write-once storage, waiting to be recorded. */
export interface StagedMedia {
  readonly companyId: string;
  readonly uploadId: string;
  readonly uploadKey: string;
  readonly kind: MediaKind;
  /** What the first bytes show, which is what is recorded. */
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly durationSeconds: number | null;
  readonly storageKey: string;
  readonly storageVersionId: string;
  readonly retentionMode: 'GOVERNANCE' | 'COMPLIANCE';
  readonly retainUntil: Date;
  readonly createdBy: string;
}

/** The domain's media refusals as named 400s (`MEDIA_TYPE_MISMATCH`, `MEDIA_TOO_LARGE`, ...). */
export const mediaInvalid = (error: unknown): never => {
  if (error instanceof DomainError) throw invalid(error.code.replace(/\./g, '_'), error.message);
  throw error;
};

/** An upload checked and copied to write-once storage, waiting to be recorded as a document. */
export interface StagedEvidence {
  readonly companyId: string;
  readonly uploadId: string;
  /** The plain copy in the files bucket, removed once the write that records it has committed. */
  readonly uploadKey: string;
  readonly contentType: string;
  readonly bytes: Buffer;
  readonly storageKey: string;
  readonly storageVersionId: string;
  readonly retentionMode: 'GOVERNANCE' | 'COMPLIANCE';
  readonly retainUntil: Date;
  readonly createdBy: string;
}

/** One evidence key per upload, so staging it again finds the copy already made. */
const evidenceKeyOf = (intent: {
  readonly companyId: string;
  readonly purpose: string;
  readonly id: string;
}): string => `evidence/${intent.companyId}/${intent.purpose}/${intent.id}`;

/** What the bytes really are, whatever the upload declared. */
function sniffContentType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

export const LOGO_UPLOAD: UploadPurpose = {
  purpose: 'logo',
  contentTypes: ['image/png', 'image/jpeg', 'image/webp'],
  maxBytes: 1_000_000,
};

/**
 * Stored files and their fingerprints (ADR-006, CLAUDE.md section 10). Uploads go straight to
 * storage through short-lived presigned URLs; downloads are short-lived links issued after the
 * caller's policy check. Evidence is written once, locked for the retention in the rules table.
 */
@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RulesService) private readonly rules: RulesService,
  ) {}

  async downloadUrl(
    companyId: string,
    documentId: string,
    filename?: string,
  ): Promise<string | null> {
    const [doc] = await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      tx
        .select()
        .from(schema.document)
        .where(and(eq(schema.document.companyId, companyId), eq(schema.document.id, documentId))),
    );
    if (!doc) return null;
    return this.storage.createDownloadUrl({
      bucket: doc.bucket,
      key: doc.storageKey,
      versionId: doc.storageVersionId ?? undefined,
      expiresInSeconds: DOWNLOAD_SECONDS,
      ...(filename ? { filename } : {}),
    });
  }

  /**
   * A stored document's bytes, re-hashed and compared with the fingerprint recorded when it was
   * stored (M1 verifyFingerprint). Callers check first that the reader may see the document.
   */
  async documentFile(companyId: string, documentId: string): Promise<DocumentFile | null> {
    const [doc] = await withCompany(this.database, { companyId, actorKind: 'system' }, (tx) =>
      tx
        .select()
        .from(schema.document)
        .where(and(eq(schema.document.companyId, companyId), eq(schema.document.id, documentId))),
    );
    if (!doc) return null;
    const bytes = await this.storage.get({
      bucket: doc.bucket,
      key: doc.storageKey,
      versionId: doc.storageVersionId ?? undefined,
    });
    return {
      documentId: doc.id,
      bytes,
      contentType: doc.contentType,
      sha256: doc.sha256,
      intact: verifyFingerprint(bytes, doc.sha256),
    };
  }

  /**
   * Stores bytes write-once in the evidence bucket, under Object Lock for the retention in the
   * rules table, and checks the store kept exactly them. Runs outside any transaction; the caller
   * records the file with recordWriteOnce in its own.
   */
  async storeWriteOnce(input: {
    readonly companyId: string;
    readonly countryCode: string;
    readonly key: string;
    readonly bytes: Buffer;
    readonly contentType: string;
  }): Promise<WriteOnceFile> {
    const retention = await this.evidenceRetention(input.countryCode);
    const stored = await this.storage.putWriteOnce({
      bucket: this.config.S3_BUCKET_EVIDENCE,
      key: input.key,
      body: input.bytes,
      contentType: input.contentType,
      retainUntil: retention.retainUntil,
      mode: retention.mode,
    });
    const sha256 = sha256Hex(input.bytes);
    if (stored.sha256 !== sha256) throw new Error('Stored bytes do not match what was written');
    return {
      companyId: input.companyId,
      bucket: this.config.S3_BUCKET_EVIDENCE,
      storageKey: input.key,
      storageVersionId: stored.versionId,
      contentType: input.contentType,
      bytes: input.bytes,
      sha256,
      retentionMode: retention.mode,
      retainUntil: retention.retainUntil,
    };
  }

  /** Records a file from storeWriteOnce as a write-once document, in the caller's transaction. */
  async recordWriteOnce(
    tx: Tx,
    file: WriteOnceFile,
    meta: {
      readonly kind: string;
      readonly templateKey?: string | null;
      readonly templateVersion?: number | null;
      readonly dataSnapshot?: Record<string, unknown> | null;
      readonly createdBy?: string | null;
    },
  ): Promise<string> {
    return this.insertDocument(tx, {
      companyId: file.companyId,
      kind: meta.kind,
      contentType: file.contentType,
      bytes: file.bytes,
      bucket: file.bucket,
      storageKey: file.storageKey,
      storageVersionId: file.storageVersionId,
      writeOnce: true,
      retentionMode: file.retentionMode,
      retainUntil: file.retainUntil,
      templateKey: meta.templateKey ?? null,
      templateVersion: meta.templateVersion ?? null,
      dataSnapshot: meta.dataSnapshot ?? null,
      createdBy: meta.createdBy ?? null,
    });
  }

  /** A render request and its document, in the caller's transaction. */
  async renderedDocument(tx: Tx, renderRequestId: string): Promise<RenderedDocument | null> {
    const [request] = await tx
      .select()
      .from(schema.documentRenderRequest)
      .where(eq(schema.documentRenderRequest.id, renderRequestId));
    if (!request) return null;
    const [doc] = request.documentId
      ? await tx
          .select({ id: schema.document.id, sha256: schema.document.sha256 })
          .from(schema.document)
          .where(eq(schema.document.id, request.documentId))
      : [];
    return {
      renderRequestId: request.id,
      status: request.status,
      templateKey: request.templateKey,
      templateVersion: request.templateVersion,
      data: request.data as Record<string, unknown>,
      requestedBy: request.requestedBy,
      documentId: doc?.id ?? null,
      sha256: doc?.sha256 ?? null,
    };
  }

  /**
   * The `documents.render-pdf` job (ADR-006; architecture section 10): renders a frozen template
   * and data snapshot to PDF, stores it write-once with the retention from the rules table, and
   * records its fingerprint, emitting documents.rendered in the same transaction. A retry after
   * success does nothing. Returns the document id.
   */
  async renderRequested(
    companyId: string,
    renderRequestId: string,
    render: PdfRender,
    requestId?: string,
  ): Promise<string | null> {
    const ctx = { companyId, actorKind: 'system' as const, requestId: requestId ?? null };
    const { request, company } = await withCompany(this.database, ctx, async (tx) => {
      const [found] = await tx
        .select()
        .from(schema.documentRenderRequest)
        .where(eq(schema.documentRenderRequest.id, renderRequestId));
      const [owner] = await tx
        .select()
        .from(schema.company)
        .where(eq(schema.company.id, companyId));
      return { request: found, company: owner };
    });
    if (!request || !company) throw new Error('Render request or company not found');
    if (request.status === 'rendered') return request.documentId; // a retry after success

    const branding: Branding = {
      senderName: company.senderName,
      primaryColour: company.primaryColour,
      accentColour: company.accentColour,
      ...(await this.thumbnails(companyId, request.data)),
    };
    const html = renderTemplateHtml(
      request.templateKey,
      request.templateVersion,
      request.data,
      branding,
    );
    const rendered = await render(html);
    // A report that must regenerate identically carries its own date, not the render's (M5).
    const fixedDate = templates
      .get(request.templateKey, request.templateVersion)
      .pdfDate(request.data);
    const pdf = fixedDate ? Buffer.from(await withFixedPdfDates(rendered, fixedDate)) : rendered;
    const file = await this.storeWriteOnce({
      companyId,
      countryCode: company.countryCode,
      key: `documents/${companyId}/${renderRequestId}.pdf`,
      bytes: pdf,
      contentType: 'application/pdf',
    });
    return withCompany(this.database, ctx, async (tx) => {
      const documentId = await this.recordWriteOnce(tx, file, {
        kind: 'pdf',
        templateKey: request.templateKey,
        templateVersion: request.templateVersion,
        dataSnapshot: request.data as Record<string, unknown>,
        createdBy: request.requestedBy,
      });
      await tx
        .update(schema.documentRenderRequest)
        .set({
          status: 'rendered',
          documentId,
          attempts: request.attempts + 1,
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.documentRenderRequest.id, renderRequestId));
      await enqueueOutbox(tx, {
        companyId,
        type: DOCUMENT_RENDERED_EVENT,
        payload: {
          renderRequestId,
          documentId,
          sha256: file.sha256,
          templateKey: request.templateKey,
        },
        idempotencyKey: `${DOCUMENT_RENDERED_EVENT}:${renderRequestId}`,
      });
      return documentId;
    });
  }

  /**
   * M8 (decision 11): the photos a document names (`photos: [{ documentId, sha256 }]` anywhere in
   * its data), read from storage by id, checked against their fingerprints, and shrunk to JPEG
   * thumbnails for the renderer. The frozen data keeps only ids and fingerprints.
   */
  private async thumbnails(
    companyId: string,
    data: unknown,
  ): Promise<{ images?: Record<string, string> }> {
    const wanted = new Map<string, string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (Array.isArray(o.photos))
          for (const p of o.photos as { documentId?: unknown; sha256?: unknown }[])
            if (typeof p?.documentId === 'string' && typeof p.sha256 === 'string')
              wanted.set(p.documentId, p.sha256);
        Object.values(o).forEach(walk);
      }
    };
    walk(data);
    if (wanted.size === 0) return {};
    const images: Record<string, string> = {};
    for (const [documentId, sha256] of wanted) {
      const file = await this.documentFile(companyId, documentId);
      if (!file || !file.intact || file.sha256 !== sha256) continue;
      const thumb = await sharp(file.bytes, { limitInputPixels: 50_000_000 })
        .rotate()
        .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer()
        .catch(() => null);
      if (thumb) images[documentId] = `data:image/jpeg;base64,${thumb.toString('base64')}`;
    }
    return { images };
  }

  /** A presigned POST that only accepts the declared type, up to the purpose's size limit. */
  async createUpload(
    ctx: { companyId: string; personId: string; actorKind?: 'staff' | 'system' },
    purpose: UploadPurpose,
    contentType: string,
    sizeBytes: number,
  ) {
    if (!purpose.contentTypes.includes(contentType))
      throw invalid('upload_type', 'That file type is not accepted');
    if (sizeBytes > purpose.maxBytes) throw invalid('upload_size', 'That file is too large');
    const id = uuidv7();
    const key = `uploads/${ctx.companyId}/${purpose.purpose}/${id}`;
    const expiresAt = new Date(this.clock.now().getTime() + UPLOAD_SECONDS * 1_000);
    await withCompany(this.database, { actorKind: 'staff', ...ctx }, (tx) =>
      tx.insert(schema.uploadIntent).values({
        id,
        companyId: ctx.companyId,
        purpose: purpose.purpose,
        storageKey: key,
        contentType,
        maxBytes: purpose.maxBytes,
        createdBy: ctx.personId,
        expiresAt,
      }),
    );
    const post = await this.storage.createUploadUrl({
      bucket: this.config.S3_BUCKET_FILES,
      key,
      contentType,
      maxBytes: purpose.maxBytes,
      expiresInSeconds: UPLOAD_SECONDS,
    });
    return { uploadId: id, url: post.url, fields: post.fields, expiresAt };
  }

  /**
   * M8 (decision 2): a presigned POST for a photo, video, voice note or receipt, checked as
   * declared (type, size and, for video and audio, length) against the purpose's kinds. Its limit
   * is its kind's. `uploader` is the person, or for an artisan's job sheet the artisan, who must
   * be the one who uses it.
   */
  async createMediaUpload(
    ctx: { companyId: string; personId: string | null; actorKind: 'staff' | 'system' },
    uploader: string,
    purpose: MediaPurpose,
    declared: {
      readonly contentType: string;
      readonly sizeBytes: number;
      readonly durationSeconds?: number | null;
    },
  ) {
    let kind: MediaKind;
    try {
      kind = checkDeclaredMedia({ kinds: purpose.kinds, ...declared });
    } catch (error) {
      return mediaInvalid(error);
    }
    const maxBytes = MEDIA_RULES[kind].maxBytes;
    const id = uuidv7();
    const key = `uploads/${ctx.companyId}/${purpose.purpose}/${id}`;
    const expiresAt = new Date(this.clock.now().getTime() + UPLOAD_SECONDS * 1_000);
    await withCompany(this.database, { ...ctx, personId: ctx.personId ?? undefined }, (tx) =>
      tx.insert(schema.uploadIntent).values({
        id,
        companyId: ctx.companyId,
        purpose: purpose.purpose,
        storageKey: key,
        contentType: declared.contentType,
        maxBytes,
        durationSeconds:
          MEDIA_RULES[kind].maxSeconds === undefined || !declared.durationSeconds
            ? null
            : Math.ceil(declared.durationSeconds),
        createdBy: uploader,
        expiresAt,
      }),
    );
    const post = await this.storage.createUploadUrl({
      bucket: this.config.S3_BUCKET_FILES,
      key,
      contentType: declared.contentType,
      maxBytes,
      expiresInSeconds: UPLOAD_SECONDS,
    });
    return { uploadId: id, url: post.url, fields: post.fields, expiresAt };
  }

  /**
   * M8 (decision 2): checks a media upload (its uploader, purpose, size, declared type, and its
   * first bytes) and streams it to the evidence bucket under Object Lock, never holding the file in
   * memory: it is read once to hash it and once to store it. Runs outside any transaction; record
   * it with recordStagedMedia, then discardStagedMedia. Safe to repeat until it is recorded.
   */
  async stageMediaUpload(
    ctx: { companyId: string; personId: string | null; actorKind: 'staff' | 'system' },
    uploader: string,
    uploadId: string,
    purpose: MediaPurpose,
  ): Promise<StagedMedia> {
    const context = { ...ctx, personId: ctx.personId ?? undefined };
    const [intent] = await withCompany(this.database, context, (tx) =>
      tx
        .select()
        .from(schema.uploadIntent)
        .where(
          and(
            eq(schema.uploadIntent.id, uploadId),
            eq(schema.uploadIntent.companyId, ctx.companyId),
          ),
        ),
    );
    if (!intent || intent.purpose !== purpose.purpose || intent.createdBy !== uploader)
      throw notFound('Upload');
    if (intent.status !== 'pending' || intent.expiresAt.getTime() < this.clock.now().getTime())
      throw invalid('upload_expired', 'That upload has expired; upload the file again');
    const [company] = await withCompany(this.database, context, (tx) =>
      tx
        .select({ countryCode: schema.company.countryCode })
        .from(schema.company)
        .where(eq(schema.company.id, ctx.companyId)),
    );
    const retention = await this.evidenceRetention(company?.countryCode ?? 'GH');
    const evidence = { bucket: this.config.S3_BUCKET_EVIDENCE, key: evidenceKeyOf(intent) };
    const reject = async (reason: string, error: unknown): Promise<never> => {
      await withCompany(this.database, context, (tx) =>
        tx
          .update(schema.uploadIntent)
          .set({ status: 'rejected', rejectReason: reason })
          .where(eq(schema.uploadIntent.id, uploadId)),
      );
      return mediaInvalid(error);
    };
    const check = (head: Buffer, size: number) =>
      checkStagedMedia({
        kinds: purpose.kinds,
        declaredType: intent.contentType,
        head,
        sizeBytes: size,
      });
    const staged = (
      checked: { readonly kind: MediaKind; readonly contentType: string },
      size: number,
      sha256: string,
      versionId: string,
      lock: { readonly mode: 'GOVERNANCE' | 'COMPLIANCE'; readonly retainUntil: Date },
    ): StagedMedia => ({
      companyId: ctx.companyId,
      uploadId,
      uploadKey: intent.storageKey,
      kind: checked.kind,
      contentType: checked.contentType,
      sizeBytes: size,
      sha256,
      durationSeconds: intent.durationSeconds,
      storageKey: evidence.key,
      storageVersionId: versionId,
      retentionMode: lock.mode,
      retainUntil: lock.retainUntil,
      createdBy: uploader,
    });
    const fromEarlier = async (info: ObjectInfo): Promise<StagedMedia> => {
      if (!info.versionId || !info.sha256)
        throw new Error('The evidence copy has no version or hash');
      const head = await this.storage.getHead(
        { ...evidence, versionId: info.versionId },
        MEDIA_SNIFF_BYTES,
      );
      return staged(check(head, info.size), info.size, info.sha256, info.versionId, {
        mode: info.retentionMode ?? retention.mode,
        retainUntil: info.retainUntil ?? retention.retainUntil,
      });
    };
    const earlier = await this.storage.head(evidence);
    if (earlier) return fromEarlier(earlier);

    const upload = { bucket: this.config.S3_BUCKET_FILES, key: intent.storageKey };
    const info = await this.storage.head(upload);
    if (!info) throw invalid('upload_missing', 'The file was not uploaded');
    if (info.size > intent.maxBytes || info.contentType !== intent.contentType)
      return reject(
        'size or type does not match',
        new DomainError('media.type_mismatch', 'The file does not match what was declared'),
      );
    let checked: { readonly kind: MediaKind; readonly contentType: string };
    try {
      checked = check(await this.storage.getHead(upload, MEDIA_SNIFF_BYTES), info.size);
    } catch (error) {
      return reject('contents do not match the declared type', error);
    }
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of await this.storage.getStream(upload)) {
      const bytes = chunk as Uint8Array;
      size += bytes.length;
      hash.update(bytes);
    }
    if (size !== info.size) throw new Error('The upload changed while it was read');
    const sha256 = hash.digest('hex');
    try {
      const stored = await this.storage.putWriteOnceStream({
        ...evidence,
        body: await this.storage.getStream(upload),
        sizeBytes: size,
        sha256,
        contentType: checked.contentType,
        retainUntil: retention.retainUntil,
        mode: retention.mode,
      });
      return staged(checked, size, sha256, stored.versionId, retention);
    } catch (error) {
      const raced =
        error instanceof StorageError && error.code === 'already_exists'
          ? await this.storage.head(evidence)
          : null;
      if (!raced) throw error;
      return fromEarlier(raced);
    }
  }

  /** Records staged media as a write-once document in the caller's transaction. */
  async recordStagedMedia(tx: Tx, staged: StagedMedia, kind: string): Promise<string> {
    const [row] = await tx
      .insert(schema.document)
      .values({
        companyId: staged.companyId,
        kind,
        contentType: staged.contentType,
        sizeBytes: staged.sizeBytes,
        sha256: staged.sha256,
        bucket: this.config.S3_BUCKET_EVIDENCE,
        storageKey: staged.storageKey,
        storageVersionId: staged.storageVersionId,
        writeOnce: true,
        retentionMode: staged.retentionMode,
        retainUntil: staged.retainUntil,
        createdBy: staged.createdBy,
      })
      .returning({ id: schema.document.id });
    await this.audit.append(tx, {
      companyId: staged.companyId,
      action: 'document.stored',
      recordType: 'document',
      recordId: row!.id,
      data: { kind, sha256: staged.sha256, writeOnce: true },
    });
    const updated = await tx
      .update(schema.uploadIntent)
      .set({ status: 'processed', documentId: row!.id })
      .where(
        and(eq(schema.uploadIntent.id, staged.uploadId), eq(schema.uploadIntent.status, 'pending')),
      )
      .returning({ id: schema.uploadIntent.id });
    if (updated.length === 0)
      throw invalid('upload_expired', 'That upload was already used; upload the file again');
    return row!.id;
  }

  /** Removes a staged upload's plain copy once its record has committed; never throws. */
  async discardStagedMedia(staged: StagedMedia): Promise<void> {
    await this.storage
      .delete({ bucket: this.config.S3_BUCKET_FILES, key: staged.uploadKey })
      .catch(() => undefined);
  }

  /**
   * Checks an uploaded logo, re-encodes it (which strips metadata and anything that is not an
   * image) to a PNG at most 512 px wide, and stores it as a document.
   */
  async acceptLogo(
    ctx: { companyId: string; personId: string },
    uploadId: string,
  ): Promise<string> {
    const [intent] = await withCompany(this.database, { ...ctx, actorKind: 'staff' }, (tx) =>
      tx
        .select()
        .from(schema.uploadIntent)
        .where(
          and(
            eq(schema.uploadIntent.id, uploadId),
            eq(schema.uploadIntent.companyId, ctx.companyId),
          ),
        ),
    );
    if (!intent || intent.purpose !== 'logo' || intent.createdBy !== ctx.personId)
      throw notFound('Upload');
    if (intent.status !== 'pending' || intent.expiresAt.getTime() < this.clock.now().getTime())
      throw invalid('upload_expired', 'That upload has expired; upload the file again');
    const head = await this.storage.head({
      bucket: this.config.S3_BUCKET_FILES,
      key: intent.storageKey,
    });
    if (!head) throw invalid('upload_missing', 'The file was not uploaded');
    if (head.size > intent.maxBytes || head.contentType !== intent.contentType) {
      await this.rejectUpload(ctx, uploadId, 'size or type does not match');
      throw invalid('upload_rejected', 'The file does not match what was declared');
    }
    const original = await this.storage.get({
      bucket: this.config.S3_BUCKET_FILES,
      key: intent.storageKey,
    });
    let png: Buffer;
    try {
      png = await sharp(original, { limitInputPixels: 25_000_000 })
        .rotate()
        .resize({ width: 512, withoutEnlargement: true })
        .png()
        .toBuffer();
    } catch {
      await this.rejectUpload(ctx, uploadId, 'not a readable image');
      throw invalid('upload_rejected', 'That file is not a readable image');
    }
    const documentId = uuidv7();
    const key = `logos/${ctx.companyId}/${documentId}.png`;
    await this.storage.put({
      bucket: this.config.S3_BUCKET_FILES,
      key,
      body: png,
      contentType: 'image/png',
    });
    const stored = await this.storage.head({ bucket: this.config.S3_BUCKET_FILES, key });
    await withCompany(this.database, { ...ctx, actorKind: 'staff' }, async (tx) => {
      await this.insertDocument(tx, {
        id: documentId,
        companyId: ctx.companyId,
        kind: 'logo',
        contentType: 'image/png',
        bytes: png,
        bucket: this.config.S3_BUCKET_FILES,
        storageKey: key,
        storageVersionId: stored?.versionId ?? null,
        writeOnce: false,
        createdBy: ctx.personId,
      });
      await tx
        .update(schema.uploadIntent)
        .set({ status: 'processed', documentId })
        .where(eq(schema.uploadIntent.id, uploadId));
    });
    return documentId;
  }

  /**
   * Checks an upload (its uploader, purpose, size, declared type and real bytes) and copies it to
   * the evidence bucket under Object Lock, with the retention from the rules table. Runs outside
   * any transaction; the caller then records it with recordStagedEvidence in its own, and calls
   * discardStagedUpload once that has committed.
   *
   * Safe to repeat until the upload is recorded: the evidence copy has one key per upload, so a
   * retry after a write that failed, was refused or lost its answer finds the copy it already made
   * instead of storing a second one, and the plain copy stays until the write has committed.
   */
  async stageEvidenceUpload(
    ctx: { companyId: string; personId: string; actorKind?: 'staff' | 'system' },
    uploadId: string,
    purpose: UploadPurpose,
  ): Promise<StagedEvidence> {
    const [intent] = await withCompany(this.database, { actorKind: 'staff', ...ctx }, (tx) =>
      tx
        .select()
        .from(schema.uploadIntent)
        .where(
          and(
            eq(schema.uploadIntent.id, uploadId),
            eq(schema.uploadIntent.companyId, ctx.companyId),
          ),
        ),
    );
    if (!intent || intent.purpose !== purpose.purpose || intent.createdBy !== ctx.personId)
      throw notFound('Upload');
    if (intent.status !== 'pending' || intent.expiresAt.getTime() < this.clock.now().getTime())
      throw invalid('upload_expired', 'That upload has expired; upload the file again');
    const [company] = await withCompany(this.database, { actorKind: 'staff', ...ctx }, (tx) =>
      tx
        .select({ countryCode: schema.company.countryCode })
        .from(schema.company)
        .where(eq(schema.company.id, ctx.companyId)),
    );
    const retention = await this.evidenceRetention(company?.countryCode ?? 'GH');
    const evidence = { bucket: this.config.S3_BUCKET_EVIDENCE, key: evidenceKeyOf(intent) };
    const staged = (
      bytes: Buffer,
      versionId: string,
      lock: { readonly mode: 'GOVERNANCE' | 'COMPLIANCE'; readonly retainUntil: Date },
    ): StagedEvidence => ({
      companyId: ctx.companyId,
      uploadId,
      uploadKey: intent.storageKey,
      contentType: intent.contentType,
      bytes,
      storageKey: evidence.key,
      storageVersionId: versionId,
      retentionMode: lock.mode,
      retainUntil: lock.retainUntil,
      createdBy: ctx.personId,
    });
    // An earlier attempt copied it already: use that copy, checked again.
    const earlier = await this.storage.head(evidence);
    if (earlier)
      return staged(...(await this.earlierEvidence(evidence, intent, earlier, retention)));

    const head = await this.storage.head({
      bucket: this.config.S3_BUCKET_FILES,
      key: intent.storageKey,
    });
    if (!head) throw invalid('upload_missing', 'The file was not uploaded');
    if (head.size > intent.maxBytes || head.contentType !== intent.contentType) {
      await this.rejectUpload(ctx, uploadId, 'size or type does not match');
      throw invalid('upload_rejected', 'The file does not match what was declared');
    }
    const bytes = await this.storage.get({
      bucket: this.config.S3_BUCKET_FILES,
      key: intent.storageKey,
    });
    if (sniffContentType(bytes) !== intent.contentType) {
      await this.rejectUpload(ctx, uploadId, 'contents do not match the declared type');
      throw invalid('upload_rejected', 'The file is not the PDF or image it was declared as');
    }
    let stored: { readonly versionId: string; readonly sha256: string };
    try {
      stored = await this.storage.putWriteOnce({
        ...evidence,
        body: bytes,
        contentType: intent.contentType,
        retainUntil: retention.retainUntil,
        mode: retention.mode,
      });
    } catch (error) {
      // Another request staged the same upload at the same moment: use its copy.
      const raced =
        error instanceof StorageError && error.code === 'already_exists'
          ? await this.storage.head(evidence)
          : null;
      if (!raced) throw error;
      return staged(...(await this.earlierEvidence(evidence, intent, raced, retention)));
    }
    if (stored.sha256 !== createHash('sha256').update(bytes).digest('hex'))
      throw new Error('Stored bytes do not match the upload');
    return staged(bytes, stored.versionId, retention);
  }

  /**
   * The evidence copy an earlier attempt made of an upload: its bytes, checked against the
   * checksum the store kept and the declared type, with the lock it was stored under.
   */
  private async earlierEvidence(
    evidence: { readonly bucket: string; readonly key: string },
    intent: { readonly contentType: string },
    info: ObjectInfo,
    retention: { readonly mode: 'GOVERNANCE' | 'COMPLIANCE'; readonly retainUntil: Date },
  ): Promise<
    [Buffer, string, { readonly mode: 'GOVERNANCE' | 'COMPLIANCE'; readonly retainUntil: Date }]
  > {
    if (!info.versionId) throw new Error('The evidence copy has no version');
    const bytes = await this.storage.get({ ...evidence, versionId: info.versionId });
    if (info.sha256 && info.sha256 !== createHash('sha256').update(bytes).digest('hex'))
      throw new Error('The evidence copy does not match its checksum');
    if (sniffContentType(bytes) !== intent.contentType)
      throw new Error('The evidence copy is not the type its upload declared');
    return [
      bytes,
      info.versionId,
      {
        mode: info.retentionMode ?? retention.mode,
        retainUntil: info.retainUntil ?? retention.retainUntil,
      },
    ];
  }

  /**
   * Removes an upload's plain copy from the files bucket once the write that recorded it has
   * committed. It never throws: a copy left behind is only a stray file nobody can be sent.
   */
  async discardStagedUpload(staged: StagedEvidence): Promise<void> {
    await this.storage
      .delete({ bucket: this.config.S3_BUCKET_FILES, key: staged.uploadKey })
      .catch(() => undefined);
  }

  /** Records a staged upload as a write-once document in the caller's transaction. */
  async recordStagedEvidence(tx: Tx, staged: StagedEvidence, kind: string): Promise<string> {
    const documentId = await this.insertDocument(tx, {
      companyId: staged.companyId,
      kind,
      contentType: staged.contentType,
      bytes: staged.bytes,
      bucket: this.config.S3_BUCKET_EVIDENCE,
      storageKey: staged.storageKey,
      storageVersionId: staged.storageVersionId,
      writeOnce: true,
      retentionMode: staged.retentionMode,
      retainUntil: staged.retainUntil,
      createdBy: staged.createdBy,
    });
    const updated = await tx
      .update(schema.uploadIntent)
      .set({ status: 'processed', documentId })
      .where(
        and(eq(schema.uploadIntent.id, staged.uploadId), eq(schema.uploadIntent.status, 'pending')),
      )
      .returning({ id: schema.uploadIntent.id });
    if (updated.length === 0)
      throw invalid('upload_expired', 'That upload was already used; upload the file again');
    return documentId;
  }

  /** Queues a PDF render (ADR-006); the worker renders, fingerprints and stores it write-once. */
  async requestRender(
    tx: Tx,
    input: {
      companyId: string;
      templateKey: string;
      templateVersion: number;
      data: Record<string, unknown>;
      requestedBy?: string | null;
    },
  ): Promise<string> {
    const [row] = await tx
      .insert(schema.documentRenderRequest)
      .values({
        companyId: input.companyId,
        templateKey: input.templateKey,
        templateVersion: input.templateVersion,
        data: input.data,
        requestedBy: input.requestedBy ?? null,
      })
      .returning({ id: schema.documentRenderRequest.id });
    await enqueueOutbox(tx, {
      companyId: input.companyId,
      type: RENDER_PDF_JOB,
      payload: { renderRequestId: row!.id },
      idempotencyKey: `${RENDER_PDF_JOB}:${row!.id}`,
    });
    return row!.id;
  }

  /** Object Lock settings for evidence, from the retention rule (governance while unverified). */
  async evidenceRetention(
    countryCode: string,
  ): Promise<{ retainUntil: Date; mode: 'GOVERNANCE' | 'COMPLIANCE'; ruleId: string }> {
    const now = this.clock.now();
    const rule = await this.rules.resolve(
      countryCode,
      'data_retention.financial_and_notices',
      businessDateOf(instantFrom(now)),
    );
    const years = (rule.value as { years?: number } | null)?.years;
    if (!years) throw new Error('No retention period is set for financial and notice records');
    const retainUntil = new Date(now);
    retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + years);
    return {
      retainUntil,
      mode: rule.verificationStatus === 'verified' ? 'COMPLIANCE' : 'GOVERNANCE',
      ruleId: rule.ruleId,
    };
  }

  async insertDocument(
    tx: Tx,
    doc: {
      id?: string;
      companyId: string;
      kind: string;
      contentType: string;
      bytes: Buffer;
      bucket: string;
      storageKey: string;
      storageVersionId: string | null;
      writeOnce: boolean;
      retentionMode?: 'GOVERNANCE' | 'COMPLIANCE' | null;
      retainUntil?: Date | null;
      templateKey?: string | null;
      templateVersion?: number | null;
      dataSnapshot?: Record<string, unknown> | null;
      createdBy?: string | null;
    },
  ): Promise<string> {
    const sha256 = createHash('sha256').update(doc.bytes).digest('hex');
    const snapshotSha = doc.dataSnapshot
      ? createHash('sha256').update(JSON.stringify(doc.dataSnapshot)).digest('hex')
      : null;
    const [row] = await tx
      .insert(schema.document)
      .values({
        ...(doc.id ? { id: doc.id } : {}),
        companyId: doc.companyId,
        kind: doc.kind,
        contentType: doc.contentType,
        sizeBytes: doc.bytes.length,
        sha256,
        bucket: doc.bucket,
        storageKey: doc.storageKey,
        storageVersionId: doc.storageVersionId,
        writeOnce: doc.writeOnce,
        retentionMode: doc.retentionMode ?? null,
        retainUntil: doc.retainUntil ?? null,
        templateKey: doc.templateKey ?? null,
        templateVersion: doc.templateVersion ?? null,
        dataSnapshot: doc.dataSnapshot ?? null,
        dataSnapshotSha256: snapshotSha,
        createdBy: doc.createdBy ?? null,
      })
      .returning({ id: schema.document.id });
    await this.audit.append(tx, {
      companyId: doc.companyId,
      action: 'document.stored',
      recordType: 'document',
      recordId: row!.id,
      data: { kind: doc.kind, sha256, writeOnce: doc.writeOnce },
    });
    return row!.id;
  }

  private async rejectUpload(
    ctx: { companyId: string; personId: string; actorKind?: 'staff' | 'system' },
    uploadId: string,
    reason: string,
  ): Promise<void> {
    await withCompany(this.database, { actorKind: 'staff', ...ctx }, (tx) =>
      tx
        .update(schema.uploadIntent)
        .set({ status: 'rejected', rejectReason: reason })
        .where(eq(schema.uploadIntent.id, uploadId)),
    );
  }
}
