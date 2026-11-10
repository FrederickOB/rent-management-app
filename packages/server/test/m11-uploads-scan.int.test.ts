import { createServer, type AddressInfo } from 'node:net';
import { eq, schema, sql, withCompany, type Tx } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { ClamAvScanner, EICAR_TEST_FILE, FakeMalwareScanner } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentsService, UPLOADS_SCAN_JOB } from '../src/documents/documents.service';
import { registerMaintenanceRecipients } from '../src/messaging/maintenance-recipients';
import { RulesService } from '../src/rules/rules.service';
import { DocumentScansService } from '../src/tenancy/document-scans.service';
import { startServerTest, type ServerTestContext } from './support';
import { billingServices, moneyCompany, type BillingServices } from './support/billing';
import {
  JPEG,
  MP4,
  maintenanceServices,
  outboxOf,
  putUpload,
  type MaintenanceServices,
} from './support/maintenance';
import { taxServices } from './support/tax';
import {
  deliverMessages,
  propertyWithUnits,
  SAMPLE_PDF,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

/**
 * M11 decision 6 against the real database: every upload is scanned before anyone but its uploader
 * may open it. `s` scans as uploads are staged (the fake scanner); `p` works while the scanner is
 * down (clamd on a closed port), so its uploads stay pending until the worker's job scans them,
 * which `worker` does here with the fake.
 */
let ctx: ServerTestContext;
let pendingCtx: ServerTestContext;
let s: TenancyServices;
let p: TenancyServices;
let pb: BillingServices;
let pm: MaintenanceServices;
let worker: DocumentsService;
let scans: DocumentScansService;
let today: string;
let seq = 0;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const phone = () => `+2332009${String((seq += 1)).padStart(5, '0')}`;
const system = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId, actorKind: 'system' }, fn);
/**
 * A PDF with the EICAR test string in one of its streams: the fake scanner reports it, and so does
 * ClamAV, which unpacks the stream (it finds the bare string only at the start of a file).
 */
const INFECTED_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n' +
    `3 0 obj<</Length ${EICAR_TEST_FILE.length}>>stream\n${EICAR_TEST_FILE}\nendstream\nendobj\n` +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

/** The real clamd (`docker compose --profile scan up -d clamav`), when it is running. */
const CLAMD = {
  host: process.env.CLAMAV_HOST ?? 'localhost',
  port: Number(process.env.CLAMAV_PORT ?? 3310),
};
const clamdUp = await new ClamAvScanner(CLAMD).ping();
if (!clamdUp) console.info('clamd is not reachable: the real ClamAV upload tests are skipped');

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

/** A company with an owner, units, a tenant who can sign in, and a manager and an admin. */
async function landlord(services: TenancyServices, name: string, part: string) {
  const c = await moneyCompany(ctx, services, 'agency', name);
  const ownerId = (
    await services.owners.create(c.admin, { kind: 'individual', displayName: `${name} owner` })
  ).id;
  const property = await propertyWithUnits(services, c.manager, {
    areaCode: 'ACC',
    propertyPart: part,
    ownerId,
    units: [{ unitType: 'apartment', count: 3, bedrooms: 2 }],
  });
  return { ...c, ownerId, propertyId: property.propertyId, units: Object.values(property.units) };
}

/** A paper lease with its scan, uploaded by the manager; the tenant as the tenant app sees them. */
async function paperLease(
  services: TenancyServices,
  c: Awaited<ReturnType<typeof landlord>>,
  unitId: string,
  scan: Buffer = SAMPLE_PDF,
) {
  const { tenant } = await services.tenants.create(c.manager, {
    kind: 'individual',
    displayName: `Scan tenant ${seq}`,
    phone: phone(),
  });
  const start = toIsoDate(addMonths(parseBusinessDate(today), -1));
  const lease = await services.leases.recordPaper(c.manager, {
    unitId,
    tenantId: tenant.id,
    startDate: start,
    endDate: plusDays(toIsoDate(addMonths(parseBusinessDate(start), 12)), -1),
    monthlyRentMinor: 100_000,
    cycle: 'monthly',
    noticeDays: 30,
    signedOn: plusDays(start, -1),
    parties: [{ role: 'tenant', name: 'Tenant' }],
    scanUploadId: await uploadLeaseFile(ctx, services, c.manager, scan),
  });
  const [row] = await system(c.companyId, (tx) =>
    tx
      .select({ personId: schema.tenant.personId })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, tenant.id)),
  );
  const [leaseRow] = await system(c.companyId, (tx) =>
    tx
      .select({ documentId: schema.lease.signedDocumentId })
      .from(schema.lease)
      .where(eq(schema.lease.id, lease.id)),
  );
  return {
    leaseId: lease.id,
    documentId: leaseRow!.documentId!,
    tenant: { kind: 'tenant' as const, personId: row!.personId!, authMethod: 'phone_otp' as const },
  };
}

async function scanRow(companyId: string, documentId: string) {
  const [row] = await system(companyId, (tx) =>
    tx.select().from(schema.documentScan).where(eq(schema.documentScan.documentId, documentId)),
  );
  return row ?? null;
}

beforeAll(async () => {
  ctx = await startServerTest();
  pendingCtx = {
    ...ctx,
    config: {
      ...ctx.config,
      MALWARE_SCANNER: 'clamav',
      CLAMAV_HOST: '127.0.0.1',
      CLAMAV_PORT: await closedPort(),
    },
  };
  s = tenancyServices(ctx);
  p = tenancyServices(pendingCtx);
  pb = billingServices(pendingCtx, p);
  pm = maintenanceServices(pendingCtx, p, pb, taxServices(pendingCtx, p, pb));
  worker = new DocumentsService(
    ctx.database,
    ctx.storage,
    ctx.config,
    ctx.clock,
    ctx.audit,
    new RulesService(ctx.database),
    new FakeMalwareScanner(),
  );
  scans = new DocumentScansService(ctx.database, s.policy, s.documents);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
});

afterAll(async () => {
  await ctx?.close();
});

describe('NFR-SEC an upload is served once scanned clean, and before that only to its uploader (M11 decision 6)', () => {
  it('★ a lease scan recorded while the scanner is down stays pending: 409 to others, open to its uploader, served once the job scans it', async () => {
    const c = await landlord(p, 'Scan Pending', 'SCP');
    const lease = await paperLease(p, c, c.units[0]!);
    expect(await scanRow(c.companyId, lease.documentId)).toBeNull();
    // The scan job was queued in the transaction that recorded the document, keyed by it.
    const queued = await outboxOf(ctx, c.companyId, UPLOADS_SCAN_JOB);
    expect(queued.map((e) => e.idempotencyKey)).toContain(
      `${UPLOADS_SCAN_JOB}:${lease.documentId}`,
    );

    // Pending: the admin and the tenant are refused; the manager who uploaded it may open it.
    await expect(p.leases.fileUrl(c.admin, lease.leaseId, 'signed')).rejects.toMatchObject({
      status: 409,
      code: 'document_scan_pending',
    });
    await expect(p.tenantApp.documentUrl(lease.tenant, lease.documentId)).rejects.toMatchObject({
      status: 409,
      code: 'document_scan_pending',
    });
    const own = await p.leases.fileUrl(c.manager, lease.leaseId, 'signed');
    expect((await ctx.storage.openDownload(own)).status).toBe(200);
    expect(await scans.status(c.manager, lease.documentId)).toMatchObject({
      status: 'pending',
      scannedAt: null,
    });

    // The worker's job scans it once; a second run changes nothing.
    expect(await worker.scanUpload(c.companyId, lease.documentId)).toMatchObject({
      status: 'clean',
      engine: 'fake',
      scanned: true,
    });
    expect(await worker.scanUpload(c.companyId, lease.documentId)).toMatchObject({
      status: 'clean',
      scanned: false,
    });
    const served = await p.leases.fileUrl(c.admin, lease.leaseId, 'signed');
    const download = await ctx.storage.openDownload(served);
    expect(download.status).toBe(200);
    expect(download.body.equals(SAMPLE_PDF)).toBe(true);
    // Review R3 F5: an upload is an attachment, never inline, and never cached.
    expect(download.contentDisposition).toMatch(/^attachment; filename="lease_scan\.pdf"/);
    expect(download.cacheControl).toBe('no-store');
    expect(await p.tenantApp.documentUrl(lease.tenant, lease.documentId)).toMatch(/^memory:/);
    expect(await scans.status(lease.tenant, lease.documentId)).toMatchObject({
      status: 'clean',
      scannedAt: expect.any(Date),
    });
  });

  it('★ an infected upload is quarantined: kept, and never served to anyone, its uploader included', async () => {
    const c = await landlord(s, 'Scan Infected', 'SCI');
    const lease = await paperLease(s, c, c.units[0]!, INFECTED_PDF);
    // Scanned as it was staged: recorded infected with the lease, in the same transaction.
    expect(await scanRow(c.companyId, lease.documentId)).toMatchObject({
      status: 'infected',
      engine: 'fake',
      finding: 'Eicar-Test-Signature',
    });
    for (const who of [c.manager, c.admin])
      await expect(s.leases.fileUrl(who, lease.leaseId, 'signed')).rejects.toMatchObject({
        status: 410,
        code: 'document_quarantined',
      });
    await expect(s.tenantApp.documentUrl(lease.tenant, lease.documentId)).rejects.toMatchObject({
      status: 410,
    });
    await expect(s.documents.documentFile(c.companyId, lease.documentId)).rejects.toMatchObject({
      status: 410,
    });
    expect(await scans.status(c.manager, lease.documentId)).toMatchObject({ status: 'infected' });
    // Kept: the document and its stored copy are still there (quarantine, not deletion).
    const [doc] = await system(c.companyId, (tx) =>
      tx.select().from(schema.document).where(eq(schema.document.id, lease.documentId)),
    );
    expect(doc).toBeTruthy();
    expect(
      await ctx.storage.head({
        bucket: doc!.bucket,
        key: doc!.storageKey,
        versionId: doc!.storageVersionId!,
      }),
    ).not.toBeNull();
    // The job still runs for it (its alert is raised there), and scans nothing again.
    expect(await worker.scanUpload(c.companyId, lease.documentId)).toMatchObject({
      status: 'infected',
      kind: 'lease_scan',
      scanned: false,
    });
  });

  it('a document we generate is clean as it is stored, and may be shown inline', async () => {
    const c = await landlord(s, 'Scan Generated', 'SCG');
    const file = await s.documents.storeWriteOnce({
      companyId: c.companyId,
      countryCode: 'GH',
      key: `documents/${c.companyId}/generated-${seq}.pdf`,
      bytes: SAMPLE_PDF,
      contentType: 'application/pdf',
    });
    const documentId = await system(c.companyId, (tx) =>
      s.documents.recordWriteOnce(tx, file, { kind: 'pdf' }),
    );
    expect(await scanRow(c.companyId, documentId)).toMatchObject({
      status: 'clean',
      engine: 'generated',
      finding: null,
    });
    expect(
      (await outboxOf(ctx, c.companyId, UPLOADS_SCAN_JOB)).map((e) => e.idempotencyKey),
    ).not.toContain(`${UPLOADS_SCAN_JOB}:${documentId}`);
    const url = await s.documents.downloadUrl(c.companyId, documentId);
    const download = await ctx.storage.openDownload(url!);
    expect(download).toMatchObject({
      status: 200,
      contentDisposition: null,
      cacheControl: 'no-store',
    });
  });

  it('a scan status is for its uploader and those who may see the document, never another company or tenant', async () => {
    const c = await landlord(s, 'Scan Status', 'SCS');
    const mine = await paperLease(s, c, c.units[0]!);
    const theirs = await paperLease(s, c, c.units[1]!);
    expect(await scans.status(c.admin, mine.documentId)).toMatchObject({ status: 'clean' });
    expect(await scans.status(mine.tenant, mine.documentId)).toMatchObject({ status: 'clean' });
    // Another tenant of the same landlord, and staff of another company, see nothing.
    await expect(scans.status(theirs.tenant, mine.documentId)).rejects.toMatchObject({
      status: 404,
    });
    const other = await landlord(s, 'Scan Status Other', 'SCO');
    await expect(scans.status(other.admin, mine.documentId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(scans.status(null, mine.documentId)).rejects.toMatchObject({ status: 401 });
  });
});

describe('MI-04 NFR-SEC the job sheet serves a report file only once it is scanned clean (M11 decision 6)', () => {
  it('★ lists a pending photo as being checked with nothing to open, serves it once clean, and never lists or serves an infected one', async () => {
    const c = await landlord(p, 'Scan Sheet', 'SCJ');
    const upload = async (contentType: string, body: Buffer) => {
      const u = await pm.maintenance.createUpload(c.manager, {
        contentType,
        sizeBytes: body.length,
        ...(contentType.startsWith('video') ? { durationSeconds: 10 } : {}),
      });
      return putUpload(ctx, u, contentType, body);
    };
    // The fake finds the test string anywhere (ClamAV would want it unpacked or at the start).
    const infectedVideo = Buffer.concat([MP4, Buffer.from(EICAR_TEST_FILE, 'latin1')]);
    const job = await pm.maintenance.logRepair(c.manager, {
      propertyId: c.propertyId,
      unitId: c.units[0]!,
      description: 'Water through the ceiling',
      category: 'plumbing',
      priority: 'routine',
      uploadIds: [await upload('image/jpeg', JPEG), await upload('video/mp4', infectedVideo)],
      messageIds: [],
    });
    const artisan = await pm.artisans.create(c.manager, {
      name: 'Scan Plumber',
      phone: '0244555666',
      trades: ['plumbing'],
      consent: { whatsapp: false, sms: true },
    });
    await pm.maintenance.assign(c.manager, job.id, {
      assignee: { kind: 'artisan', artisanId: artisan.id },
    });
    registerMaintenanceRecipients(p.messaging, pm.artisans, pm.sheets);
    await deliverMessages(pendingCtx, p, c.companyId);
    const text = p.sms.sent.filter((x) => x.to === '+233244555666').at(-1)!.body;
    const token = /\/j\/([A-Za-z0-9_-]{43})/.exec(text)![1]!;
    const who = { ip: '203.0.113.77', userAgent: 'test' };

    const opened = await pm.sheets.open(token, who);
    expect(opened.attachments.map((a) => [a.kind, a.scan]).sort()).toEqual([
      ['image', 'pending'],
      ['video', 'pending'],
    ]);
    const photo = opened.attachments.find((a) => a.kind === 'image')!;
    const video = opened.attachments.find((a) => a.kind === 'video')!;
    await expect(pm.sheets.attachmentUrl(token, who, photo.id)).rejects.toMatchObject({
      status: 409,
      code: 'document_scan_pending',
    });

    // The worker scans both: the photo is clean, the video infected.
    const documents = await system(c.companyId, (tx) =>
      tx
        .select({ id: schema.maintenanceJobAttachment.documentId })
        .from(schema.maintenanceJobAttachment)
        .where(eq(schema.maintenanceJobAttachment.jobId, job.id)),
    );
    const outcomes = [];
    for (const d of documents) outcomes.push((await worker.scanUpload(c.companyId, d.id))!.status);
    expect(outcomes.sort()).toEqual(['clean', 'infected']);

    const after = await pm.sheets.open(token, who);
    expect(after.attachments.map((a) => [a.id, a.scan])).toEqual([[photo.id, 'clean']]);
    const { url } = await pm.sheets.attachmentUrl(token, who, photo.id);
    const download = await ctx.storage.openDownload(url);
    expect(download.status).toBe(200);
    expect(download.contentDisposition).toMatch(/^attachment;/);
    await expect(pm.sheets.attachmentUrl(token, who, video.id)).rejects.toMatchObject({
      status: 410,
      code: 'document_quarantined',
    });
    // The staff app refuses the quarantined video too, its uploader included.
    await expect(
      pm.maintenance.attachmentDownload(c.manager, job.id, video.id),
    ).rejects.toMatchObject({ status: 410 });
    const scanned = await system(c.companyId, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from document_scan where status = 'infected'`,
      ),
    );
    expect(scanned.rows[0]!.n).toBe(1);
  });
});

describe.skipIf(!clamdUp)(
  'NFR-SEC the real ClamAV quarantines the EICAR test file and passes a clean upload (M11 decision 6)',
  () => {
    it('★ scans uploads as they are staged and in the job, with ClamAV as the engine', async () => {
      const clamCtx: ServerTestContext = {
        ...ctx,
        config: {
          ...ctx.config,
          MALWARE_SCANNER: 'clamav',
          CLAMAV_HOST: CLAMD.host,
          CLAMAV_PORT: CLAMD.port,
        },
      };
      const cs = tenancyServices(clamCtx);
      const c = await landlord(cs, 'Scan ClamAV', 'SCV');
      const infected = await paperLease(cs, c, c.units[0]!, INFECTED_PDF);
      expect(await scanRow(c.companyId, infected.documentId)).toMatchObject({
        status: 'infected',
        engine: 'clamav',
        finding: expect.stringMatching(/eicar/i),
      });
      await expect(cs.leases.fileUrl(c.manager, infected.leaseId, 'signed')).rejects.toMatchObject({
        status: 410,
        code: 'document_quarantined',
      });
      const clean = await paperLease(cs, c, c.units[1]!);
      expect(await scanRow(c.companyId, clean.documentId)).toMatchObject({
        status: 'clean',
        engine: 'clamav',
      });
      expect(await cs.leases.fileUrl(c.admin, clean.leaseId, 'signed')).toMatch(/^memory:/);

      // The job, with ClamAV, scans an upload recorded while the scanner was down.
      const pendingCompany = await landlord(p, 'Scan ClamAV Job', 'SCW');
      const later = await paperLease(p, pendingCompany, pendingCompany.units[0]!, INFECTED_PDF);
      const clamWorker = new DocumentsService(
        ctx.database,
        ctx.storage,
        clamCtx.config,
        ctx.clock,
        ctx.audit,
        new RulesService(ctx.database),
      );
      expect(await clamWorker.scanUpload(pendingCompany.companyId, later.documentId)).toMatchObject(
        {
          status: 'infected',
          engine: 'clamav',
          scanned: true,
        },
      );
      await expect(p.tenantApp.documentUrl(later.tenant, later.documentId)).rejects.toMatchObject({
        status: 410,
      });
    });
  },
);
