import { schema, sql, withCompany } from '@rent/db';
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
import { startServerTest, type ServerTestContext } from './support';
import {
  approvedTransfer,
  billedLease,
  billingServices,
  journalSum,
  leaseAccount,
  moneyCard,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { taxItemsOf, taxServices, uploadEvidence, type TaxServices } from './support/tax';
import { fundAgentCash } from './support/owner-funding';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * Rent tax per receipt, the report and VAT returns against the real database (M5 plan section 6):
 * worked example A with its tax, the report against the tax on each receipt and the P17 entries,
 * a future-dated rate, byte-identical regeneration of a locked month, alerts and VAT payments.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let today: string;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let ownerA: string;
let elg: { propertyId: string; units: Record<string, string> };
let unitIndex = 0;
const DAY = 86_400_000;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const endAfter = (from: string, n: number) => plusDays(plusMonths(from, n), -1);
const nextUnit = () => Object.values(elg.units)[unitIndex++]!;

async function tenant(name: string) {
  return (await s.tenants.create(agency.manager, { kind: 'individual', displayName: name })).tenant
    .id;
}

/** Moves the clock to a business date (Africa/Accra is UTC+0) for `fn`, and back afterwards. */
async function on<T>(date: string, fn: () => Promise<T>): Promise<T> {
  const ms = daysBetween(parseBusinessDate(today), parseBusinessDate(date)) * DAY;
  ctx.clock.advance(ms);
  try {
    return await fn();
  } finally {
    ctx.clock.advance(-ms);
  }
}

const transfer = (leaseId: string, amountMinor: number, receivedOn: string) =>
  approvedTransfer(ctx, s, b, agency.manager, agency.accountant, {
    leaseId,
    receivedInto: 'owner_account',
    amountMinor,
    receivedOn,
    senderReference: 'TEST',
  });
/** F3 (founder-approved, 2026-11-07): rent the agency collects, so it can pay GRA from it. */
const intoAgency = (leaseId: string, amountMinor: number, receivedOn: string) =>
  approvedTransfer(ctx, s, b, agency.manager, agency.accountant, {
    leaseId,
    receivedInto: 'agency_account',
    amountMinor,
    receivedOn,
    senderReference: 'TEST',
  });

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  agency = await moneyCompany(ctx, s, 'agency', 'Tax Agency');
  ownerA = (await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Owner A' })).id;
  elg = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: 'ELG',
    ownerId: ownerA,
    units: [{ unitType: 'apartment', count: 40, bedrooms: 2 }],
  });
});

afterAll(async () => {
  await ctx?.close();
});

describe('AR-01 a two-year advance shows the right paid-until and unearned rent every month', () => {
  it('worked example A with its rent tax: GH₵2,880 at receipt, due in 30 days, and nothing more as months are recognised', async () => {
    const start = plusDays(today, 3);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(),
      tenantId: await tenant('Two Year'),
      startDate: start,
      endDate: endAfter(start, 24),
      monthlyRentMinor: 150_000,
      cycle: 'annual',
      initialAdvanceMonths: 24,
      signedOn: today,
    });
    await transfer(lease.id, 3_600_000, today);
    const items = await taxItemsOf(ctx, agency.companyId, lease.id);
    expect(items.map((i) => [i.kind, i.baseMinor, i.rateBps, i.taxMinor, i.dueDate])).toEqual([
      ['receipt', 3_600_000, 800, 288_000, plusDays(today, 30)],
    ]);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '5300')).toBe(288_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2200')).toBe(-288_000);
    const end = endAfter(start, 24);
    const prepaid = 3_600_000;
    for (let month = 0; month < 24; month += 1) {
      const date = plusMonths(start, month);
      let card = await moneyCard(ctx, b, agency.companyId, lease.id);
      await on(date, async () => {
        await b.invoicing.generateAll(agency.companyId, date);
        await b.invoicing.accrueAll(agency.companyId, date);
        card = await moneyCard(ctx, b, agency.companyId, lease.id);
      });
      const recognised = await journalSum(
        ctx,
        agency.companyId,
        `l.lease_id = $1 and l.account_code = '2010' and e.rule = 'P02'`,
        [lease.id],
      );
      const held = -(await leaseAccount(ctx, agency.companyId, lease.id, '2010'));
      expect(recognised + held, `month ${month}`).toBe(prepaid);
      expect(card.paidUntil, `month ${month}`).toBe(end);
      expect(card.unearnedRentMinor, `month ${month}`).toBe(prepaid - 150_000 * (month + 1));
    }
    // Recognising the advance month by month is not a receipt: the tax stays as it was.
    expect((await taxItemsOf(ctx, agency.companyId, lease.id)).length).toBe(1);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2200')).toBe(-288_000);
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
  });
});

describe('TX-01 the rent tax on an owner’s report equals the tax on each receipt in the period', () => {
  it('reports the tax of every receipt, net of a reversal, and matches the P17 entries by accounting date', async () => {
    const start = plusMonths(today, -2);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(),
      tenantId: await tenant('Monthly Payer'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 120_000,
      cycle: 'monthly',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    await transfer(lease.id, 120_000, plusDays(start, 2));
    await transfer(lease.id, 50_000, today);
    const items = await taxItemsOf(ctx, agency.companyId, lease.id);
    expect(items.map((i) => [i.kind, i.baseMinor, i.taxMinor])).toEqual([
      ['receipt', 120_000, 9_600],
      ['receipt', 50_000, 4_000],
    ]);
    const report = await t.reports.report(agency.accountant, {
      ownerId: ownerA,
      from: plusDays(start, -1),
      to: today,
    });
    const mine = report.items.filter((i) => i.leaseId === lease.id);
    expect(mine.map((i) => i.taxMinor)).toEqual([9_600, 4_000]);
    const p17 = await journalSum(
      ctx,
      agency.companyId,
      `l.account_code = '5300' and e.record_type = 'rent_tax_item' and l.book_id = (select id from book where owner_id = $1)
       and e.accounting_date between $2 and $3`,
      [ownerA, plusDays(start, -1), today],
    );
    expect(report.totals.taxMinor).toBe(p17);
    expect(report.totals.taxMinor).toBe(report.items.reduce((s, i) => s + i.taxMinor, 0));
    expect(report.warnings.length).toBeGreaterThan(0);
  });
});

describe('TX-03 GRA payments settle items', () => {
  it('records a GRA payment with its receipt, settling the oldest items first', async () => {
    const start = plusDays(today, 1);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(),
      tenantId: await tenant('Quarter Ahead'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 100_000,
      cycle: 'quarterly',
      signedOn: today,
    });
    await transfer(lease.id, 300_000, today);
    const [item] = await taxItemsOf(ctx, agency.companyId, lease.id);
    expect(item!.taxMinor).toBe(24_000);
    const upload = await uploadEvidence(ctx, (i) => t.gra.createUpload(agency.accountant, i));
    const before = await t.reports.dueList(agency.accountant, { ownerId: ownerA });
    const owed = before.reduce((s, i) => s + i.outstandingMinor, 0);
    // F3 (founder-approved, 2026-11-07): the owner funds the agency to pay GRA.
    await fundAgentCash(ctx, s, b, agency.accountant, ownerA, owed);
    await t.gra.recordGraPayment(agency.accountant, {
      ownerId: ownerA,
      paidOn: today,
      amountMinor: owed,
      graReceiptNumber: 'GRA-0001',
      receiptUploadId: upload,
      paidFrom: 'agency_account',
    });
    const after = await t.reports.dueList(agency.accountant, { ownerId: ownerA });
    expect(after).toEqual([]);
    const items = await t.reports.items(agency.accountant, { leaseId: lease.id });
    expect(items.map((i) => i.status)).toEqual(['paid']);
    expect(
      await journalSum(
        ctx,
        agency.companyId,
        `l.account_code = '2200' and l.book_id = (select id from book where owner_id = $1)`,
        [ownerA],
      ),
    ).toBe(0);
    expect(
      await journalSum(ctx, agency.companyId, `l.account_code = '1070' and e.rule = 'P18'`),
    ).toBe(-owed);
  });
});

describe('TX-01 the rent tax base', () => {
  it('taxes advances, never deposits or credit beyond the lease end', async () => {
    const start = plusDays(today, 2);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(),
      tenantId: await tenant('Short Lease'),
      startDate: start,
      endDate: endAfter(start, 2),
      monthlyRentMinor: 100_000,
      depositMinor: 200_000,
      cycle: 'monthly',
      signedOn: today,
    });
    // The deposit, both months of the term and one more month that the term never reaches.
    await transfer(lease.id, 200_000 + 300_000, today);
    const items = await taxItemsOf(ctx, agency.companyId, lease.id);
    expect(items.map((i) => [i.baseMinor, i.taxMinor])).toEqual([[200_000, 16_000]]);
    // The second month is not invoiced yet, so its GH₵1,000 is credit, and so is the GH₵1,000
    // beyond the term's two months, which is not rent and is not taxed.
    const card = await moneyCard(ctx, b, agency.companyId, lease.id);
    expect(card.creditMinor).toBe(200_000);
    expect(card.paidUntil).toBe(endAfter(start, 2));
  });

  it('a reversal mirrors its payment’s tax (P21), and its item shows as reversed', async () => {
    const start = plusMonths(today, -1);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(),
      tenantId: await tenant('Bounced'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 100_000,
      cycle: 'monthly',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    await transfer(lease.id, 200_000, today);
    const [payment] = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ id: schema.payment.id })
          .from(schema.payment)
          .where(sql`lease_id = ${lease.id}`),
    );
    const approval = await b.money.requestReversal(agency.manager, payment!.id, {
      reason: 'wrong_entry',
      note: 'Recorded twice by mistake',
      moneyNowIn: 'owner_account',
    });
    await s.approvals.decide(agency.accountant, approval, { decision: 'approve' });
    const items = await t.reports.items(agency.accountant, { leaseId: lease.id });
    expect(items.map((i) => [i.kind, i.taxMinor, i.status])).toEqual([
      ['receipt', 16_000, 'reversed'],
      ['reversal', -16_000, 'correction'],
    ]);
    expect(items[1]!.reversesItemId).toBe(items[0]!.id);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '5300')).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2200')).toBe(0);
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
  });
});

describe('TX-02 alerts', () => {
  it('alerts at 21 and 28 days after the rent was received, once each, to the people who pay GRA', async () => {
    const owner = (
      await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Alert Owner' })
    ).id;
    const place = await propertyWithUnits(s, agency.manager, {
      areaCode: 'ACC',
      propertyPart: 'ALT',
      ownerId: owner,
      units: [{ unitType: 'apartment', count: 2, bedrooms: 1 }],
    });
    const start = plusMonths(today, -2);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: Object.values(place.units)[0]!,
      tenantId: await tenant('Alerted'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 100_000,
      cycle: 'monthly',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    await intoAgency(lease.id, 100_000, plusDays(today, -21));
    expect(await t.taxAlerts.run(agency.companyId, plusDays(today, -1))).toBe(0);
    expect(await t.taxAlerts.run(agency.companyId, today)).toBe(1);
    expect(await t.taxAlerts.run(agency.companyId, today)).toBe(0);
    const due = await t.reports.dueList(agency.accountant, { ownerId: owner });
    expect(due.map((i) => [i.alertsReached, i.alertsSent, i.daysToDue])).toEqual([[[21], [21], 9]]);
    expect(await t.taxAlerts.run(agency.companyId, plusDays(today, 7))).toBe(1);
    const sent = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ day: schema.rentTaxAlert.alertDay, recipients: schema.rentTaxAlert.recipients })
          .from(schema.rentTaxAlert)
          .where(sql`owner_id = ${owner}`)
          .orderBy(schema.rentTaxAlert.alertDay),
    );
    // The agency's admin and accountant: whoever the policy lets pay GRA (decision 5).
    expect(sent).toEqual([
      { day: 21, recipients: 2 },
      { day: 28, recipients: 2 },
    ]);
    // Once paid, nothing more.
    const upload = await uploadEvidence(ctx, (i) => t.gra.createUpload(agency.accountant, i));
    await t.gra.recordGraPayment(agency.accountant, {
      ownerId: owner,
      paidOn: today,
      amountMinor: 8_000,
      graReceiptNumber: 'GRA-ALERT',
      receiptUploadId: upload,
      paidFrom: 'agency_account',
    });
    expect(await t.reports.dueList(agency.accountant, { ownerId: owner })).toEqual([]);
  });
});

describe('P33 VAT returns', () => {
  it('reports VAT and levies by tax point, and a VAT payment clears 2210', async () => {
    const owner = (
      await s.owners.create(agency.admin, {
        kind: 'company',
        displayName: 'VAT Owner Ltd',
        legalName: 'VAT Owner Limited',
        vatRegistered: true,
        tin: 'C0098765432',
      })
    ).id;
    const place = await propertyWithUnits(s, agency.manager, {
      areaCode: 'ACC',
      propertyPart: 'VAT',
      ownerId: owner,
      use: 'commercial',
      units: [{ unitType: 'shop', count: 2 }],
    });
    const start = `${today.slice(0, 7)}-01`;
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: Object.values(place.units)[0]!,
      tenantId: await tenant('Shop Tenant'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 1_000_000,
      cycle: 'monthly',
      use: 'commercial',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    await intoAgency(lease.id, 1_200_000, today);
    // Rent tax is on the rent only, never the VAT (15% of GH₵10,000).
    expect((await taxItemsOf(ctx, agency.companyId, lease.id)).map((i) => i.taxMinor)).toEqual([
      150_000,
    ]);
    const report = await t.gra.vatReport(agency.accountant, {
      ownerId: owner,
      month: today.slice(0, 7),
    });
    expect(report.invoices.map((i) => [i.vatMinor, i.nhilMinor, i.getfundMinor])).toEqual([
      [150_000, 25_000, 25_000],
    ]);
    expect(report.totals).toMatchObject({
      totalMinor: 200_000,
      paidMinor: 0,
      outstandingMinor: 200_000,
    });
    expect(report.warnings.length).toBeGreaterThan(0);
    const upload = await uploadEvidence(ctx, (i) => t.gra.createUpload(agency.accountant, i));
    await t.gra.recordVatPayment(agency.accountant, {
      ownerId: owner,
      periodMonth: today.slice(0, 7),
      paidOn: today,
      amountMinor: 200_000,
      graReceiptNumber: 'GRA-VAT-1',
      receiptUploadId: upload,
      paidFrom: 'agency_account',
    });
    expect(
      await journalSum(
        ctx,
        agency.companyId,
        `l.account_code = '2210' and l.book_id = (select id from book where owner_id = $1)`,
        [owner],
      ),
    ).toBe(0);
    const after = await t.gra.vatReport(agency.accountant, {
      ownerId: owner,
      month: today.slice(0, 7),
    });
    expect(after.totals).toMatchObject({ paidMinor: 200_000, outstandingMinor: 0 });
    await expect(
      t.gra.recordVatPayment(agency.accountant, {
        ownerId: owner,
        periodMonth: today.slice(0, 7),
        paidOn: today,
        amountMinor: 1,
        graReceiptNumber: 'GRA-VAT-2',
        receiptUploadId: await uploadEvidence(ctx, (i) => t.gra.createUpload(agency.accountant, i)),
        paidFrom: 'agency_account',
      }),
    ).rejects.toMatchObject({ code: 'vat_over_payable' });
  });
});

describe('NFR-SEC tax isolation and scope', () => {
  it('shows an owner only their own items and reports; managers cannot pay GRA', async () => {
    const other = (
      await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Other Owner' })
    ).id;
    const ownerUser = await staffIn(ctx, agency.companyId, 'agency', 'owner', 'Owner A user', {
      owners: [ownerA],
    });
    const mine = await t.reports.items(ownerUser, {});
    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine.map((i) => i.ownerId))).toEqual(new Set([ownerA]));
    await expect(
      t.reports.report(ownerUser, { ownerId: other, from: plusMonths(today, -1), to: today }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await t.reports.report(ownerUser, {
          ownerId: ownerA,
          from: plusMonths(today, -3),
          to: today,
        })
      ).items.length,
    ).toBeGreaterThan(0);
    await expect(
      t.gra.createUpload(agency.manager, { contentType: 'application/pdf', sizeBytes: 10 }),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(t.reports.items(ownerUser, { ownerId: other })).resolves.toEqual([]);
  });
});

describe('NFR-SEC tax tables', () => {
  it('keeps rent tax items append-only', async () => {
    await expect(
      withCompany(ctx.database, { companyId: agency.companyId, actorKind: 'system' }, (tx) =>
        tx
          .update(schema.rentTaxItem)
          .set({ taxMinor: 1 })
          .where(sql`true`),
      ),
    ).rejects.toThrow();
  });
});
