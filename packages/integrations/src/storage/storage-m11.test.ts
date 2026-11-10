import { describe, expect, it } from 'vitest';
import { InMemoryStorage, S3Storage } from './storage';

// M11 security review R3 F5: a presigned download is never cached by a browser or a proxy, and a
// file served as an attachment (every upload, M11 decision 6) is never rendered inline.

describe('NFR-SEC presigned downloads are no-store (M11 review R3 F5)', () => {
  it('signs Cache-Control: no-store into every S3 download link, with the attachment name', async () => {
    const s3 = new S3Storage({
      endpoint: 'http://localhost:8333',
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test-secret' },
    });
    try {
      const inline = new URL(
        await s3.createDownloadUrl({ bucket: 'b', key: 'k', expiresInSeconds: 300 }),
      );
      expect(inline.searchParams.get('response-cache-control')).toBe('no-store');
      expect(inline.searchParams.get('response-content-disposition')).toBeNull();
      const attachment = new URL(
        await s3.createDownloadUrl({
          bucket: 'b',
          key: 'k',
          expiresInSeconds: 300,
          filename: 'photo.jpg',
        }),
      );
      expect(attachment.searchParams.get('response-cache-control')).toBe('no-store');
      expect(attachment.searchParams.get('response-content-disposition')).toMatch(
        /^attachment; filename="photo\.jpg"/,
      );
    } finally {
      s3.destroy();
    }
  });

  it('the in-memory store answers its links with Cache-Control: no-store', async () => {
    const storage = new InMemoryStorage();
    await storage.ensureBuckets({ files: 'f', evidence: 'e' });
    await storage.put({ bucket: 'f', key: 'k', body: Buffer.from('x'), contentType: 'text/plain' });
    const opened = await storage.openDownload(
      await storage.createDownloadUrl({ bucket: 'f', key: 'k', expiresInSeconds: 60 }),
    );
    expect(opened).toMatchObject({ status: 200, cacheControl: 'no-store' });
  });
});
