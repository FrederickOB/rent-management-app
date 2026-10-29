import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, schema, withCompany, type Database } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import {
  PROPERTY_PAPER_MAX_BYTES,
  PROPERTY_PAPER_TYPES,
  PROPERTY_PHOTO_MAX_BYTES,
  PROPERTY_PHOTO_TYPES,
} from '@rent/domain/portfolio';
import type { StoragePort } from '@rent/integrations';
import sharp from 'sharp';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { forbidden, invalid, notFound } from '../core/errors';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, CONFIG, DATABASE, STORAGE_PORT } from '../core/tokens';
import { staffActor } from '../companies/companies.service';
import { DocumentsService, type UploadPurpose } from '../documents/documents.service';
import { PolicyService, staffContext } from '../policy/policy.service';

export const PROCESS_PROPERTY_FILE_JOB = 'portfolio.process-property-file';

/** PR-04 uploads (M2 plan 4.7). Photos are re-encoded; papers are kept as uploaded. */
export const PROPERTY_PHOTO_UPLOAD: UploadPurpose = {
  purpose: 'property_photo',
  contentTypes: PROPERTY_PHOTO_TYPES,
  maxBytes: PROPERTY_PHOTO_MAX_BYTES,
};
export const PROPERTY_PAPER_UPLOAD: UploadPurpose = {
  purpose: 'property_paper',
  contentTypes: PROPERTY_PAPER_TYPES,
  maxBytes: PROPERTY_PAPER_MAX_BYTES,
};

export const PROPERTY_FILE_CATEGORIES = [
  'photo',
  'title_or_indenture',
  'site_plan',
  'building_permit',
  'other',
] as const;
export type PropertyFileCategory = (typeof PROPERTY_FILE_CATEGORIES)[number];

const purposeFor = (category: PropertyFileCategory) =>
  category === 'photo' ? PROPERTY_PHOTO_UPLOAD : PROPERTY_PAPER_UPLOAD;

/** Photos need property_photo.view; title deeds, plans and permits property_paper.view (decision 4). */
const viewAction = (category: string) =>
  category === 'photo' ? ('property_photo.view' as const) : ('property_paper.view' as const);

export interface PropertyFileView {
  readonly id: string;
  readonly propertyId: string;
  readonly category: PropertyFileCategory;
  readonly status: 'processing' | 'ready' | 'failed';
  readonly caption: string | null;
  readonly originalFilename: string | null;
  readonly contentType: string | null;
  /** A short-lived link to the thumbnail of a ready photo. */
  readonly thumbnailUrl: string | null;
  readonly error: string | null;
  readonly createdAt: Date;
}

/** What the bytes really are, whatever the upload declared. */
function sniff(bytes: Buffer): string | null {
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

/** Re-encodes an image to JPEG, applying its orientation; sharp drops all metadata, location included. */
const jpeg = (input: Buffer, width: number) =>
  sharp(input, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

/**
 * Photos and papers for a property (PR-04). Uploads go straight to storage; the worker checks
 * the bytes, removes location data from images and records the result. Downloads are 5-minute
 * links issued after the policy check, so papers stay hidden from caretakers.
 */
@Injectable()
export class PropertyFilesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async createUpload(
    actor: Actor | null,
    propertyId: string,
    input: { category: PropertyFileCategory; contentType: string; sizeBytes: number },
  ) {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'property_file.upload');
    await this.visibleProperty(staff, propertyId);
    return this.documents.createUpload(
      { companyId: staff.companyId, personId: staff.personId },
      purposeFor(input.category),
      input.contentType,
      input.sizeBytes,
    );
  }

  /** Records an uploaded file and queues its processing in one transaction. */
  async confirmUpload(
    actor: Actor | null,
    propertyId: string,
    input: {
      uploadId: string;
      category: PropertyFileCategory;
      caption?: string | null;
      fileName?: string | null;
    },
  ): Promise<PropertyFileView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'property_file.upload');
    const purpose = purposeFor(input.category).purpose;
    const id = await withCompany(this.database, staffContext(staff), async (tx) => {
      const [intent] = await tx
        .select()
        .from(schema.uploadIntent)
        .where(eq(schema.uploadIntent.id, input.uploadId));
      if (!intent || intent.createdBy !== staff.personId || intent.purpose !== purpose)
        throw notFound('Upload');
      if (intent.status !== 'pending' || intent.expiresAt.getTime() < this.clock.now().getTime())
        throw invalid('upload_expired', 'That upload has expired; upload the file again');
      const [property] = await tx
        .select({ id: schema.property.id })
        .from(schema.property)
        .where(and(eq(schema.property.id, propertyId), isNull(schema.property.archivedAt)));
      if (!property) throw notFound('Property');
      const [row] = await tx
        .insert(schema.propertyFile)
        .values({
          companyId: staff.companyId,
          propertyId,
          category: input.category,
          uploadIntentId: intent.id,
          caption: input.caption?.trim().slice(0, 200) || null,
          originalFilename: input.fileName?.trim().slice(0, 200) || null,
          uploadedBy: staff.personId,
        })
        .returning({ id: schema.propertyFile.id });
      await tx
        .update(schema.uploadIntent)
        .set({ status: 'confirmed' })
        .where(eq(schema.uploadIntent.id, intent.id));
      await enqueueOutbox(tx, {
        companyId: staff.companyId,
        type: PROCESS_PROPERTY_FILE_JOB,
        payload: { propertyFileId: row!.id },
        idempotencyKey: `${PROCESS_PROPERTY_FILE_JOB}:${row!.id}`,
      });
      return row!.id;
    });
    return this.view(staff, id);
  }

  /**
   * The worker's job (PR-04). Checks the bytes against the declared type, re-encodes images
   * without metadata and deletes the original upload, fingerprints PDFs, and marks the file
   * ready. Replaying it after success changes nothing.
   */
  async process(companyId: string, propertyFileId: string): Promise<void> {
    const ctx = { companyId, actorKind: 'system' as const };
    const loaded = await withCompany(this.database, ctx, async (tx) => {
      const [file] = await tx
        .select()
        .from(schema.propertyFile)
        .where(eq(schema.propertyFile.id, propertyFileId));
      if (!file || file.status !== 'processing') return null;
      const [intent] = await tx
        .select()
        .from(schema.uploadIntent)
        .where(eq(schema.uploadIntent.id, file.uploadIntentId));
      return intent ? { file, intent } : null;
    });
    if (!loaded) return;
    const { file, intent } = loaded;
    const bucket = this.config.S3_BUCKET_FILES;
    const head = await this.storage.head({ bucket, key: intent.storageKey });
    const fail = (reason: string) => this.markFailed(companyId, file.id, intent.id, reason);
    if (!head) return fail('The file was not uploaded');
    if (head.size > intent.maxBytes) return fail('The file is larger than allowed');
    const original = await this.storage.get({
      bucket,
      key: intent.storageKey,
      versionId: head.versionId ?? undefined,
    });
    const actual = sniff(original);
    if (!actual || actual !== intent.contentType)
      return fail('The file is not the type it was declared as');

    const stored: {
      kind: string;
      key: string;
      bytes: Buffer;
      contentType: string;
      versionId: string | null;
    }[] = [];
    try {
      if (actual === 'application/pdf') {
        stored.push({
          kind: 'property_paper',
          key: intent.storageKey,
          bytes: original,
          contentType: actual,
          versionId: head.versionId,
        });
      } else {
        const photo = file.category === 'photo';
        const main = await jpeg(original, photo ? 1600 : 4000);
        const base = `property-files/${companyId}/${file.id}`;
        const versions = [
          { kind: photo ? 'property_photo' : 'property_paper', name: 'main', bytes: main },
        ];
        if (photo)
          versions.push({
            kind: 'property_photo_thumbnail',
            name: 'thumb',
            bytes: await jpeg(original, 400),
          });
        for (const v of versions) {
          const key = `${base}/${v.name}.jpg`;
          const put = await this.storage.put({
            bucket,
            key,
            body: v.bytes,
            contentType: 'image/jpeg',
          });
          stored.push({
            kind: v.kind,
            key,
            bytes: v.bytes,
            contentType: 'image/jpeg',
            versionId: put.versionId,
          });
        }
      }
    } catch {
      return fail('The image could not be read');
    }

    await withCompany(this.database, ctx, async (tx) => {
      const ids: string[] = [];
      for (const s of stored)
        ids.push(
          await this.documents.insertDocument(tx, {
            companyId,
            kind: s.kind,
            contentType: s.contentType,
            bytes: s.bytes,
            bucket,
            storageKey: s.key,
            storageVersionId: s.versionId,
            writeOnce: false,
            createdBy: file.uploadedBy,
          }),
        );
      await tx
        .update(schema.propertyFile)
        .set({
          status: 'ready',
          documentId: ids[0]!,
          thumbnailDocumentId: ids[1] ?? null,
          updatedAt: new Date(),
        })
        .where(eq(schema.propertyFile.id, file.id));
      await tx
        .update(schema.uploadIntent)
        .set({ status: 'processed', documentId: ids[0]! })
        .where(eq(schema.uploadIntent.id, intent.id));
    });
    // The original image may carry the GPS position where it was taken: keep only the re-encoded copy.
    if (actual !== 'application/pdf' && head.versionId)
      await this.storage.delete({ bucket, key: intent.storageKey, versionId: head.versionId });
  }

  private async markFailed(companyId: string, fileId: string, intentId: string, reason: string) {
    await withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      await tx
        .update(schema.propertyFile)
        .set({ status: 'failed', error: reason, updatedAt: new Date() })
        .where(eq(schema.propertyFile.id, fileId));
      await tx
        .update(schema.uploadIntent)
        .set({ status: 'rejected', rejectReason: reason })
        .where(eq(schema.uploadIntent.id, intentId));
    });
  }

  async list(actor: Actor | null, propertyId: string): Promise<PropertyFileView[]> {
    const staff = staffActor(actor);
    const photos = this.policy.can(staff, 'property_photo.view').allowed;
    const papers = this.policy.can(staff, 'property_paper.view').allowed;
    if (!photos && !papers) throw forbidden();
    await this.visibleProperty(staff, propertyId);
    const rows = await withCompany(this.database, staffContext(staff), (tx) =>
      tx
        .select({ file: schema.propertyFile, contentType: schema.document.contentType })
        .from(schema.propertyFile)
        .leftJoin(
          schema.document,
          and(
            eq(schema.document.companyId, schema.propertyFile.companyId),
            eq(schema.document.id, schema.propertyFile.documentId),
          ),
        )
        .where(
          and(
            eq(schema.propertyFile.propertyId, propertyId),
            isNull(schema.propertyFile.archivedAt),
          ),
        )
        .orderBy(asc(schema.propertyFile.createdAt)),
    );
    const visible = rows.filter(({ file }) => (file.category === 'photo' ? photos : papers));
    return Promise.all(
      visible.map(({ file, contentType }) => this.toView(staff.companyId, file, contentType)),
    );
  }

  /** A 5-minute link to a file, after the scope and category checks. */
  async downloadUrl(
    actor: Actor | null,
    fileId: string,
    variant: 'main' | 'thumbnail' = 'main',
  ): Promise<string> {
    const staff = staffActor(actor);
    const file = await this.visibleFile(staff, fileId);
    this.policy.assert(staff, viewAction(file.category));
    const documentId =
      variant === 'thumbnail' ? (file.thumbnailDocumentId ?? file.documentId) : file.documentId;
    if (file.status !== 'ready' || !documentId)
      throw invalid('file_not_ready', 'This file is still being processed');
    const url = await this.documents.downloadUrl(staff.companyId, documentId);
    if (!url) throw notFound('File');
    return url;
  }

  async archive(actor: Actor | null, fileId: string): Promise<void> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'property_file.upload');
    await this.visibleFile(staff, fileId);
    await withCompany(this.database, staffContext(staff), (tx) =>
      tx
        .update(schema.propertyFile)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.propertyFile.id, fileId)),
    );
  }

  private async view(
    staff: ReturnType<typeof staffActor>,
    fileId: string,
  ): Promise<PropertyFileView> {
    const file = await this.visibleFile(staff, fileId);
    return this.toView(staff.companyId, file, null);
  }

  private async toView(
    companyId: string,
    file: typeof schema.propertyFile.$inferSelect,
    contentType: string | null,
  ): Promise<PropertyFileView> {
    const thumbnailUrl =
      file.status === 'ready' && file.thumbnailDocumentId
        ? await this.documents.downloadUrl(companyId, file.thumbnailDocumentId)
        : null;
    return {
      id: file.id,
      propertyId: file.propertyId,
      category: file.category as PropertyFileCategory,
      status: file.status as PropertyFileView['status'],
      caption: file.caption,
      originalFilename: file.originalFilename,
      contentType,
      thumbnailUrl,
      error: file.error,
      createdAt: file.createdAt,
    };
  }

  private async visibleProperty(
    staff: ReturnType<typeof staffActor>,
    propertyId: string,
  ): Promise<void> {
    const [row] = await withCompany(this.database, staffContext(staff), (tx) =>
      tx
        .select({ id: schema.property.id })
        .from(schema.property)
        .where(and(eq(schema.property.id, propertyId), isNull(schema.property.archivedAt))),
    );
    if (!row) throw notFound('Property');
  }

  private async visibleFile(staff: ReturnType<typeof staffActor>, fileId: string) {
    const [file] = await withCompany(this.database, staffContext(staff), (tx) =>
      tx
        .select()
        .from(schema.propertyFile)
        .where(and(eq(schema.propertyFile.id, fileId), isNull(schema.propertyFile.archivedAt))),
    );
    if (!file) throw notFound('File');
    return file;
  }
}
