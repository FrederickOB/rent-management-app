import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, schema, withCompany, type Database, type Tx } from '@rent/db';
import { businessDateOf, instantFrom } from '@rent/domain/dates';
import type { StoragePort } from '@rent/integrations';
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
const DOWNLOAD_SECONDS = 300;
const UPLOAD_SECONDS = 600;

export interface UploadPurpose {
  readonly purpose: 'logo' | 'property_photo' | 'property_paper' | 'register_import' | 'lease_file';
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

/** An upload checked and copied to write-once storage, waiting to be recorded as a document. */
export interface StagedEvidence {
  readonly companyId: string;
  readonly uploadId: string;
  readonly contentType: string;
  readonly bytes: Buffer;
  readonly storageKey: string;
  readonly storageVersionId: string;
  readonly retentionMode: 'GOVERNANCE' | 'COMPLIANCE';
  readonly retainUntil: Date;
  readonly createdBy: string;
}

/** What the bytes really are, whatever the upload declared. */
function sniffContentType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
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

  async downloadUrl(companyId: string, documentId: string): Promise<string | null> {
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
    });
  }

  /** A presigned POST that only accepts the declared type, up to the purpose's size limit. */
  async createUpload(
    ctx: { companyId: string; personId: string },
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
    await withCompany(this.database, { ...ctx, actorKind: 'staff' }, (tx) =>
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
   * any transaction; the caller then records it with recordStagedEvidence in its own.
   */
  async stageEvidenceUpload(
    ctx: { companyId: string; personId: string },
    uploadId: string,
    purpose: UploadPurpose,
  ): Promise<StagedEvidence> {
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
    if (!intent || intent.purpose !== purpose.purpose || intent.createdBy !== ctx.personId)
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
    const bytes = await this.storage.get({
      bucket: this.config.S3_BUCKET_FILES,
      key: intent.storageKey,
    });
    if (sniffContentType(bytes) !== intent.contentType) {
      await this.rejectUpload(ctx, uploadId, 'contents do not match the declared type');
      throw invalid('upload_rejected', 'The file is not the PDF or image it was declared as');
    }
    const [company] = await withCompany(this.database, { ...ctx, actorKind: 'staff' }, (tx) =>
      tx
        .select({ countryCode: schema.company.countryCode })
        .from(schema.company)
        .where(eq(schema.company.id, ctx.companyId)),
    );
    const retention = await this.evidenceRetention(company?.countryCode ?? 'GH');
    const storageKey = `evidence/${ctx.companyId}/${purpose.purpose}/${uuidv7()}`;
    const stored = await this.storage.putWriteOnce({
      bucket: this.config.S3_BUCKET_EVIDENCE,
      key: storageKey,
      body: bytes,
      contentType: intent.contentType,
      retainUntil: retention.retainUntil,
      mode: retention.mode,
    });
    if (stored.sha256 !== createHash('sha256').update(bytes).digest('hex'))
      throw new Error('Stored bytes do not match the upload');
    // The plain copy in the files bucket is no longer needed.
    await this.storage
      .delete({ bucket: this.config.S3_BUCKET_FILES, key: intent.storageKey })
      .catch(() => undefined);
    return {
      companyId: ctx.companyId,
      uploadId,
      contentType: intent.contentType,
      bytes,
      storageKey,
      storageVersionId: stored.versionId,
      retentionMode: retention.mode,
      retainUntil: retention.retainUntil,
      createdBy: ctx.personId,
    };
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
    ctx: { companyId: string; personId: string },
    uploadId: string,
    reason: string,
  ): Promise<void> {
    await withCompany(this.database, { ...ctx, actorKind: 'staff' }, (tx) =>
      tx
        .update(schema.uploadIntent)
        .set({ status: 'rejected', rejectReason: reason })
        .where(eq(schema.uploadIntent.id, uploadId)),
    );
  }
}
