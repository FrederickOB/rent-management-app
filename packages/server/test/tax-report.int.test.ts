import { createHash } from 'node:crypto';
import { schema, sql, withCompany } from '@rent/db';
import { PdfRenderer } from '@rent/documents/render';
import {
  addDays,
  addMonths,
  businessDateOf,
  daysBetween,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, startServerTest, type ServerTestContext } from './support';
import {
  approvedTransfer,
  billedLease,
  billingServices,
  journalSum,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { taxItemsOf, taxServices, uploadEvidence, type TaxServices } from './support/tax';
import { propertyWithUnits, tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * The rent tax report over time (M5 plan 5.3 and 5.7; ★ tests): a report for a locked month
 * regenerates byte for byte, PDF and CSV, after later postings; and a future-dated rate changes
 * nothing before its date, while receipts after it use the new rate.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let today: string;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let renderer: PdfRenderer;
const DAY = 86_400_000;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const endAfter = (from: string, n: number) => plusDays(plusMonths(from, n), -1);
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

async function on<T>(date: string, fn: () => Promise<T>): Promise<T> {
  const ms = daysBetween(parseBusinessDate(today), parseBusinessDate(date)) * DAY;
  ctx.clock.advance(ms);
  try {
    return await fn();
  } finally {
    ctx.clock.advance(-ms);
  }
}

async function ownerWithUnits(name: string, part: string) {
  const ownerId = (await s.owners.create(agency.admin, { kind: 'individual', displayName: name }))
    .id;
  const property = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: part,
    ownerId,
    units: [{ unitType: 'apartment', count: 6, bedrooms: 2 }],
  });
  return { ownerId, units: Object.values(property.units) };
}

async function monthlyLease(unitId: string, start: string, rent: number) {
  const tenantId = (
    await s.tenants.create(agency.manager, { kind: 'individual', displayName: `Tenant ${unitId}` })
  ).tenant.id;
  return billedLease(ctx, s, b, agency.manager, {
    unitId,
    tenantId,
    startDate: start,
    endDate: endAfter(start, 12),
    monthlyRentMinor: rent,
    cycle: 'monthly',
    signedOn: plusDays(start, -1),
    billingStartDate: start,
  });
}

const transfer = (leaseId: string, amountMinor: number, receivedOn: string) =>
  approvedTransfer(ctx, s, b, agency.manager, agency.accountant, {
    leaseId,
    receivedInto: 'owner_account',
    amountMinor,
    receivedOn,
    senderReference: 'TEST',
  });

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Renders the report's PDF as the worker would, and returns its stored bytes' SHA-256. */
async function pdfOf(input: { ownerId: string; from: string; to: string }): Promise<string> {
  const { renderRequestId } = await t.reports.requestPdf(agency.accountant, input);
  await s.documents.renderRequested(agency.companyId, renderRequestId, (html) =>
    renderer.render(html),
  );
  const pdf = await t.reports.pdf(agency.accountant, renderRequestId);
  expect(pdf.status).toBe('ready');
  const file = await s.documents.documentFile(agency.companyId, pdf.documentId!);
  expect(file!.intact).toBe(true);
  expect(file!.sha256).toBe(pdf.sha256);
  return sha(file!.bytes);
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  agency = await moneyCompany(ctx, s, 'agency', 'Report Agency');
  renderer = await PdfRenderer.launch({ poolSize: 1 });
}, 120_000);

afterAll(async () => {
  await renderer?.close();
  await ctx?.close();
});

describe('TX-03 a report regenerated for a past month matches the original exactly', () => {
  it('gives the same PDF and CSV bytes for a locked month after later postings land in the open month', async () => {
    const owner = await ownerWithUnits('Locked Month Owner', 'LKM');
    const lastMonth = monthStart(plusMonths(today, -1));
    const start = plusMonths(lastMonth, -1);
    const first = await monthlyLease(owner.units[0]!, start, 100_000);
    const second = await monthlyLease(owner.units[1]!, start, 80_000);
    await transfer(first.id, 200_000, plusDays(lastMonth, 3));
    await transfer(second.id, 80_000, plusDays(lastMonth, 3));
    const period = { ownerId: owner.ownerId, from: lastMonth, to: endAfter(lastMonth, 1) };
    // The owner's statement month is locked (M9 issues locks; here one is set as M4a's rule does).
    const bookId = (
      await withCompany(ctx.database, { companyId: agency.companyId, actorKind: 'system' }, (tx) =>
        tx
          .select({ id: schema.book.id })
          .from(schema.book)
          .where(sql`owner_id = ${owner.ownerId}`),
      )
    )[0]!.id;
    await withCompany(ctx.database, { companyId: agency.companyId, actorKind: 'system' }, (tx) =>
      b.posting.lockMonth(tx, {
        companyId: agency.companyId,
        bookId,
        month: lastMonth,
        source: 'manual',
      }),
    );
    const before = await t.reports.report(agency.accountant, period);
    const csvBefore = await t.reports.csv(agency.accountant, period);
    const pdfBefore = await pdfOf(period);
    expect(before.items.map((i) => i.taxMinor)).toEqual([16_000, 6_400]);
    expect(before.totals.outstandingMinor).toBe(22_400);

    // Later: money received in the locked month but recorded now, a GRA payment dated in it, and
    // a reversal of one of its payments. Each keeps its value date and lands in the open month.
    await transfer(second.id, 80_000, plusDays(lastMonth, 20));
    const upload = await uploadEvidence(ctx, (i) => t.gra.createUpload(agency.accountant, i));
    await t.gra.recordGraPayment(agency.accountant, {
      ownerId: owner.ownerId,
      paidOn: plusDays(lastMonth, 25),
      amountMinor: 16_000,
      graReceiptNumber: 'GRA-LOCKED-1',
      receiptUploadId: upload,
      paidFrom: 'owner_account',
    });
    const [paid] = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ id: schema.payment.id })
          .from(schema.payment)
          .where(sql`lease_id = ${second.id} and received_on = ${plusDays(lastMonth, 3)}`),
    );
    const reversal = await b.money.requestReversal(agency.manager, paid!.id, {
      reason: 'wrong_entry',
      note: 'Recorded against the wrong lease',
      moneyNowIn: 'owner_account',
    });
    await s.approvals.decide(agency.accountant, reversal, { decision: 'approve' });
    const items = await taxItemsOf(ctx, agency.companyId, second.id);
    expect(items.map((i) => i.kind)).toEqual(['receipt', 'receipt', 'reversal']);
    for (const item of items.slice(1)) expect(item.accountingDate >= monthStart(today)).toBe(true);

    const after = await t.reports.report(agency.accountant, period);
    expect(after).toEqual(before);
    expect((await t.reports.csv(agency.accountant, period)).content).toBe(csvBefore.content);
    expect(await pdfOf(period)).toBe(pdfBefore);
    // The open month carries the late items, the GRA payment and the reversal.
    const open = await t.reports.report(agency.accountant, {
      ownerId: owner.ownerId,
      from: monthStart(today),
      to: today,
    });
    expect(open.items.map((i) => i.kind).sort()).toEqual(['receipt', 'reversal']);
    expect(open.graPayments.map((g) => g.graReceiptNumber)).toEqual(['GRA-LOCKED-1']);
  }, 120_000);
});

describe('TX-08 a future-dated rate change does not alter past receipts or reports', () => {
  it('keeps past items and the regenerated report as they were; receipts after the date use the new rate', async () => {
    const owner = await ownerWithUnits('Rate Change Owner', 'RTC');
    const start = plusMonths(monthStart(today), -1);
    const lease = await monthlyLease(owner.units[0]!, start, 100_000);
    await transfer(lease.id, 100_000, today);
    const period = { ownerId: owner.ownerId, from: start, to: today };
    const before = await t.reports.report(agency.accountant, period);
    const csvBefore = (await t.reports.csv(agency.accountant, period)).content;
    const [item] = await taxItemsOf(ctx, agency.companyId, lease.id);
    expect([item!.rateBps, item!.taxMinor]).toEqual([800, 8_000]);

    // A new rules row, dated next month: a test value, not a real rate (CLAUDE.md section 7).
    const effective = plusMonths(monthStart(today), 1);
    const [row] = await asOwner(
      ctx,
      `insert into rule (country, key, value, effective_from, source, verification_status, created_by)
       values ('GH', 'rent_tax.rate.residential', '{"bps": 1000}', $1, 'TX-08 test: a hypothetical rate', 'unverified', 'test')
       returning id`,
      [effective],
    );
    const newRule = (row as { id: string }).id;
    expect(await t.reports.report(agency.accountant, period)).toEqual(before);
    expect((await t.reports.csv(agency.accountant, period)).content).toBe(csvBefore);
    expect((await taxItemsOf(ctx, agency.companyId, lease.id))[0]).toEqual(item);

    // A receipt before the date still uses 8%; one after it uses the new row, and records it.
    await transfer(lease.id, 50_000, today);
    await on(plusDays(effective, 2), async () => {
      await b.invoicing.generateAll(agency.companyId, plusDays(effective, 2));
      await transfer(lease.id, 100_000, plusDays(effective, 2));
    });
    const items = await taxItemsOf(ctx, agency.companyId, lease.id);
    expect(items.map((i) => [i.rateBps, i.baseMinor, i.taxMinor])).toEqual([
      [800, 100_000, 8_000],
      [800, 50_000, 4_000],
      [1000, 100_000, 10_000],
    ]);
    expect(items[2]!.rateRuleId).toBe(newRule);
    expect(items[0]!.rateRuleId).not.toBe(newRule);
    const p17 = await journalSum(
      ctx,
      agency.companyId,
      `l.lease_id = $1 and l.account_code = '5300' and e.record_type = 'rent_tax_item'`,
      [lease.id],
    );
    expect(p17).toBe(22_000);
  });
});
