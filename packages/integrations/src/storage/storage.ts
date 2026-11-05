import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type BucketLocationConstraint,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Object storage (CLAUDE.md sections 6 and 10, ADR-006, ADR-013, docs/plans/M1.md section 4.13).
 * Two buckets: `files` (private, versioned) for uploads and ordinary files, and `evidence` (Object
 * Lock) for documents that must never change. AWS S3 in production, SeaweedFS locally.
 */
export type RetentionMode = 'GOVERNANCE' | 'COMPLIANCE';

export interface BucketNames {
  readonly files: string;
  readonly evidence: string;
}

export interface ObjectRef {
  readonly bucket: string;
  readonly key: string;
  /** A specific version; the current one when absent. */
  readonly versionId?: string;
}

export interface UploadUrlRequest {
  readonly bucket: string;
  readonly key: string;
  /** The only Content-Type the upload may carry, for example `image/png`. */
  readonly contentType: string;
  readonly maxBytes: number;
  readonly expiresInSeconds: number;
}

/** A presigned POST: the browser sends `fields` as form fields, then the file as `file`. */
export interface PresignedUpload {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface DownloadUrlRequest extends ObjectRef {
  readonly expiresInSeconds: number;
  /** Served as an attachment with this name when given. */
  readonly filename?: string;
}

export interface PutRequest {
  readonly bucket: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface WriteOnceRequest extends PutRequest {
  readonly retainUntil: Date;
  readonly mode: RetentionMode;
}

/**
 * M8 (decision 2): a write-once object streamed rather than held in memory, for videos and voice
 * notes. The caller has hashed it already (streaming it once), so the store can verify it.
 */
export interface WriteOnceStreamRequest {
  readonly bucket: string;
  readonly key: string;
  readonly body: Readable;
  readonly sizeBytes: number;
  /** SHA-256 of the body, lowercase hex; the store rejects a body that does not match. */
  readonly sha256: string;
  readonly contentType: string;
  readonly retainUntil: Date;
  readonly mode: RetentionMode;
}

export interface StoredObject {
  /** Null only in a bucket without versioning. */
  readonly versionId: string | null;
  /** SHA-256 of the body, lowercase hex. The store verified it on receipt. */
  readonly sha256: string;
}

export interface WriteOnceResult {
  readonly versionId: string;
  readonly sha256: string;
}

export interface ObjectInfo {
  readonly size: number;
  readonly contentType: string | null;
  readonly versionId: string | null;
  readonly retentionMode: RetentionMode | null;
  readonly retainUntil: Date | null;
  /** SHA-256 the store kept for the object, lowercase hex, when it was sent one. */
  readonly sha256: string | null;
}

export interface DeleteResult {
  /** True when a delete marker was added (no version given) or removed (its version given). */
  readonly deleteMarker: boolean;
  readonly versionId: string | null;
}

/** One stored version of a key, or a delete marker. */
export interface VersionInfo {
  readonly versionId: string | null;
  readonly deleteMarker: boolean;
}

export interface StoragePort {
  readonly provider: string;
  createUploadUrl(request: UploadUrlRequest): Promise<PresignedUpload>;
  createDownloadUrl(request: DownloadUrlRequest): Promise<string>;
  /** Ordinary private files. A versioned bucket keeps earlier versions. */
  put(request: PutRequest): Promise<StoredObject>;
  /** Refuses an existing key and locks the new version until `retainUntil`. */
  putWriteOnce(request: WriteOnceRequest): Promise<WriteOnceResult>;
  /** Null when the object, the version or the bucket does not exist, or it is a delete marker. */
  head(ref: ObjectRef): Promise<ObjectInfo | null>;
  get(ref: ObjectRef): Promise<Buffer>;
  /** M8: the object as a stream, so a large file is never held in memory. */
  getStream(ref: ObjectRef): Promise<Readable>;
  /** M8: at most the first `length` bytes (fewer for a smaller object), to check its type. */
  getHead(ref: ObjectRef, length: number): Promise<Buffer>;
  /** M8: `putWriteOnce` for a streamed body of a known size and SHA-256. */
  putWriteOnceStream(request: WriteOnceStreamRequest): Promise<WriteOnceResult>;
  /** With a version id, removes that version unless it is retained; without, adds a delete marker. */
  delete(ref: ObjectRef): Promise<DeleteResult>;
  /**
   * Every version and delete marker of exactly this key, oldest first where the store says so,
   * so a file that must not survive (a photo's original, with its location) can be removed whole.
   */
  listVersions(ref: { readonly bucket: string; readonly key: string }): Promise<VersionInfo[]>;
  /** Creates the files bucket with versioning and the evidence bucket with Object Lock. Idempotent. */
  ensureBuckets(buckets: BucketNames): Promise<void>;
}

export type StorageErrorCode =
  'already_exists' | 'not_found' | 'forbidden' | 'conflict' | 'invalid_request' | 'unavailable';

/** A storage call failed. Both adapters use the same codes, so callers and tests treat them alike. */
export class StorageError extends Error {
  override readonly name = 'StorageError';
  readonly retryable: boolean;
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.retryable = code === 'unavailable' || code === 'conflict';
  }
}

/** The longest a SigV4 presigned URL may live. */
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const BYPASS_GOVERNANCE_HEADER = 'x-amz-bypass-governance-retention';

const hasControlCharacters = (value: string) =>
  [...value].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

function assertKey(key: string): void {
  // `${filename}` would turn the upload policy's exact key into a prefix (s3-presigned-post).
  if (
    key.length === 0 ||
    Buffer.byteLength(key) > 1024 ||
    hasControlCharacters(key) ||
    key.includes('${filename}')
  ) {
    throw new StorageError(
      'invalid_request',
      'Object keys are 1 to 1024 bytes without control characters',
    );
  }
}

function assertContentType(contentType: string): void {
  if (!CONTENT_TYPE.test(contentType)) {
    throw new StorageError(
      'invalid_request',
      'Content-Type must be a plain media type such as image/png',
    );
  }
}

function assertExpiry(seconds: number): void {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_PRESIGN_SECONDS) {
    throw new StorageError(
      'invalid_request',
      `Presigned URLs last 1 to ${MAX_PRESIGN_SECONDS} seconds`,
    );
  }
}

function assertUpload(request: UploadUrlRequest): void {
  assertKey(request.key);
  assertContentType(request.contentType);
  assertExpiry(request.expiresInSeconds);
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1) {
    throw new StorageError('invalid_request', 'maxBytes must be a positive integer');
  }
}

function assertRetention(request: Pick<WriteOnceRequest, 'retainUntil' | 'mode'>, now: Date): void {
  if (request.mode !== 'GOVERNANCE' && request.mode !== 'COMPLIANCE') {
    throw new StorageError('invalid_request', 'Retention mode must be GOVERNANCE or COMPLIANCE');
  }
  const until = request.retainUntil.getTime();
  if (Number.isNaN(until) || until <= now.getTime()) {
    throw new StorageError('invalid_request', 'retainUntil must be in the future');
  }
}

/** RFC 6266 attachment header with an ASCII fallback and the UTF-8 name (RFC 8187). */
function attachmentDisposition(filename: string): string {
  const name =
    [...filename]
      .filter((ch) => !hasControlCharacters(ch))
      .join('')
      .trim() || 'download';
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

const sha256 = (body: Uint8Array) => createHash('sha256').update(body).digest();

function assertStream(request: WriteOnceStreamRequest): void {
  if (!Number.isSafeInteger(request.sizeBytes) || request.sizeBytes < 1)
    throw new StorageError('invalid_request', 'A streamed object has a size of at least one byte');
  if (!/^[0-9a-f]{64}$/.test(request.sha256))
    throw new StorageError('invalid_request', 'A streamed object needs its SHA-256 in hex');
}

function storageErrorFrom(error: unknown, what: string): StorageError {
  if (error instanceof StorageError) return error;
  if (error instanceof S3ServiceException) {
    const status = error.$metadata.httpStatusCode;
    const code: StorageErrorCode =
      status === 412
        ? 'already_exists'
        : status === 404 || status === 405 // 405: the version is a delete marker
          ? 'not_found'
          : status === 403
            ? 'forbidden'
            : status === 409
              ? 'conflict'
              : status === 429 || status === undefined || status >= 500
                ? 'unavailable'
                : 'invalid_request';
    return new StorageError(code, `${what}: ${error.name}`, status);
  }
  return new StorageError('unavailable', `${what}: ${(error as Error).name || 'request failed'}`);
}

async function attempt<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw storageErrorFrom(error, what);
  }
}

export interface S3StorageOptions {
  /** SeaweedFS locally (`S3_ENDPOINT`); omitted for AWS S3. */
  readonly endpoint?: string;
  readonly region: string;
  /** Omitted in AWS, where the SDK takes the role's credentials from the environment. */
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  /** Path-style URLs. On by default with a custom endpoint, because SeaweedFS needs them. */
  readonly forcePathStyle?: boolean;
  /** HTTP handler or its options (timeouts); the SDK default when absent. */
  readonly requestHandler?: S3ClientConfig['requestHandler'];
}

/** The S3 API, for AWS S3 and SeaweedFS (ADR-013). */
export class S3Storage implements StoragePort {
  readonly provider = 's3';
  protected readonly client: S3Client;
  private readonly region: string;

  constructor(options: S3StorageOptions) {
    this.region = options.region;
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? options.endpoint !== undefined,
      credentials: options.credentials,
      requestHandler: options.requestHandler,
    });
    // Governance retention is shortened only by a break-glass role (docs/plans/M1.md section 4.13).
    // This client never asks to bypass it, whatever a future command sets.
    this.client.middlewareStack.add(
      (next) => async (args) => {
        const headers = (args.request as { headers?: Record<string, unknown> }).headers ?? {};
        if (Object.keys(headers).some((name) => name.toLowerCase() === BYPASS_GOVERNANCE_HEADER)) {
          throw new StorageError(
            'forbidden',
            'The application never bypasses governance retention',
          );
        }
        return next(args);
      },
      { step: 'build', name: 'refuseGovernanceBypass' },
    );
  }

  async createUploadUrl(request: UploadUrlRequest): Promise<PresignedUpload> {
    assertUpload(request);
    const { url, fields } = await attempt(`presign upload ${request.bucket}`, () =>
      createPresignedPost(this.client, {
        Bucket: request.bucket,
        Key: request.key,
        Expires: request.expiresInSeconds,
        // Each field becomes an exact-match condition, so the key and Content-Type are fixed.
        Fields: { 'Content-Type': request.contentType },
        Conditions: [
          ['eq', '$Content-Type', request.contentType],
          ['content-length-range', 1, request.maxBytes],
        ],
      }),
    );
    return { url, fields };
  }

  async createDownloadUrl(request: DownloadUrlRequest): Promise<string> {
    assertExpiry(request.expiresInSeconds);
    const command = new GetObjectCommand({
      Bucket: request.bucket,
      Key: request.key,
      VersionId: request.versionId,
      ResponseContentDisposition:
        request.filename === undefined ? undefined : attachmentDisposition(request.filename),
    });
    return attempt(`presign download ${request.bucket}`, () =>
      getSignedUrl(this.client, command, { expiresIn: request.expiresInSeconds }),
    );
  }

  async put(request: PutRequest): Promise<StoredObject> {
    assertKey(request.key);
    assertContentType(request.contentType);
    const digest = sha256(request.body);
    const result = await attempt(`put ${request.bucket}/${request.key}`, () =>
      this.client.send(
        new PutObjectCommand({
          Bucket: request.bucket,
          Key: request.key,
          Body: request.body,
          ContentType: request.contentType,
          // The store recomputes it and rejects a body that changed on the way (BadDigest).
          ChecksumSHA256: digest.toString('base64'),
        }),
      ),
    );
    return { versionId: result.VersionId ?? null, sha256: digest.toString('hex') };
  }

  async putWriteOnce(request: WriteOnceRequest): Promise<WriteOnceResult> {
    assertKey(request.key);
    assertContentType(request.contentType);
    assertRetention(request, new Date());
    const digest = sha256(request.body);
    const result = await attempt(`put write-once ${request.bucket}/${request.key}`, () =>
      this.client.send(
        new PutObjectCommand({
          Bucket: request.bucket,
          Key: request.key,
          Body: request.body,
          ContentType: request.contentType,
          ChecksumSHA256: digest.toString('base64'),
          // The store answers 412 if the key has a current version, so nothing is ever replaced.
          IfNoneMatch: '*',
          ObjectLockMode: request.mode,
          ObjectLockRetainUntilDate: request.retainUntil,
        }),
      ),
    );
    if (!result.VersionId) {
      throw new StorageError('invalid_request', `${request.bucket} returned no version id`);
    }
    return { versionId: result.VersionId, sha256: digest.toString('hex') };
  }

  async head(ref: ObjectRef): Promise<ObjectInfo | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: ref.bucket,
          Key: ref.key,
          VersionId: ref.versionId,
          ChecksumMode: 'ENABLED',
        }),
      );
      return {
        size: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
        versionId: result.VersionId ?? null,
        retentionMode: result.ObjectLockMode ?? null,
        retainUntil: result.ObjectLockRetainUntilDate ?? null,
        sha256: result.ChecksumSHA256
          ? Buffer.from(result.ChecksumSHA256, 'base64').toString('hex')
          : null,
      };
    } catch (error) {
      const failure = storageErrorFrom(error, `head ${ref.bucket}/${ref.key}`);
      if (failure.code === 'not_found') return null;
      throw failure;
    }
  }

  async get(ref: ObjectRef): Promise<Buffer> {
    return attempt(`get ${ref.bucket}/${ref.key}`, async () => {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: ref.bucket, Key: ref.key, VersionId: ref.versionId }),
      );
      if (!result.Body)
        throw new StorageError('not_found', `get ${ref.bucket}/${ref.key}: no body`);
      return Buffer.from(await result.Body.transformToByteArray());
    });
  }

  async getStream(ref: ObjectRef): Promise<Readable> {
    return attempt(`get stream ${ref.bucket}/${ref.key}`, async () => {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: ref.bucket, Key: ref.key, VersionId: ref.versionId }),
      );
      if (!result.Body)
        throw new StorageError('not_found', `get ${ref.bucket}/${ref.key}: no body`);
      // In Node the SDK's body is a Readable already.
      return result.Body as unknown as Readable;
    });
  }

  async getHead(ref: ObjectRef, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 1)
      throw new StorageError('invalid_request', 'Ask for at least one byte');
    return attempt(`get head ${ref.bucket}/${ref.key}`, async () => {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: ref.bucket,
          Key: ref.key,
          VersionId: ref.versionId,
          Range: `bytes=0-${length - 1}`,
        }),
      );
      if (!result.Body)
        throw new StorageError('not_found', `get ${ref.bucket}/${ref.key}: no body`);
      return Buffer.from(await result.Body.transformToByteArray()).subarray(0, length);
    });
  }

  async putWriteOnceStream(request: WriteOnceStreamRequest): Promise<WriteOnceResult> {
    assertKey(request.key);
    assertContentType(request.contentType);
    assertRetention(request, new Date());
    assertStream(request);
    const result = await attempt(`put write-once ${request.bucket}/${request.key}`, () =>
      this.client.send(
        new PutObjectCommand({
          Bucket: request.bucket,
          Key: request.key,
          Body: request.body,
          ContentLength: request.sizeBytes,
          ContentType: request.contentType,
          ChecksumSHA256: Buffer.from(request.sha256, 'hex').toString('base64'),
          IfNoneMatch: '*',
          ObjectLockMode: request.mode,
          ObjectLockRetainUntilDate: request.retainUntil,
        }),
      ),
    );
    if (!result.VersionId) {
      throw new StorageError('invalid_request', `${request.bucket} returned no version id`);
    }
    return { versionId: result.VersionId, sha256: request.sha256 };
  }

  async delete(ref: ObjectRef): Promise<DeleteResult> {
    const result = await attempt(`delete ${ref.bucket}/${ref.key}`, () =>
      this.client.send(
        new DeleteObjectCommand({ Bucket: ref.bucket, Key: ref.key, VersionId: ref.versionId }),
      ),
    );
    return { deleteMarker: result.DeleteMarker ?? false, versionId: result.VersionId ?? null };
  }

  async listVersions(ref: {
    readonly bucket: string;
    readonly key: string;
  }): Promise<VersionInfo[]> {
    const found: VersionInfo[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (;;) {
      const page = await attempt(`list versions ${ref.bucket}/${ref.key}`, () =>
        this.client.send(
          new ListObjectVersionsCommand({
            Bucket: ref.bucket,
            Prefix: ref.key,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          }),
        ),
      );
      // A prefix also matches longer keys; only this key's versions count.
      for (const v of page.Versions ?? [])
        if (v.Key === ref.key) found.push({ versionId: v.VersionId ?? null, deleteMarker: false });
      for (const m of page.DeleteMarkers ?? [])
        if (m.Key === ref.key) found.push({ versionId: m.VersionId ?? null, deleteMarker: true });
      if (!page.IsTruncated) return found;
      keyMarker = page.NextKeyMarker;
      versionIdMarker = page.NextVersionIdMarker;
    }
  }

  async ensureBuckets(buckets: BucketNames): Promise<void> {
    await this.createBucket(buckets.files, false);
    const versioning = await attempt(`versioning ${buckets.files}`, () =>
      this.client.send(new GetBucketVersioningCommand({ Bucket: buckets.files })),
    );
    if (versioning.Status !== 'Enabled') {
      await attempt(`enable versioning ${buckets.files}`, () =>
        this.client.send(
          new PutBucketVersioningCommand({
            Bucket: buckets.files,
            VersioningConfiguration: { Status: 'Enabled' },
          }),
        ),
      );
    }
    await this.createBucket(buckets.evidence, true);
    // Object Lock is chosen when a bucket is created, so a bucket without it is a configuration
    // error to report, not something to repair here.
    const lock = await this.client
      .send(new GetObjectLockConfigurationCommand({ Bucket: buckets.evidence }))
      .catch((error: unknown) => {
        const failure = storageErrorFrom(error, `object lock ${buckets.evidence}`);
        if (failure.code === 'not_found') return undefined;
        throw failure;
      });
    if (lock?.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled') {
      throw new StorageError('invalid_request', `${buckets.evidence} exists without Object Lock`);
    }
  }

  /** Closes the client's sockets. */
  destroy(): void {
    this.client.destroy();
  }

  private async createBucket(bucket: string, objectLock: boolean): Promise<void> {
    try {
      await this.client.send(
        new CreateBucketCommand({
          Bucket: bucket,
          ...(objectLock ? { ObjectLockEnabledForBucket: true } : {}),
          CreateBucketConfiguration:
            this.region === 'us-east-1'
              ? undefined
              : { LocationConstraint: this.region as BucketLocationConstraint },
        }),
      );
    } catch (error) {
      // SeaweedFS answers BucketAlreadyExists when the bucket is ours but has other settings.
      // Either way the checks that follow decide whether the bucket is usable.
      const name = error instanceof S3ServiceException ? error.name : '';
      if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') return;
      throw storageErrorFrom(error, `create bucket ${bucket}`);
    }
  }
}

interface MemoryVersion {
  readonly versionId: string | null;
  /** Null for a delete marker. */
  readonly body: Buffer | null;
  readonly contentType: string | null;
  readonly sha256: string | null;
  readonly retentionMode: RetentionMode | null;
  readonly retainUntil: Date | null;
}

interface MemoryBucket {
  readonly objectLock: boolean;
  versioning: boolean;
  /** Versions per key, oldest first. */
  readonly objects: Map<string, MemoryVersion[]>;
}

interface MemoryUpload extends UploadUrlRequest {
  readonly expiresAt: number;
}

interface MemoryDownload {
  readonly ref: ObjectRef;
  readonly disposition: string | null;
  readonly expiresAt: number;
}

/** The outcome of a form upload: the HTTP status and the S3 error code S3 would answer. */
export interface UploadResponse {
  readonly status: number;
  readonly code: string | null;
}

export interface DownloadResponse {
  readonly status: number;
  readonly body: Buffer;
  readonly contentDisposition: string | null;
}

/**
 * In-memory store with the semantics S3 and SeaweedFS showed in the storage tests: versioning,
 * If-None-Match on write-once, Object Lock retention, delete markers, upload policies and expiring
 * links. Pass a clock to move time in tests.
 */
export class InMemoryStorage implements StoragePort {
  readonly provider = 'memory';
  private readonly buckets = new Map<string, MemoryBucket>();
  private readonly uploads = new Map<string, MemoryUpload>();
  private readonly downloads = new Map<string, MemoryDownload>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async createUploadUrl(request: UploadUrlRequest): Promise<PresignedUpload> {
    assertUpload(request);
    const token = randomBytes(16).toString('hex');
    const expiresAt = this.now().getTime() + request.expiresInSeconds * 1000;
    this.uploads.set(token, { ...request, expiresAt });
    return {
      url: `memory://upload/${token}`,
      fields: { key: request.key, 'Content-Type': request.contentType },
    };
  }

  /** Accepts a form upload to a URL from `createUploadUrl`, enforcing its policy as S3 does. */
  async receiveUpload(
    url: string,
    fields: Readonly<Record<string, string>>,
    body: Uint8Array,
  ): Promise<UploadResponse> {
    const upload = this.uploads.get(url.replace('memory://upload/', ''));
    if (!upload || this.now().getTime() > upload.expiresAt) {
      return { status: 403, code: 'AccessDenied' };
    }
    // As in S3, every field must match the policy and no field may be outside it.
    const fieldsMatch =
      fields.key === upload.key &&
      fields['Content-Type'] === upload.contentType &&
      Object.keys(fields).every((name) => name === 'key' || name === 'Content-Type');
    if (!fieldsMatch) return { status: 403, code: 'AccessDenied' };
    if (body.length > upload.maxBytes) return { status: 400, code: 'EntityTooLarge' };
    if (body.length < 1) return { status: 400, code: 'EntityTooSmall' };
    if (!this.buckets.has(upload.bucket)) return { status: 404, code: 'NoSuchBucket' };
    await this.put({
      bucket: upload.bucket,
      key: upload.key,
      body,
      contentType: upload.contentType,
    });
    return { status: 204, code: null };
  }

  async createDownloadUrl(request: DownloadUrlRequest): Promise<string> {
    assertExpiry(request.expiresInSeconds);
    const token = randomBytes(16).toString('hex');
    this.downloads.set(token, {
      ref: { bucket: request.bucket, key: request.key, versionId: request.versionId },
      disposition: request.filename === undefined ? null : attachmentDisposition(request.filename),
      expiresAt: this.now().getTime() + request.expiresInSeconds * 1000,
    });
    return `memory://download/${token}`;
  }

  /** Follows a URL from `createDownloadUrl`, as a browser would. */
  async openDownload(url: string): Promise<DownloadResponse> {
    const download = this.downloads.get(url.replace('memory://download/', ''));
    const refused = { status: 403, body: Buffer.alloc(0), contentDisposition: null };
    if (!download || this.now().getTime() > download.expiresAt) return refused;
    const version = this.buckets.has(download.ref.bucket) ? this.find(download.ref) : undefined;
    if (!version?.body) return { ...refused, status: 404 };
    return {
      status: 200,
      body: Buffer.from(version.body),
      contentDisposition: download.disposition,
    };
  }

  async put(request: PutRequest): Promise<StoredObject> {
    assertKey(request.key);
    assertContentType(request.contentType);
    return this.store(this.bucket(request.bucket), request, null);
  }

  async putWriteOnce(request: WriteOnceRequest): Promise<WriteOnceResult> {
    assertKey(request.key);
    assertContentType(request.contentType);
    assertRetention(request, this.now());
    const bucket = this.bucket(request.bucket);
    if (!bucket.objectLock) {
      throw new StorageError('invalid_request', `${request.bucket} has no Object Lock`, 400);
    }
    // If-None-Match looks at the current version only, so a key whose current version is a
    // delete marker takes a new version, as in S3 and SeaweedFS.
    if (this.current(bucket, request.key)?.body) {
      throw new StorageError('already_exists', `${request.bucket}/${request.key} exists`, 412);
    }
    const stored = this.store(bucket, request, request);
    if (!stored.versionId) throw new StorageError('invalid_request', 'no version id');
    return { versionId: stored.versionId, sha256: stored.sha256 };
  }

  async head(ref: ObjectRef): Promise<ObjectInfo | null> {
    const version = this.buckets.has(ref.bucket) ? this.find(ref) : undefined;
    if (!version?.body) return null;
    return {
      size: version.body.length,
      contentType: version.contentType,
      versionId: version.versionId,
      retentionMode: version.retentionMode,
      retainUntil: version.retainUntil === null ? null : new Date(version.retainUntil),
      sha256: version.sha256,
    };
  }

  async get(ref: ObjectRef): Promise<Buffer> {
    const version = this.find(ref);
    if (!version?.body) {
      throw new StorageError('not_found', `${ref.bucket}/${ref.key} not found`, 404);
    }
    return Buffer.from(version.body);
  }

  async getStream(ref: ObjectRef): Promise<Readable> {
    const body = await this.get(ref);
    // Small chunks, so a reader that stops early is exercised as against a real store.
    return Readable.from(
      Array.from({ length: Math.ceil(body.length / 65_536) }, (_, i) =>
        body.subarray(i * 65_536, (i + 1) * 65_536),
      ),
    );
  }

  async getHead(ref: ObjectRef, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 1)
      throw new StorageError('invalid_request', 'Ask for at least one byte');
    return (await this.get(ref)).subarray(0, length);
  }

  async putWriteOnceStream(request: WriteOnceStreamRequest): Promise<WriteOnceResult> {
    assertStream(request);
    const chunks: Buffer[] = [];
    for await (const chunk of request.body) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = Buffer.concat(chunks);
    if (body.length !== request.sizeBytes || sha256(body).toString('hex') !== request.sha256)
      throw new StorageError(
        'invalid_request',
        'The body does not match its size and SHA-256',
        400,
      );
    return this.putWriteOnce({ ...request, body });
  }

  async delete(ref: ObjectRef): Promise<DeleteResult> {
    const bucket = this.bucket(ref.bucket);
    const versions = bucket.objects.get(ref.key) ?? [];
    if (ref.versionId === undefined) {
      if (!bucket.versioning) {
        bucket.objects.delete(ref.key);
        return { deleteMarker: false, versionId: null };
      }
      const marker: MemoryVersion = {
        versionId: randomUUID(),
        body: null,
        contentType: null,
        sha256: null,
        retentionMode: null,
        retainUntil: null,
      };
      bucket.objects.set(ref.key, [...versions, marker]);
      return { deleteMarker: true, versionId: marker.versionId };
    }
    const version = versions.find((v) => v.versionId === ref.versionId);
    // S3 treats deleting a version that is not there as done.
    if (!version) return { deleteMarker: false, versionId: ref.versionId };
    // Both modes refuse: this application never sends the governance bypass.
    if (version.retainUntil && version.retainUntil.getTime() > this.now().getTime()) {
      throw new StorageError('forbidden', `${ref.bucket}/${ref.key} is retained`, 403);
    }
    bucket.objects.set(
      ref.key,
      versions.filter((v) => v !== version),
    );
    return { deleteMarker: version.body === null, versionId: ref.versionId };
  }

  async listVersions(ref: {
    readonly bucket: string;
    readonly key: string;
  }): Promise<VersionInfo[]> {
    return (this.bucket(ref.bucket).objects.get(ref.key) ?? []).map((v) => ({
      versionId: v.versionId,
      deleteMarker: v.body === null,
    }));
  }

  async ensureBuckets(buckets: BucketNames): Promise<void> {
    const files = this.buckets.get(buckets.files);
    if (files) files.versioning = true;
    else
      this.buckets.set(buckets.files, { objectLock: false, versioning: true, objects: new Map() });
    const evidence = this.buckets.get(buckets.evidence);
    if (!evidence) {
      this.buckets.set(buckets.evidence, {
        objectLock: true,
        versioning: true,
        objects: new Map(),
      });
    } else if (!evidence.objectLock) {
      throw new StorageError('invalid_request', `${buckets.evidence} exists without Object Lock`);
    }
  }

  private bucket(name: string): MemoryBucket {
    const bucket = this.buckets.get(name);
    if (!bucket) throw new StorageError('not_found', `${name}: NoSuchBucket`, 404);
    return bucket;
  }

  private current(bucket: MemoryBucket, key: string): MemoryVersion | undefined {
    return bucket.objects.get(key)?.at(-1);
  }

  private find(ref: ObjectRef): MemoryVersion | undefined {
    const bucket = this.bucket(ref.bucket);
    if (ref.versionId === undefined) return this.current(bucket, ref.key);
    return bucket.objects.get(ref.key)?.find((v) => v.versionId === ref.versionId);
  }

  private store(
    bucket: MemoryBucket,
    request: PutRequest,
    retention: { readonly mode: RetentionMode; readonly retainUntil: Date } | null,
  ): StoredObject {
    // Copies, so a caller changing its buffer later cannot change what was stored.
    const body = Buffer.from(request.body);
    const digest = sha256(body).toString('hex');
    const version: MemoryVersion = {
      versionId: bucket.versioning ? randomUUID() : null,
      body,
      contentType: request.contentType,
      sha256: digest,
      retentionMode: retention?.mode ?? null,
      retainUntil: retention ? new Date(retention.retainUntil) : null,
    };
    const earlier = bucket.versioning ? (bucket.objects.get(request.key) ?? []) : [];
    bucket.objects.set(request.key, [...earlier, version]);
    return { versionId: version.versionId, sha256: digest };
  }
}
