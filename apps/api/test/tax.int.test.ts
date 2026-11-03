import { schema, sql, withCompany } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { InvoicingService } from '@rent/server/billing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  createCompany,
  createPerson,
  enrolStaff,
  startApi,
  type Device,
  type TestApi,
} from './support';

/**
 * Every M5 endpoint over HTTP, through the contracts' output validation (M5 plan 5.8; the web's
 * e2e run found two that answered 500 "Output validation failed"): rent tax, GRA and VAT
 * payments, withholding and certificates, early termination, advance rent and paid-until.
 */
const PASSWORD = 'correct horse battery staple';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

let api: TestApi;
let agencyId: string;
let admin: Device;
let manager: Device;
let accountant: Device;
let today: string;
let ownerA: string;
let ownerVat: string;
let residential: { id: string; code: string }[];
let shops: { id: string; code: string }[];
let keyCount = 0;
const day = (n: number) => toIsoDate(addDays(parseBusinessDate(today), n));
const months = (n: number, from = today) => toIsoDate(addMonths(parseBusinessDate(from), n));
const endAfter = (from: string, n: number) =>
  toIsoDate(addDays(addMonths(parseBusinessDate(from), n), -1));
const key = () => ({ 'idempotency-key': `m5-http-${String((keyCount += 1)).padStart(6, '0')}` });

async function signedIn(email: string, role: 'agency_admin' | 'property_manager' | 'accountant') {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, agencyId, personId, role);
  return (await enrolStaff(api, email, PASSWORD)).device;
}

async function ok(response: { status: number; json: Record<string, unknown> }) {
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json;
}

async function upload(device: Device, path: string, body: Record<string, unknown> = {}) {
  const response = await ok(
    await device.call(path, {
      body: { contentType: 'application/pdf', sizeBytes: PDF.length, ...body },
    }),
  );
  const fields = response.fields as Record<string, string>;
  await api.storage.put({
    bucket: api.config.S3_BUCKET_FILES,
    key: fields.key!,
    body: PDF,
    contentType: 'application/pdf',
  });
  return String(response.uploadId);
}

async function paperLease(input: {
  unitId: string;
  start: string;
  months?: number;
  rent?: number;
  cycle?: 'monthly' | 'annual';
  use?: 'residential' | 'commercial';
  breakCredit?: boolean;
}) {
  const tenant = await ok(
    await manager.call('/tenants', {
      body: { kind: 'company', displayName: `Tenant ${input.unitId.slice(-4)}` },
    }),
  );
  const lease = await ok(
    await manager.call('/leases/paper', {
      body: {
        unitId: input.unitId,
        tenantId: (tenant.tenant as { id: string }).id,
        startDate: input.start,
        endDate: endAfter(input.start, input.months ?? 12),
        monthlyRentMinor: input.rent ?? 100_000,
        cycle: input.cycle ?? 'monthly',
        noticeDays: 30,
        use: input.use ?? 'residential',
        parties: [{ role: 'tenant', name: 'Tenant' }],
        scanUploadId: await upload(manager, '/lease-uploads'),
        signedOn: input.start < today ? day(-100) : today,
        ...(input.start < today ? { billingStartDate: input.start } : {}),
        ...(input.breakCredit !== undefined
          ? {
              breakClause: {
                fromDate: months(1, input.start),
                party: 'tenant',
                noticeDays: 30,
                creditUnusedDays: input.breakCredit,
              },
            }
          : {}),
      },
    }),
  );
  const leaseId = String(lease.id);
  await api.app.get(InvoicingService).onLeaseSigned(agencyId, leaseId);
  await api.app.get(InvoicingService).accrueAll(agencyId, today);
  return leaseId;
}

/** A transfer into the owner's account, approved by a second person, as the web records one. */
async function transfer(leaseId: string, amountMinor: number, receivedOn = today) {
  const recorded = await ok(
    await manager.call('/direct-receipts', {
      headers: key(),
      body: {
        leaseId,
        receivedInto: 'agency_account',
        amountMinor,
        receivedOn,
        senderReference: 'HTTP TEST',
        proofUploadId: await upload(manager, '/payment-uploads', { purpose: 'transfer_proof' }),
      },
    }),
  );
  await ok(
    await admin.call(`/approvals/${(recorded.approval as { id: string }).id}/decisions`, {
      body: { decision: 'approve' },
    }),
  );
}

async function rentLines(leaseId: string) {
  return withCompany(api.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
    tx
      .select({ id: schema.invoiceLine.id })
      .from(schema.invoiceLine)
      .where(sql`lease_id = ${leaseId} and kind = 'rent'`)
      .orderBy(schema.invoiceLine.periodStart),
  );
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  today = toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
  agencyId = await createCompany(api, 'agency', 'Tax API Agency');
  admin = await signedIn('admin@tax.invalid', 'agency_admin');
  manager = await signedIn('manager@tax.invalid', 'property_manager');
  accountant = await signedIn('accountant@tax.invalid', 'accountant');
  ownerA = String(
    (
      await ok(
        await admin.call('/owners', { body: { kind: 'individual', displayName: 'Owner A' } }),
      )
    ).id,
  );
  ownerVat = String(
    (
      await ok(
        await admin.call('/owners', {
          body: {
            kind: 'company',
            displayName: 'Owner VAT',
            legalName: 'Owner VAT Limited',
            vatRegistered: true,
            tin: 'C0012345678',
          },
        }),
      )
    ).id,
  );
  const property = async (part: string, ownerId: string, use: string, unitType: string) => {
    const created = await ok(
      await manager.call('/properties', {
        body: {
          areaCode: 'ACC',
          propertyPart: part,
          name: part,
          propertyType: use === 'commercial' ? 'shop' : 'compound_house',
          use,
          ownerId,
          address: { region: 'Greater Accra', town: 'Accra' },
          units: [{ unitType, count: 8 }],
        },
      }),
    );
    return (created.blocks as { units: { id: string; code: string }[] }[])[0]!.units;
  };
  residential = await property('LEG', ownerA, 'residential', 'single_room');
  shops = await property('OSU', ownerVat, 'commercial', 'shop');
});

afterAll(async () => {
  await api?.close();
});

describe('TX-03 rent tax endpoints over HTTP', () => {
  it('answers the report, items, due list, CSV and PDF, and records a GRA payment as the web sends it', async () => {
    const leaseId = await paperLease({ unitId: residential[0]!.id, start: months(-2) });
    await transfer(leaseId, 200_000, day(-20));
    const query = `ownerId=${ownerA}&from=${months(-4)}&to=${today}`;
    const report = await ok(await accountant.call(`/rent-tax/report?${query}`));
    expect((report.items as unknown[]).length).toBe(1);
    expect(report.totals).toMatchObject({ taxMinor: 16_000, outstandingMinor: 16_000 });
    await ok(await accountant.call(`/rent-tax/items?leaseId=${leaseId}`));
    const due = await ok(await accountant.call(`/rent-tax/due?ownerId=${ownerA}`));
    expect((due as unknown as { outstandingMinor: number }[])[0]!.outstandingMinor).toBe(16_000);
    const csv = await ok(await accountant.call(`/rent-tax/report/csv?${query}`));
    expect(String(csv.content)).toContain('"Tax (GHS)"');
    const pdf = await ok(
      await accountant.call('/rent-tax/report/pdf', {
        body: { ownerId: ownerA, from: months(-4), to: today },
      }),
    );
    const status = await ok(
      await accountant.call(`/rent-tax/report/pdf/${String(pdf.renderRequestId)}`),
    );
    expect(status.status).toBe('rendering');

    // As the web records it: GRA's receipt uploaded, then the payment with a key.
    const receiptUploadId = await upload(accountant, '/tax-uploads', { purpose: 'gra_receipt' });
    const paid = await ok(
      await accountant.call('/gra-payments', {
        headers: key(),
        body: {
          ownerId: ownerA,
          paidOn: today,
          amountMinor: 16_000,
          graReceiptNumber: 'GRA-HTTP-1',
          receiptUploadId,
          paidFrom: 'agency_account',
          items: null,
          note: null,
        },
      }),
    );
    expect(paid).toMatchObject({ amountMinor: 16_000, graReceiptNumber: 'GRA-HTTP-1' });
    expect((paid.items as unknown[]).length).toBe(1);
    const list = await ok(await accountant.call(`/gra-payments?ownerId=${ownerA}`));
    expect((list as unknown as unknown[]).length).toBe(1);
    // The report with a GRA payment in it validates too (it answered 500 before).
    const after = await ok(await accountant.call(`/rent-tax/report?${query}`));
    expect((after.graPayments as unknown[]).length).toBe(1);
    await ok(await accountant.call(`/tax-files/${String(paid.receiptDocumentId)}/download`));
  });
});

describe('P33 VAT endpoints over HTTP', () => {
  it('answers the VAT report and records a VAT payment as the web sends it', async () => {
    const start = `${today.slice(0, 7)}-01`;
    const leaseId = await paperLease({
      unitId: shops[0]!.id,
      start,
      rent: 1_000_000,
      use: 'commercial',
    });
    await transfer(leaseId, 1_200_000);
    const report = await ok(
      await accountant.call(`/vat/report?ownerId=${ownerVat}&month=${today.slice(0, 7)}`),
    );
    expect(report.totals).toMatchObject({ totalMinor: 200_000, outstandingMinor: 200_000 });
    const paid = await ok(
      await accountant.call('/vat-payments', {
        headers: key(),
        body: {
          ownerId: ownerVat,
          periodMonth: today.slice(0, 7),
          paidOn: today,
          amountMinor: 1_234,
          graReceiptNumber: 'GRA-VAT-HTTP-1',
          receiptUploadId: await upload(accountant, '/tax-uploads', { purpose: 'gra_receipt' }),
          paidFrom: 'agency_account',
          note: null,
        },
      }),
    );
    expect(paid).toMatchObject({ amountMinor: 1_234, periodMonth: start });
    await ok(await accountant.call(`/vat-payments?ownerId=${ownerVat}`));
  });
});

describe('TX-04 withholding endpoints over HTTP', () => {
  it('answers the options, records withholding and a certificate, and refuses its uploader with 403', async () => {
    const start = `${today.slice(0, 7)}-01`;
    const leaseId = await paperLease({
      unitId: shops[1]!.id,
      start,
      rent: 1_000_000,
      use: 'commercial',
    });
    const options = await ok(await manager.call(`/leases/${leaseId}/withholding-options`));
    expect(options.rate).toMatchObject({ bps: 1500, warning: true });
    const [line] = await rentLines(leaseId);
    const recorded = await ok(
      await manager.call('/withholding', {
        headers: key(),
        body: { leaseId, valueDate: today, lines: [{ lineId: line!.id, amountMinor: 150_000 }] },
      }),
    );
    const withholdingId = String(recorded.id);
    const uploaded = await ok(
      await manager.call(`/withholding/${withholdingId}/certificates`, {
        headers: key(),
        body: {
          withholdingId,
          uploadId: await upload(manager, '/tax-uploads', { purpose: 'withholding_certificate' }),
          certificateNumber: 'WHT-HTTP-1',
        },
      }),
    );
    const certificateId = (uploaded.certificate as { id: string }).id;
    // Its uploader is refused as the initiator of any two-person action is: 403, with or
    // without an Idempotency-Key.
    for (const headers of [{}, key()]) {
      const refused = await manager.call(`/withholding-certificates/${certificateId}/confirm`, {
        headers,
        body: {},
      });
      expect(refused.status, JSON.stringify(refused.json)).toBe(403);
      expect(refused.json).toMatchObject({ code: 'FORBIDDEN' });
    }
    // The owner has no user of their own, so an agency admin confirms (decision 3).
    const confirmed = await ok(
      await admin.call(`/withholding-certificates/${certificateId}/confirm`, { body: {} }),
    );
    expect(confirmed).toMatchObject({ status: 'certified' });
    await ok(await manager.call(`/withholding?leaseId=${leaseId}`));
    await ok(await manager.call(`/withholding/${withholdingId}`));
    await ok(
      await manager.call(
        `/tax-files/${(confirmed.certificate as { documentId: string }).documentId}/download`,
      ),
    );
    // A second withholding: its certificate rejected, then written off with two people.
    const other = await ok(
      await manager.call('/withholding', {
        headers: key(),
        body: { leaseId, valueDate: today, lines: [{ lineId: line!.id, amountMinor: 10_000 }] },
      }),
    );
    const second = await ok(
      await manager.call(`/withholding/${String(other.id)}/certificates`, {
        headers: key(),
        body: {
          withholdingId: other.id,
          uploadId: await upload(manager, '/tax-uploads', { purpose: 'withholding_certificate' }),
        },
      }),
    );
    const rejected = await ok(
      await admin.call(
        `/withholding-certificates/${(second.certificate as { id: string }).id}/reject`,
        { body: { reason: 'Not the tenant’s certificate' } },
      ),
    );
    expect(rejected).toMatchObject({ certificate: null, rejectedCertificates: 1 });
    const writeOff = await ok(
      await manager.call(`/withholding/${String(other.id)}/write-off-requests`, {
        headers: key(),
        body: { withholdingId: other.id, reason: 'The certificate never came' },
      }),
    );
    expect((writeOff.approval as { status: string }).status).toBe('pending');
  });
});

describe('AR-05 and AR-06 endpoints over HTTP', () => {
  it('answers the compliance report, a lease’s and a payment’s months ahead, and paid-until ending', async () => {
    await ok(
      await admin.call('/company/settings', {
        method: 'PATCH',
        body: { advanceRentPolicy: 'warn' },
      }),
    );
    const leaseId = await paperLease({ unitId: residential[1]!.id, start: day(5) });
    await transfer(leaseId, 900_000);
    const compliance = await ok(await accountant.call('/compliance/advance-rent'));
    expect(compliance.policy).toBe('warn');
    const rows = compliance.rows as { leaseId: string; monthsAhead: number }[];
    expect(rows.find((r) => r.leaseId === leaseId)?.monthsAhead).toBe(9);
    const advance = await ok(await manager.call(`/leases/${leaseId}/advance`));
    expect((advance.payments as unknown[]).length).toBe(1);
    const paymentId = (advance.payments as { paymentId: string }[])[0]!.paymentId;
    const one = await ok(await manager.call(`/payments/${paymentId}/advance`));
    expect(one).toMatchObject({ monthsAhead: 9, flagged: true });
    await ok(await manager.call('/leases/paid-until-ending?days=366'));
    await ok(
      await admin.call('/company/settings', {
        method: 'PATCH',
        body: { advanceRentPolicy: 'off' },
      }),
    );
  });
});

describe('AR-04 early-termination endpoints over HTTP', () => {
  it('answers the preview, the request, the list and one, and records the refund paid', async () => {
    const start = months(-3, `${today.slice(0, 7)}-01`);
    const leaseId = await paperLease({ unitId: residential[2]!.id, start, breakCredit: true });
    await transfer(leaseId, 600_000, start < day(-100) ? day(-100) : start);
    await ok(await manager.call(`/leases/${leaseId}/move-out`, { body: { moveOutDate: day(-5) } }));
    await api.app.get(InvoicingService).onLeaseEnded(agencyId, leaseId);
    const body = {
      charges: [{ description: 'Agreed charge', amountMinor: 50_000 }],
      deductions: [],
    };
    const preview = await ok(
      await manager.call(`/leases/${leaseId}/early-termination/preview`, { body }),
    );
    expect(preview.appliedMinor).toBe(50_000);
    const requested = await ok(
      await manager.call(`/leases/${leaseId}/early-termination`, { headers: key(), body }),
    );
    const termination = requested.termination as { id: string; refundMinor: number };
    expect(termination.refundMinor).toBe(preview.refundMinor);
    await ok(await manager.call(`/early-terminations?leaseId=${leaseId}`));
    await ok(await manager.call(`/early-terminations/${termination.id}`));
    await ok(
      await admin.call(`/approvals/${(requested.approval as { id: string }).id}/decisions`, {
        body: { decision: 'approve' },
      }),
    );
    const paid = await ok(
      await manager.call(`/early-terminations/${termination.id}/refund-paid`, {
        headers: key(),
        body: {
          terminationId: termination.id,
          paidOn: today,
          paidFrom: 'agency_account',
          reference: 'REFUND HTTP',
          proofUploadId: await upload(manager, '/refund-uploads'),
        },
      }),
    );
    expect(paid.status).toBe('refund_paid');
  });
});
