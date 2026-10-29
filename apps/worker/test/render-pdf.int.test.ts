import { randomUUID } from 'node:crypto';
import {
  createDatabase,
  eq,
  schema,
  sql,
  withCompany,
  withSystem,
  type Database,
  type Tx,
} from '@rent/db';
import { cloneTemplateDatabase, type TestDatabase } from '@rent/db/testing';
import { verifyFingerprint } from '@rent/documents';
import { InMemoryAlert, S3Storage } from '@rent/integrations';
import { AuditService } from '@rent/server/audit';
import { createLogger, loadConfig, systemClock, type AppConfig } from '@rent/server/core';
import { DocumentsService } from '@rent/server/documents';
import type { JobContext } from '@rent/server/jobs';
import { RulesService } from '@rent/server/rules';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { closeRenderer, renderPdfJob } from '../src/render-pdf.job';

let db: TestDatabase;
let database: Database;
let config: AppConfig;
let storage: S3Storage;
let documents: DocumentsService;
let audit: AuditService;
let companyId: string;
const evidenceBucket = `rent-test-evidence-${randomUUID().slice(0, 8)}`;

function contextFor(id: string): JobContext {
  const scoped = <R>(fn: (tx: Tx) => Promise<R>) =>
    withCompany(database, { companyId: id, actorKind: 'system' }, fn);
  return {
    jobId: 'test-job',
    logger: createLogger({ level: 'silent' }),
    companyId: id,
    withCompany: scoped,
    once: () => Promise.resolve(true),
    enqueue: () => Promise.resolve(),
  };
}

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  config = {
    ...loadConfig({ ...process.env, DATABASE_URL: db.appUrl, FAKE_PROVIDERS_URL: undefined }),
    S3_BUCKET_EVIDENCE: evidenceBucket,
  };
  database = createDatabase(db.appUrl, { max: 4 });
  storage = new S3Storage({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID!,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
    },
  });
  await storage.ensureBuckets({ files: config.S3_BUCKET_FILES, evidence: evidenceBucket });
  audit = new AuditService(database, storage, systemClock);
  documents = new DocumentsService(
    database,
    storage,
    config,
    systemClock,
    audit,
    new RulesService(database),
  );
  companyId = await withSystem(database, {}, async (tx) => {
    const result = await tx.execute<{ id: string }>(
      sql`select app.create_company(null, 'landlord', 'PDF Landlord', 'PDF Landlord', 'GH', 'Africa/Accra', 'PDF Landlord', '{}'::jsonb) as id`,
    );
    return result.rows[0]!.id;
  });
});

afterAll(async () => {
  await closeRenderer();
  await database?.close();
  await db?.drop();
});

describe('PLATFORM documents (worker)', () => {
  it('renders a requested template, stores it write-once with the retention rule, and records its fingerprint', async () => {
    const requestId = await withCompany(database, { companyId, actorKind: 'system' }, (tx) =>
      documents.requestRender(tx, {
        companyId,
        templateKey: 'system.sample',
        templateVersion: 1,
        data: {
          title: 'Sample',
          recipientName: 'Ama Tenant (demo)',
          reference: 'TEST-001',
          amountMinor: 150_000,
          currency: 'GHS',
          issuedAt: '2026-10-28T14:05:00.000Z',
          timeZone: 'Africa/Accra',
        },
      }),
    );
    const job = renderPdfJob({
      database,
      config,
      clock: systemClock,
      alerts: new InMemoryAlert(),
      audit,
      approvals: undefined as never,
      documents,
      storage,
    });
    await job.handle({ companyId, renderRequestId: requestId }, contextFor(companyId));

    const [request] = await withCompany(database, { companyId, actorKind: 'system' }, (tx) =>
      tx
        .select()
        .from(schema.documentRenderRequest)
        .where(eq(schema.documentRenderRequest.id, requestId)),
    );
    expect(request!.status).toBe('rendered');
    const [doc] = await withCompany(database, { companyId, actorKind: 'system' }, (tx) =>
      tx.select().from(schema.document).where(eq(schema.document.id, request!.documentId!)),
    );
    expect(doc).toMatchObject({
      kind: 'pdf',
      writeOnce: true,
      retentionMode: 'GOVERNANCE',
      templateKey: 'system.sample',
      templateVersion: 1,
    });
    expect(doc!.retainUntil!.getUTCFullYear()).toBe(new Date().getUTCFullYear() + 6);

    const bytes = await storage.get({
      bucket: evidenceBucket,
      key: doc!.storageKey,
      versionId: doc!.storageVersionId ?? undefined,
    });
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    expect(verifyFingerprint(bytes, doc!.sha256)).toBe(true);
    const altered = Buffer.from(bytes);
    altered[altered.length - 10] = altered[altered.length - 10]! ^ 0xff;
    expect(verifyFingerprint(altered, doc!.sha256)).toBe(false);

    const head = await storage.head({ bucket: evidenceBucket, key: doc!.storageKey });
    expect(head?.retentionMode).toBe('GOVERNANCE');
    await expect(
      storage.delete({
        bucket: evidenceBucket,
        key: doc!.storageKey,
        versionId: doc!.storageVersionId ?? undefined,
      }),
    ).rejects.toThrow();

    // A retry after success changes nothing.
    await job.handle({ companyId, renderRequestId: requestId }, contextFor(companyId));
    const docs = await withCompany(database, { companyId, actorKind: 'system' }, (tx) =>
      tx.select().from(schema.document),
    );
    expect(docs).toHaveLength(1);
  });
});
