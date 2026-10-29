import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BucketNames, PresignedUpload, StoragePort } from './storage';

/** What the storage contract needs from an adapter's test environment. */
export interface StorageHarness {
  readonly storage: StoragePort;
  readonly buckets: BucketNames;
  /** The store's idea of now: the real clock against a server, a test clock in memory. */
  now(): Date;
  /** Lets time pass on that clock. */
  wait(ms: number): Promise<void>;
  /** Posts a browser form to a presigned upload: these fields, then the file. */
  submitUpload(
    upload: PresignedUpload,
    fields: Readonly<Record<string, string>>,
    body: Buffer,
  ): Promise<{ status: number; code: string | null }>;
  /** Follows a presigned download URL. */
  download(
    url: string,
  ): Promise<{ status: number; body: Buffer; contentDisposition: string | null }>;
  cleanup?(): Promise<void>;
}

const sha256Hex = (body: Buffer) => createHash('sha256').update(body).digest('hex');

/**
 * The storage contract (docs/plans/M1.md sections 4.12 and 4.13). The same expectations run
 * against InMemoryStorage in the unit tests and S3Storage against SeaweedFS in the integration
 * tests, so the fake stays honest.
 */
export function describeStorageContract(name: string, setup: () => Promise<StorageHarness>): void {
  describe(name, () => {
    let h: StorageHarness;
    let counter = 0;
    const key = (label: string) => `contract/${label}-${(counter += 1)}`;
    const pdf = (text: string) => Buffer.from(`%PDF-1.7 ${text}`);
    const later = (ms: number) => new Date(h.now().getTime() + ms);
    const writeOnce = (k: string, body: Buffer, retainUntil = later(120_000)) =>
      h.storage.putWriteOnce({
        bucket: h.buckets.evidence,
        key: k,
        body,
        contentType: 'application/pdf',
        retainUntil,
        mode: 'GOVERNANCE',
      });

    beforeAll(async () => {
      h = await setup();
      await h.storage.ensureBuckets(h.buckets);
    });

    afterAll(async () => {
      await h.cleanup?.();
    });

    it('ensureBuckets is idempotent and keeps what the buckets hold', async () => {
      const k = key('idempotent');
      const stored = await writeOnce(k, pdf('kept'));
      await h.storage.ensureBuckets(h.buckets);
      await h.storage.ensureBuckets(h.buckets);
      const ref = { bucket: h.buckets.evidence, key: k, versionId: stored.versionId };
      expect(await h.storage.get(ref)).toEqual(pdf('kept'));
      expect((await h.storage.head(ref))?.retentionMode).toBe('GOVERNANCE');
    });

    it('refuses an existing bucket without Object Lock as the evidence bucket', async () => {
      await expect(
        h.storage.ensureBuckets({ files: h.buckets.files, evidence: h.buckets.files }),
      ).rejects.toMatchObject({ name: 'StorageError', code: 'invalid_request' });
    });

    it('put stores a private file with its SHA-256, and the files bucket keeps earlier versions', async () => {
      const k = key('logo');
      const first = await h.storage.put({
        bucket: h.buckets.files,
        key: k,
        body: Buffer.from('first'),
        contentType: 'image/png',
      });
      const second = await h.storage.put({
        bucket: h.buckets.files,
        key: k,
        body: Buffer.from('second'),
        contentType: 'image/png',
      });
      expect(first.sha256).toBe(sha256Hex(Buffer.from('first')));
      expect(first.versionId).not.toBeNull();
      expect(second.versionId).not.toBe(first.versionId);
      expect(await h.storage.get({ bucket: h.buckets.files, key: k })).toEqual(
        Buffer.from('second'),
      );
      const old = { bucket: h.buckets.files, key: k, versionId: first.versionId ?? '' };
      expect(await h.storage.get(old)).toEqual(Buffer.from('first'));
      expect(await h.storage.head(old)).toMatchObject({
        size: 5,
        contentType: 'image/png',
        versionId: first.versionId,
        retentionMode: null,
        retainUntil: null,
        sha256: first.sha256,
      });
    });

    it('listVersions lists every version and delete marker of exactly one key, so all can be removed', async () => {
      const k = key('original');
      const put = (target: string, text: string) =>
        h.storage.put({
          bucket: h.buckets.files,
          key: target,
          body: Buffer.from(text),
          contentType: 'image/jpeg',
        });
      const first = await put(k, 'first upload');
      const second = await put(k, 'second upload');
      const marker = await h.storage.delete({ bucket: h.buckets.files, key: k });
      await put(`${k}-longer`, 'a key that shares the prefix');
      const versions = await h.storage.listVersions({ bucket: h.buckets.files, key: k });
      expect(versions.map((v) => v.versionId).sort()).toEqual(
        [first.versionId, second.versionId, marker.versionId].sort(),
      );
      expect(versions.filter((v) => v.deleteMarker).map((v) => v.versionId)).toEqual([
        marker.versionId,
      ]);
      for (const v of versions)
        await h.storage.delete({
          bucket: h.buckets.files,
          key: k,
          versionId: v.versionId ?? undefined,
        });
      expect(await h.storage.listVersions({ bucket: h.buckets.files, key: k })).toEqual([]);
      expect(
        await h.storage.listVersions({ bucket: h.buckets.files, key: `${k}-longer` }),
      ).toHaveLength(1);
    });

    it('a write-once object cannot be replaced', async () => {
      const k = key('receipt');
      const original = await writeOnce(k, pdf('original'));
      await expect(writeOnce(k, pdf('forged'))).rejects.toMatchObject({
        name: 'StorageError',
        code: 'already_exists',
      });
      const current = await h.storage.head({ bucket: h.buckets.evidence, key: k });
      expect(current?.versionId).toBe(original.versionId);
      expect(await h.storage.get({ bucket: h.buckets.evidence, key: k })).toEqual(pdf('original'));
      expect(
        await h.storage.get({ bucket: h.buckets.evidence, key: k, versionId: original.versionId }),
      ).toEqual(pdf('original'));
    });

    it('a write-once object carries its Object Lock retention and SHA-256', async () => {
      const k = key('notice');
      const retainUntil = later(120_000);
      const body = pdf('notice');
      const stored = await writeOnce(k, body, retainUntil);
      expect(stored.sha256).toBe(sha256Hex(body));
      const info = await h.storage.head({
        bucket: h.buckets.evidence,
        key: k,
        versionId: stored.versionId,
      });
      expect(info).toMatchObject({
        size: body.length,
        contentType: 'application/pdf',
        versionId: stored.versionId,
        retentionMode: 'GOVERNANCE',
        sha256: stored.sha256,
      });
      // S3 keeps retain-until dates to the second.
      expect(Math.abs((info?.retainUntil?.getTime() ?? 0) - retainUntil.getTime())).toBeLessThan(
        1000,
      );
    });

    it('a write-once object cannot be deleted while it is retained', async () => {
      const k = key('statement');
      const stored = await writeOnce(k, pdf('statement'));
      const ref = { bucket: h.buckets.evidence, key: k, versionId: stored.versionId };
      await expect(h.storage.delete(ref)).rejects.toMatchObject({
        name: 'StorageError',
        code: 'forbidden',
      });
      expect(await h.storage.get(ref)).toEqual(pdf('statement'));
    });

    it('deleting without a version id only adds a delete marker; the locked version stays', async () => {
      const k = key('lease');
      const stored = await writeOnce(k, pdf('lease'));
      const result = await h.storage.delete({ bucket: h.buckets.evidence, key: k });
      expect(result.deleteMarker).toBe(true);
      expect(result.versionId).not.toBe(stored.versionId);
      expect(await h.storage.head({ bucket: h.buckets.evidence, key: k })).toBeNull();
      const ref = { bucket: h.buckets.evidence, key: k, versionId: stored.versionId };
      expect(await h.storage.get(ref)).toEqual(pdf('lease'));
      expect((await h.storage.head(ref))?.retentionMode).toBe('GOVERNANCE');
    });

    it('a version can be deleted once its retention has passed', async () => {
      const k = key('lapsed');
      const stored = await writeOnce(k, pdf('lapsed'), later(3000));
      await h.wait(4500);
      const ref = { bucket: h.buckets.evidence, key: k, versionId: stored.versionId };
      await h.storage.delete(ref);
      expect(await h.storage.head(ref)).toBeNull();
    });

    it('refuses retention in the past and write-once outside the Object Lock bucket', async () => {
      await expect(writeOnce(key('past'), pdf('past'), later(-60_000))).rejects.toMatchObject({
        code: 'invalid_request',
      });
      await expect(
        h.storage.putWriteOnce({
          bucket: h.buckets.files,
          key: key('unlocked'),
          body: pdf('unlocked'),
          contentType: 'application/pdf',
          retainUntil: later(120_000),
          mode: 'GOVERNANCE',
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    });

    it('a presigned upload accepts only the content type and size it was issued for', async () => {
      const k = key('upload');
      const upload = await h.storage.createUploadUrl({
        bucket: h.buckets.files,
        key: k,
        contentType: 'image/png',
        maxBytes: 64,
        expiresInSeconds: 300,
      });
      const ref = { bucket: h.buckets.files, key: k };

      const tooBig = await h.submitUpload(upload, upload.fields, Buffer.alloc(65, 1));
      expect(tooBig).toMatchObject({ status: 400, code: 'EntityTooLarge' });
      const empty = await h.submitUpload(upload, upload.fields, Buffer.alloc(0));
      expect(empty).toMatchObject({ status: 400, code: 'EntityTooSmall' });
      const html = { ...upload.fields, 'Content-Type': 'text/html' };
      expect(await h.submitUpload(upload, html, Buffer.alloc(10, 1))).toMatchObject({
        status: 403,
      });
      const otherKey = { ...upload.fields, key: `${k}-other` };
      expect(await h.submitUpload(upload, otherKey, Buffer.alloc(10, 1))).toMatchObject({
        status: 403,
      });
      expect(await h.storage.head(ref)).toBeNull();
      expect(await h.storage.head({ ...ref, key: `${k}-other` })).toBeNull();

      const ok = await h.submitUpload(upload, upload.fields, Buffer.alloc(64, 7));
      expect(ok.status).toBe(204);
      expect(await h.storage.head(ref)).toMatchObject({ size: 64, contentType: 'image/png' });
      expect(await h.storage.get(ref)).toEqual(Buffer.alloc(64, 7));
    });

    it('a presigned upload expires', async () => {
      const upload = await h.storage.createUploadUrl({
        bucket: h.buckets.files,
        key: key('late-upload'),
        contentType: 'image/png',
        maxBytes: 64,
        expiresInSeconds: 1,
      });
      await h.wait(3000);
      const late = await h.submitUpload(upload, upload.fields, Buffer.alloc(8, 1));
      expect(late.status).toBe(403);
    });

    it('a presigned download serves the exact version under the given filename', async () => {
      const k = key('download');
      const first = await h.storage.put({
        bucket: h.buckets.files,
        key: k,
        body: Buffer.from('version one'),
        contentType: 'application/pdf',
      });
      await h.storage.put({
        bucket: h.buckets.files,
        key: k,
        body: Buffer.from('version two'),
        contentType: 'application/pdf',
      });
      const url = await h.storage.createDownloadUrl({
        bucket: h.buckets.files,
        key: k,
        versionId: first.versionId ?? undefined,
        expiresInSeconds: 300,
        filename: 'Receipt GH₵ "1".pdf',
      });
      const response = await h.download(url);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(Buffer.from('version one'));
      expect(response.contentDisposition).toBe(
        `attachment; filename="Receipt GH_ _1_.pdf"; filename*=UTF-8''Receipt%20GH%E2%82%B5%20%221%22.pdf`,
      );
    });

    it('a presigned download expires', async () => {
      const k = key('late-download');
      await h.storage.put({
        bucket: h.buckets.files,
        key: k,
        body: Buffer.from('soon gone'),
        contentType: 'application/pdf',
      });
      const url = await h.storage.createDownloadUrl({
        bucket: h.buckets.files,
        key: k,
        expiresInSeconds: 1,
      });
      await h.wait(3000);
      expect((await h.download(url)).status).toBe(403);
    });

    it('head is null and get fails for an object that does not exist', async () => {
      const ref = { bucket: h.buckets.files, key: key('missing') };
      expect(await h.storage.head(ref)).toBeNull();
      await expect(h.storage.get(ref)).rejects.toMatchObject({ code: 'not_found' });
    });
  });
}
