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
  readonly purpose: 'logo';
  readonly contentTypes: readonly string[];
  readonly maxBytes: number;
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
