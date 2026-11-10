import { eq, schema, sql, withCompany, type Tx } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServerTest, type ServerTestContext } from './support';
import {
  approvedCash,
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import {
  JPEG,
  maintenanceServices,
  putUpload,
  type MaintenanceServices,
} from './support/maintenance';
import { issueReceipts, paymentsServices, type PaymentsServices } from './support/payments';
import { taxServices } from './support/tax';
import {
  propertyWithUnits,
  SAMPLE_PDF,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * M11 decision 6 (M3.md:557): a tenant session reads only its own document and render-request
 * rows. Two tenants of one landlord, each with a paper lease (its scan), a receipt (its PDF and
 * render request) and a repair with files; staff-only files beside them (a cash photo, a staff
 * note's photo, invoices' render requests). Read in each tenant's own session, the database shows
 * each exactly its own lease, receipt and repair documents, and the scan results of those only.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let m: MaintenanceServices;
let p: PaymentsServices;
let today: string;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const system = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId, actorKind: 'system' }, fn);

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  m = maintenanceServices(ctx, s, b, taxServices(ctx, s, b));
  p = paymentsServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
});

afterAll(async () => {
  await ctx?.close();
});

describe('TL-12 AD-02 NFR-SEC a tenant session reads only its own document rows (M11 decision 6)', () => {
  it('★ shows each tenant its own lease, receipt and repair documents and render requests, never the other tenant’s or staff files', async () => {
    const c = await moneyCompany(ctx, s, 'agency', 'Tenant Docs');
    const ownerId = (
      await s.owners.create(c.admin, { kind: 'individual', displayName: 'Tenant Docs owner' })
    ).id;
    const property = await propertyWithUnits(s, c.manager, {
      areaCode: 'ACC',
      propertyPart: 'TDC',
      ownerId,
      units: [{ unitType: 'apartment', count: 2, bedrooms: 2 }],
    });
    const units = Object.values(property.units);
    const start = toIsoDate(addMonths(parseBusinessDate(today), -1));

    /** A tenant with a paper lease, a receipt rendered and a repair with a report photo. */
    const tenantWithFiles = async (name: string, phone: string, unitId: string) => {
      const { tenant } = await s.tenants.create(c.manager, {
        kind: 'individual',
        displayName: name,
        phone,
      });
      const lease = await billedLease(ctx, s, b, c.manager, {
        unitId,
        tenantId: tenant.id,
        startDate: start,
        endDate: plusDays(toIsoDate(addMonths(parseBusinessDate(start), 12)), -1),
        monthlyRentMinor: 100_000,
        cycle: 'monthly',
        signedOn: plusDays(start, -1),
        billingStartDate: start,
      });
      await approvedCash(ctx, s, b, c.manager, c.admin, {
        leaseId: lease.id,
        amountMinor: 50_000,
        receivedOn: today,
      });
      const upload = async () => {
        const u = await m.maintenance.createUpload(c.manager, {
          contentType: 'image/jpeg',
          sizeBytes: JPEG.length,
        });
        return putUpload(ctx, u, 'image/jpeg', JPEG);
      };
      const job = await m.maintenance.logRepair(c.manager, {
        propertyId: property.propertyId,
        unitId,
        description: `${name}'s window`,
        category: 'other',
        priority: 'routine',
        uploadIds: [await upload()],
        messageIds: [],
      });
      // A staff note's photo: staff's own, never the tenant's.
      await m.maintenance.addMedia(c.manager, job.id, {
        stage: 'other',
        uploadIds: [await upload()],
      });
      const [row] = await system(c.companyId, (tx) =>
        tx
          .select({ personId: schema.tenant.personId })
          .from(schema.tenant)
          .where(eq(schema.tenant.id, tenant.id)),
      );
      return { tenantId: tenant.id, personId: row!.personId!, leaseId: lease.id, jobId: job.id };
    };
    const a = await tenantWithFiles('Docs Tenant A', '+233200078001', units[0]!);
    const bee = await tenantWithFiles('Docs Tenant B', '+233200078002', units[1]!);
    // Receipts are rendered as the worker would (a fixed PDF stands in for Chromium's).
    await issueReceipts(ctx, p, c.companyId);
    const pending = await system(c.companyId, (tx) =>
      tx
        .select({ id: schema.documentRenderRequest.id })
        .from(schema.documentRenderRequest)
        .where(eq(schema.documentRenderRequest.status, 'pending')),
    );
    for (const r of pending)
      await s.documents.renderRequested(c.companyId, r.id, async () => SAMPLE_PDF);

    /** What each tenant should see: its lease scan, its receipts' PDFs and requests, its report file. */
    const expected = async (t: typeof a) =>
      system(c.companyId, async (tx) => {
        const lease = await tx.execute<{ id: string }>(
          sql`select signed_document_id as id from lease where id = ${t.leaseId}`,
        );
        const receipts = await tx.execute<{ request: string; document: string | null }>(
          sql`select q.id as request, q.document_id as document from receipt r
              join document_render_request q on q.company_id = r.company_id and q.id = r.render_request_id
              where r.lease_id = ${t.leaseId}`,
        );
        const repair = await tx.execute<{ id: string }>(
          sql`select document_id as id from maintenance_job_attachment
              where job_id = ${t.jobId} and stage in ('report', 'before', 'after')`,
        );
        return {
          documents: [
            ...lease.rows.map((r) => r.id),
            ...receipts.rows.map((r) => r.document!),
            ...repair.rows.map((r) => r.id),
          ].sort(),
          requests: receipts.rows.map((r) => r.request).sort(),
        };
      });
    const seenBy = async (t: typeof a) =>
      withCompany(
        ctx.database,
        {
          companyId: c.companyId,
          personId: t.personId,
          actorKind: 'tenant',
          tenantScope: { tenantIds: [t.tenantId] },
        },
        async (tx) => ({
          documents: (
            await tx.execute<{ id: string }>(sql`select id from document order by id`)
          ).rows
            .map((r) => r.id)
            .sort(),
          requests: (
            await tx.execute<{ id: string }>(
              sql`select id from document_render_request order by id`,
            )
          ).rows
            .map((r) => r.id)
            .sort(),
          scans: (
            await tx.execute<{ id: string }>(sql`select document_id as id from document_scan`)
          ).rows
            .map((r) => r.id)
            .sort(),
        }),
      );

    const all = await system(c.companyId, (tx) =>
      tx.execute<{ n: number; kinds: string[] }>(
        sql`select count(*)::int as n, array_agg(distinct kind) as kinds from document`,
      ),
    );
    // Staff files are there to be hidden: cash photos and the staff notes' photos among them.
    expect(all.rows[0]!.kinds).toEqual(expect.arrayContaining(['cash_photo', 'lease_scan']));
    for (const [me, other] of [
      [a, bee],
      [bee, a],
    ] as const) {
      const mine = await expected(me);
      const theirs = await expected(other);
      expect(mine.documents).toHaveLength(3);
      expect(mine.requests).toHaveLength(1);
      const seen = await seenBy(me);
      expect(seen.documents).toEqual(mine.documents);
      expect(seen.requests).toEqual(mine.requests);
      expect(seen.scans).toEqual(mine.documents);
      for (const id of [...theirs.documents, ...theirs.requests])
        expect([...seen.documents, ...seen.requests]).not.toContain(id);
    }
    expect(all.rows[0]!.n).toBeGreaterThan(6);
  });
});
