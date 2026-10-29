import { DeleteObjectCommand, PutObjectRetentionCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { describeStorageContract } from './storage.contract';
import { InMemoryStorage, S3Storage } from './storage';

/** Reaches the client directly, to prove that no command can ask to bypass retention. */
class BypassingS3Storage extends S3Storage {
  deleteBypassingGovernance(bucket: string, key: string, versionId: string) {
    return this.client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: versionId,
        BypassGovernanceRetention: true,
      }),
    );
  }

  shortenRetentionBypassingGovernance(bucket: string, key: string, versionId: string) {
    return this.client.send(
      new PutObjectRetentionCommand({
        Bucket: bucket,
        Key: key,
        VersionId: versionId,
        BypassGovernanceRetention: true,
        Retention: { Mode: 'GOVERNANCE', RetainUntilDate: new Date(Date.now() + 1000) },
      }),
    );
  }
}

// Nothing listens on the discard port: a request that reached the network would fail as
// 'unavailable', not with the codes these tests expect.
const unreachable = {
  endpoint: 'http://127.0.0.1:9',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

describe('PLATFORM storage', () => {
  describeStorageContract('InMemoryStorage', () => {
    let clock = Date.parse('2026-10-28T09:00:00Z');
    const storage = new InMemoryStorage(() => new Date(clock));
    return Promise.resolve({
      storage,
      buckets: { files: 'files', evidence: 'evidence' },
      now: () => new Date(clock),
      wait: (ms: number) => {
        clock += ms;
        return Promise.resolve();
      },
      submitUpload: (upload, fields, body) => storage.receiveUpload(upload.url, fields, body),
      download: (url) => storage.openDownload(url),
    });
  });

  describe('InMemoryStorage', () => {
    it('stores a copy, so changing the caller’s buffer later changes nothing', async () => {
      const storage = new InMemoryStorage();
      await storage.ensureBuckets({ files: 'files', evidence: 'evidence' });
      const body = Buffer.from('evidence');
      const stored = await storage.putWriteOnce({
        bucket: 'evidence',
        key: 'doc.pdf',
        body,
        contentType: 'application/pdf',
        retainUntil: new Date(Date.now() + 60_000),
        mode: 'COMPLIANCE',
      });
      body.fill(0);
      const read = await storage.get({
        bucket: 'evidence',
        key: 'doc.pdf',
        versionId: stored.versionId,
      });
      expect(read.toString()).toBe('evidence');
      read.fill(0);
      expect((await storage.get({ bucket: 'evidence', key: 'doc.pdf' })).toString()).toBe(
        'evidence',
      );
    });
  });

  describe('S3Storage', () => {
    it('never sends the governance bypass header, whatever a command asks for', async () => {
      const storage = new BypassingS3Storage(unreachable);
      await expect(
        storage.deleteBypassingGovernance('evidence', 'doc.pdf', 'v1'),
      ).rejects.toMatchObject({
        name: 'StorageError',
        code: 'forbidden',
      });
      await expect(
        storage.shortenRetentionBypassingGovernance('evidence', 'doc.pdf', 'v1'),
      ).rejects.toMatchObject({ name: 'StorageError', code: 'forbidden' });
      storage.destroy();
    });

    it('checks requests before calling the store', async () => {
      const storage = new S3Storage(unreachable);
      const request = {
        bucket: 'evidence',
        key: 'doc.pdf',
        body: Buffer.from('x'),
        contentType: 'application/pdf',
        mode: 'GOVERNANCE' as const,
      };
      await expect(
        storage.putWriteOnce({ ...request, retainUntil: new Date(Date.now() - 1000) }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(
        storage.putWriteOnce({ ...request, retainUntil: new Date('not a date') }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(
        storage.put({ ...request, contentType: 'text/html; charset=utf-8' }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(storage.put({ ...request, key: 'a\nb' })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      const upload = {
        bucket: 'files',
        key: 'logo.png',
        contentType: 'image/png',
        expiresInSeconds: 60,
      };
      await expect(storage.createUploadUrl({ ...upload, maxBytes: 0 })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      await expect(
        storage.createUploadUrl({ ...upload, key: 'logos/${filename}', maxBytes: 10 }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(
        storage.createDownloadUrl({
          bucket: 'files',
          key: 'logo.png',
          expiresInSeconds: 8 * 24 * 3600,
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      storage.destroy();
    });

    it('signs an upload policy that fixes the key, the Content-Type and the size', async () => {
      const storage = new S3Storage(unreachable);
      const upload = await storage.createUploadUrl({
        bucket: 'files',
        key: 'logos/company.png',
        contentType: 'image/png',
        maxBytes: 1_048_576,
        expiresInSeconds: 300,
      });
      expect(upload.url).toBe('http://127.0.0.1:9/files');
      expect(upload.fields).toMatchObject({
        key: 'logos/company.png',
        'Content-Type': 'image/png',
      });
      const policy = JSON.parse(
        Buffer.from(upload.fields.Policy ?? '', 'base64').toString('utf8'),
      ) as {
        conditions: unknown[];
      };
      expect(policy.conditions).toEqual(
        expect.arrayContaining([
          { key: 'logos/company.png' },
          { bucket: 'files' },
          ['eq', '$Content-Type', 'image/png'],
          ['content-length-range', 1, 1_048_576],
        ]),
      );
      storage.destroy();
    });
  });
});
