import { createHash, randomBytes } from 'node:crypto';
import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeStorageContract } from './storage.contract';
import { S3Storage, type S3StorageOptions } from './storage';

/** Test buckets carry this prefix, so a later run can find and remove them. */
const PREFIX = 'storage-it-';
const run = `${PREFIX}${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const buckets = { files: `${run}-files`, evidence: `${run}-evidence` };

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; copy .env.example to .env`);
  return value;
}

const options = (): S3StorageOptions => ({
  endpoint: env('S3_ENDPOINT'),
  region: env('S3_REGION'),
  credentials: {
    accessKeyId: env('S3_ACCESS_KEY_ID'),
    secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
  },
});

/** Removes a test bucket and what it holds, as far as retention allows. Never bypasses it. */
async function emptyAndRemove(client: S3Client, bucket: string): Promise<void> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  for (;;) {
    const page = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    );
    for (const entry of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
      // A version still retained stays until its date passes; a later run removes it.
      await client
        .send(
          new DeleteObjectCommand({ Bucket: bucket, Key: entry.Key, VersionId: entry.VersionId }),
        )
        .catch(() => undefined);
    }
    if (!page.IsTruncated) break;
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
}

/** Buckets from runs over ten minutes old, whose two-minute retention has passed. */
async function removeEarlierRuns(client: S3Client): Promise<void> {
  const { Buckets = [] } = await client.send(new ListBucketsCommand({}));
  const cutoff = Date.now() - 10 * 60_000;
  for (const bucket of Buckets) {
    if (!bucket.Name?.startsWith(PREFIX) || bucket.Name.startsWith(run)) continue;
    if ((bucket.CreationDate?.getTime() ?? Number.POSITIVE_INFINITY) > cutoff) continue;
    await emptyAndRemove(client, bucket.Name);
  }
}

function formUpload(url: string, fields: Readonly<Record<string, string>>, body: Buffer) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  // The file goes last: S3 ignores any field after it.
  form.append('file', new Blob([new Uint8Array(body)]), 'upload.bin');
  return fetch(url, { method: 'POST', body: form });
}

/** Sends commands S3Storage itself never sends. */
class RawS3Storage extends S3Storage {
  deleteBypassingGovernance(key: string, versionId: string) {
    return this.client.send(
      new DeleteObjectCommand({
        Bucket: buckets.evidence,
        Key: key,
        VersionId: versionId,
        BypassGovernanceRetention: true,
      }),
    );
  }

  putWithChecksumOf(key: string, body: Buffer, checksumOf: Buffer) {
    return this.client.send(
      new PutObjectCommand({
        Bucket: buckets.files,
        Key: key,
        Body: body,
        ContentType: 'text/plain',
        ChecksumSHA256: createHash('sha256').update(checksumOf).digest('base64'),
      }),
    );
  }
}

describe('PLATFORM storage', () => {
  let admin: S3Client;

  beforeAll(async () => {
    admin = new S3Client({ ...options(), forcePathStyle: true });
    await removeEarlierRuns(admin);
  });

  afterAll(async () => {
    await emptyAndRemove(admin, buckets.files);
    await emptyAndRemove(admin, buckets.evidence);
    admin.destroy();
  });

  describeStorageContract('S3Storage against SeaweedFS', () => {
    const storage = new S3Storage(options());
    return Promise.resolve({
      storage,
      buckets,
      now: () => new Date(),
      wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      submitUpload: async (upload, fields, body) => {
        const response = await formUpload(upload.url, fields, body);
        const text = await response.text();
        return { status: response.status, code: /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? null };
      },
      download: async (url) => {
        const response = await fetch(url);
        return {
          status: response.status,
          body: Buffer.from(await response.arrayBuffer()),
          contentDisposition: response.headers.get('content-disposition'),
        };
      },
      cleanup: () => Promise.resolve(storage.destroy()),
    });
  });

  describe('S3Storage safeguards against SeaweedFS', () => {
    it('cannot bypass governance retention, even with credentials the store would let bypass it', async () => {
      const storage = new RawS3Storage(options());
      await storage.ensureBuckets(buckets);
      const stored = await storage.putWriteOnce({
        bucket: buckets.evidence,
        key: 'bypass/doc.pdf',
        body: Buffer.from('%PDF-1.7 bypass'),
        contentType: 'application/pdf',
        retainUntil: new Date(Date.now() + 120_000),
        mode: 'GOVERNANCE',
      });
      await expect(
        storage.deleteBypassingGovernance('bypass/doc.pdf', stored.versionId),
      ).rejects.toMatchObject({ name: 'StorageError', code: 'forbidden' });
      const ref = { bucket: buckets.evidence, key: 'bypass/doc.pdf', versionId: stored.versionId };
      expect((await storage.get(ref)).toString()).toBe('%PDF-1.7 bypass');
      storage.destroy();
    });

    it('the store rejects a body that does not match the SHA-256 sent with it', async () => {
      const storage = new RawS3Storage(options());
      await storage.ensureBuckets(buckets);
      await expect(
        storage.putWithChecksumOf('tamper/body.txt', Buffer.from('received'), Buffer.from('sent')),
      ).rejects.toMatchObject({ $metadata: { httpStatusCode: 400 } });
      expect(await storage.head({ bucket: buckets.files, key: 'tamper/body.txt' })).toBeNull();
      storage.destroy();
    });
  });
});
