import { createDatabase, schema, sql, withCompany } from '@rent/db';
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
import { IdempotencyStore, requestHash } from '../src/core/idempotency';
import { runSql } from '@rent/db/testing';
import { startServerTest, type ServerTestContext } from './support';
import {
  approvedCash,
  approvedTransfer,
  billedLease,
  billingServices,
  journalSum,
  leaseAccount,
  moneyCard,
  moneyCompany,
  uploadMoneyProof,
  type BillingServices,
} from './support/billing';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * Money in and its corrections against the real database (CLAUDE.md section 12; M4a plan
 * section 6): two-person cash, receipt and invoice numbers under concurrency, reversals, credit
 * notes, write-offs, unmatched receipts, idempotent requests, scope and isolation, and replay.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let today: string;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let ownerA: string;
let ownerB: string;
let leg: { propertyId: string; units: Record<string, string> };
let osu: { propertyId: string; units: Record<string, string> };
let caretaker: Awaited<ReturnType<typeof staffIn>>;
let unitIndex = 0;
const DAY = 86_400_000;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const endAfter = (from: string, n: number) => plusDays(plusMonths(from, n), -1);
const legUnit = () => Object.values(leg.units)[unitIndex++]!;

async function tenant(name: string) {
  return (await s.tenants.create(agency.manager, { kind: 'individual', displayName: name })).tenant
    .id;
}

async function on<T>(date: string, fn: () => Promise<T>): Promise<T> {
  const ms = daysBetween(parseBusinessDate(today), parseBusinessDate(date)) * DAY;
  ctx.clock.advance(ms);
  try {
    return await fn();
  } finally {
    ctx.clock.advance(-ms);
  }
}

/** A monthly lease billed from a month ago: two periods started and owed. */
async function owingLease(name: string, unitId = legUnit(), rent = 100_000) {
  const start = plusMonths(today, -1);
  return billedLease(ctx, s, b, agency.manager, {
    unitId,
    tenantId: await tenant(name),
    startDate: start,
    endDate: endAfter(start, 12),
    monthlyRentMinor: rent,
    cycle: 'monthly',
    signedOn: plusDays(start, -1),
    billingStartDate: start,
  });
}

const sys = (companyId: string) => ({ companyId, actorKind: 'system' as const });

async function count(companyId: string, table: string, where = 'true'): Promise<number> {
  const rows = await withCompany(ctx.database, sys(companyId), (tx) =>
    tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table} where ${where}`)),
  );
  return rows.rows[0]!.n;
}

async function linesOf(companyId: string, leaseId: string) {
  return withCompany(ctx.database, sys(companyId), async (tx) => {
    const state = await b.engine.load(tx, companyId, leaseId);
    return state.lines;
  });
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  agency = await moneyCompany(ctx, s, 'agency', 'Money Agency');
  ownerA = (await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Owner A' })).id;
  ownerB = (await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Owner B' })).id;
  leg = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: 'LEG',
    ownerId: ownerA,
    units: [{ unitType: 'single_room', count: 40 }],
  });
  osu = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: 'OSU',
    ownerId: ownerB,
    units: [{ unitType: 'single_room', count: 6 }],
  });
  caretaker = await staffIn(ctx, agency.companyId, 'agency', 'caretaker', 'Kojo Caretaker', {
    properties: [leg.propertyId],
  });
});

afterAll(async () => {
  await ctx?.close();
});

describe('BC-05 cash posts only after a second person approves', () => {
  it('records nothing in the ledger until approval, refuses the initiator, and posts on approval', async () => {
    const lease = await owingLease('Cash Payer');
    const entriesBefore = await count(agency.companyId, 'journal_entry');
    const photo = await uploadMoneyProof(ctx, b, caretaker, 'cash_photo');
    const recorded = await b.money.recordCash(caretaker, {
      leaseId: lease.id,
      method: 'cash',
      amountMinor: 150_000,
      receivedOn: today,
      payerName: 'Cash Payer',
      photoUploadId: photo,
    });
    expect(await count(agency.companyId, 'journal_entry')).toBe(entriesBefore);
    expect(await count(agency.companyId, 'payment', `lease_id = '${lease.id}'`)).toBe(0);
    const [record] = await b.read.cashRecords(caretaker, { ids: [recorded.cashRecordId] });
    expect(record).toMatchObject({ status: 'awaiting_approval', paymentId: null });
    // The approval shows what the approvals screen needs (coordinator, item 2).
    const view = await s.approvals.get(caretaker, recorded.approvalId);
    expect(view.request.payload).toMatchObject({
      amountMinor: 150_000,
      method: 'cash',
      payerName: 'Cash Payer',
      collectorName: 'Kojo Caretaker',
      unitCode: expect.stringMatching(/^ACC-LEG-/),
      tenantName: 'Cash Payer',
      leaseId: lease.id,
    });
    // The initiator is refused by the service, and by the database itself.
    await expect(
      s.approvals.decide(caretaker, recorded.approvalId, { decision: 'approve' }),
    ).rejects.toMatchObject({ status: 403 });
    const refused = await runSql(ctx.db.superuserUrl, `select 1`).then(() =>
      withCompany(
        ctx.database,
        { companyId: agency.companyId, personId: caretaker.personId, actorKind: 'staff' },
        (tx) =>
          tx.insert(schema.approvalDecision).values({
            companyId: agency.companyId,
            requestId: recorded.approvalId,
            decidedBy: caretaker.personId,
            decidedByMembershipId: caretaker.membershipId,
            kind: 'approve',
            payloadHash: 'x',
          }),
      ).then(
        () => null,
        (error: { cause?: { code?: string } }) => error.cause?.code,
      ),
    );
    expect(refused).toBe('RA013');
    expect(await count(agency.companyId, 'journal_entry')).toBe(entriesBefore);
    // A second person approves: the payment, its P06 entry and its receipt, in one transaction.
    await s.approvals.decide(agency.manager, recorded.approvalId, { decision: 'approve' });
    const [after] = await b.read.cashRecords(agency.manager, { ids: [recorded.cashRecordId] });
    expect(after!.status).toBe('approved');
    const payment = await b.read.payment(agency.manager, after!.paymentId!);
    expect(payment).toMatchObject({ status: 'confirmed', collectorName: 'Kojo Caretaker' });
    expect(payment.receipts).toEqual([
      expect.objectContaining({ number: expect.stringMatching(/^RC-\d{6}$/) }),
    ]);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1060')).toBe(150_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1100')).toBe(50_000);
  });

  it('posts nothing when the second person rejects, and caretakers see only their properties', async () => {
    const lease = await owingLease('Rejected Cash');
    const before = await count(agency.companyId, 'journal_entry');
    const photo = await uploadMoneyProof(ctx, b, agency.manager, 'cash_photo');
    const recorded = await b.money.recordCash(agency.manager, {
      leaseId: lease.id,
      method: 'cheque',
      amountMinor: 100_000,
      receivedOn: today,
      payerName: 'Rejected Cash',
      chequeNumber: '004512',
      chequeBank: 'GCB Bank',
      photoUploadId: photo,
    });
    await s.approvals.decide(agency.admin, recorded.approvalId, {
      decision: 'reject',
      reason: 'The cheque is not signed',
    });
    expect(await count(agency.companyId, 'journal_entry')).toBe(before);
    expect(
      (await b.read.cashRecords(agency.manager, { ids: [recorded.cashRecordId] }))[0]!.status,
    ).toBe('rejected');
    // A caretaker of ACC-LEG cannot record cash for a lease on ACC-OSU, nor read invoices.
    const elsewhere = await owingLease('Elsewhere', Object.values(osu.units)[0]!);
    const photo2 = await uploadMoneyProof(ctx, b, caretaker, 'cash_photo');
    await expect(
      b.money.recordCash(caretaker, {
        leaseId: elsewhere.id,
        method: 'cash',
        amountMinor: 1_000,
        receivedOn: today,
        payerName: 'Someone',
        photoUploadId: photo2,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(b.read.invoices(caretaker, {})).rejects.toMatchObject({ status: 403 });
    await expect(b.read.arrears(caretaker, { by: 'tenant' })).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('BC-06 receipt numbers have no gaps under concurrency', () => {
  it('gives 50 concurrent approvals receipt numbers 1 to 50, and concurrent invoices consecutive numbers', async () => {
    const fresh = await moneyCompany(ctx, s, 'agency', 'Numbers Agency');
    const owner = (
      await s.owners.create(fresh.admin, { kind: 'individual', displayName: 'Numbers Owner' })
    ).id;
    const property = await propertyWithUnits(s, fresh.manager, {
      areaCode: 'ACC',
      propertyPart: 'NUM',
      ownerId: owner,
      units: [{ unitType: 'single_room', count: 20 }],
    });
    const start = plusDays(today, 1);
    // Twenty leases recorded, then their signing handled all at once: 20 invoice numbers, in a row.
    const leases: { id: string }[] = [];
    for (const unitId of Object.values(property.units)) {
      const t = (
        await s.tenants.create(fresh.manager, {
          kind: 'individual',
          displayName: `T ${leases.length}`,
        })
      ).tenant.id;
      leases.push(
        await s.leases.recordPaper(fresh.manager, {
          unitId,
          tenantId: t,
          startDate: start,
          endDate: endAfter(start, 12),
          monthlyRentMinor: 10_000,
          cycle: 'monthly',
          noticeDays: 30,
          parties: [{ role: 'tenant', name: 'Numbers Tenant' }],
          scanUploadId: await (
            await import('./support/tenancy')
          ).uploadLeaseFile(ctx, s, fresh.manager),
          signedOn: today,
        }),
      );
    }
    await Promise.all(leases.map((l) => b.invoicing.onLeaseSigned(fresh.companyId, l.id)));
    const invoiceNumbers = (
      await withCompany(ctx.database, sys(fresh.companyId), (tx) =>
        tx.select({ number: schema.invoice.number }).from(schema.invoice),
      )
    )
      .map((r) => r.number)
      .sort((x, y) => x - y);
    expect(invoiceNumbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // Fifty cash records over five leases, approved at the same moment.
    const requests: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const photo = await uploadMoneyProof(ctx, b, fresh.manager, 'cash_photo');
      const recorded = await b.money.recordCash(fresh.manager, {
        leaseId: leases[i % 5]!.id,
        method: 'cash',
        amountMinor: 1_000 + i,
        receivedOn: today,
        payerName: 'Payer',
        photoUploadId: photo,
      });
      requests.push(recorded.approvalId);
    }
    const results = await Promise.allSettled(
      requests.map((id) => s.approvals.decide(fresh.admin, id, { decision: 'approve' })),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const receipts = (
      await withCompany(ctx.database, sys(fresh.companyId), (tx) =>
        tx.select({ number: schema.receipt.number }).from(schema.receipt),
      )
    )
      .map((r) => r.number)
      .sort((x, y) => x - y);
    expect(receipts).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    // A number taken in a transaction that fails is given back with it.
    await expect(
      withCompany(ctx.database, sys(fresh.companyId), async (tx) => {
        const { nextNumber } = await import('../src/billing/records');
        expect(await nextNumber(tx, fresh.companyId, 'receipt')).toBe(51);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    const next = await withCompany(ctx.database, sys(fresh.companyId), async (tx) => {
      const { nextNumber } = await import('../src/billing/records');
      return nextNumber(tx, fresh.companyId, 'receipt');
    });
    expect(next).toBe(51);
    expect((await b.subledger.check(fresh.companyId)).mismatches).toEqual([]);
  });
});

describe('P21 payment reversal from current allocations', () => {
  it('restores every line and the credit exactly, after an accrual used the surplus, with a credit receipt', async () => {
    const lease = await owingLease('Bounced Cheque');
    const recorded = await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: lease.id,
      amountMinor: 250_000,
      receivedOn: today,
      method: 'cheque',
    });
    expect((await moneyCard(ctx, b, agency.companyId, lease.id)).creditMinor).toBe(50_000);
    // Next month's period starts and draws the surplus.
    const next = plusMonths(today, 1);
    await on(next, async () => {
      await b.invoicing.generateAll(agency.companyId, next);
      await b.invoicing.accrueAll(agency.companyId, next);
    });
    const [record] = await b.read.cashRecords(agency.manager, { ids: [recorded.cashRecordId] });
    const paymentId = record!.paymentId!;
    const detail = await b.read.payment(agency.manager, paymentId);
    expect(detail.reversalOptions).toContain('collector');
    // Reversals need billing.manage; a caretaker cannot ask.
    await expect(
      b.money.requestReversal(caretaker, paymentId, {
        reason: 'bounced_cheque',
        note: 'Returned by the bank',
        moneyNowIn: 'collector',
      }),
    ).rejects.toMatchObject({ status: 403 });
    const requestId = await b.money.requestReversal(agency.manager, paymentId, {
      reason: 'bounced_cheque',
      note: 'Returned by the bank',
      moneyNowIn: 'collector',
    });
    await s.approvals.decide(agency.accountant, requestId, { decision: 'approve' });
    const lines = await linesOf(agency.companyId, lease.id);
    const card = await moneyCard(ctx, b, agency.companyId, lease.id);
    expect(card.creditMinor).toBe(0);
    expect(card.earnedUnpaidMinor).toBe(3 * 100_000);
    expect(lines.filter((l) => l.accrued)).toHaveLength(3);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1100')).toBe(300_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2010')).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1060')).toBe(0);
    const after = await b.read.payment(agency.manager, paymentId);
    expect(after.status).toBe('reversed');
    expect(after.receipts.map((r) => r.kind).sort()).toEqual(['credit_receipt', 'receipt']);
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
  });
});

describe('P27 credit notes', () => {
  it('credits a line not yet charged, one charged and unpaid, and one charged and paid, each with approval', async () => {
    const start = plusMonths(today, -1);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: legUnit(),
      tenantId: await tenant('Credit Notes'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 100_000,
      cycle: 'quarterly',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    // The quarter: month 0 and 1 started, month 2 not yet. Pay months 0 and 2 ahead (250,000).
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: lease.id,
      amountMinor: 250_000,
      receivedOn: today,
    });
    const lines = await linesOf(agency.companyId, lease.id);
    const [m0, m1, m2] = lines;
    // Month 1 is half paid (oldest first: 100,000 to month 0, 100,000 to month 1, 50,000 to month 2).
    const credit = async (lineId: string, amountMinor: number) => {
      const id = await b.money.requestCreditNote(agency.manager, lineId, {
        amountMinor,
        reason: 'Correction agreed with the tenant',
      });
      // Not by the person who asked.
      await expect(
        s.approvals.decide(agency.manager, id, { decision: 'approve' }),
      ).rejects.toMatchObject({
        status: 403,
      });
      await s.approvals.decide(agency.admin, id, { decision: 'approve' });
    };
    // Not charged yet (month 2, with 50,000 paid ahead): no income moves, the 50,000 returns to credit.
    const income = await leaseAccount(ctx, agency.companyId, lease.id, '4000');
    await credit(m2!.id, 100_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '4000')).toBe(income);
    let card = await moneyCard(ctx, b, agency.companyId, lease.id);
    expect(card.creditMinor).toBe(50_000);
    // Charged and paid (month 0): income reversed, its money back to credit.
    await credit(m0!.id, 30_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '4000')).toBe(income + 30_000);
    card = await moneyCard(ctx, b, agency.companyId, lease.id);
    expect(card.creditMinor).toBe(80_000);
    // Charged and paid in full too (month 1 got 100,000): credit 20,000 more.
    await credit(m1!.id, 20_000);
    expect((await moneyCard(ctx, b, agency.companyId, lease.id)).creditMinor).toBe(100_000);
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
  });

  it('credits a charged line that is unpaid: it stops being owed', async () => {
    const lease = await owingLease('Unpaid Credit');
    const [m0] = await linesOf(agency.companyId, lease.id);
    const id = await b.money.requestCreditNote(agency.manager, m0!.id, {
      amountMinor: 40_000,
      reason: 'Wrong rent on the first month',
    });
    await s.approvals.decide(agency.accountant, id, { decision: 'approve' });
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1100')).toBe(160_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '4000')).toBe(-160_000);
  });
});

describe('P24 write-offs', () => {
  it('writes off what is owed with approval, never more, and never on a line not yet charged', async () => {
    const lease = await owingLease('Bad Debt');
    const lines = await linesOf(agency.companyId, lease.id);
    const id = await b.money.requestWriteOff(agency.manager, lines[0]!.id, {
      amountMinor: 60_000,
      reason: 'The tenant left the country',
    });
    await s.approvals.decide(agency.admin, id, { decision: 'approve' });
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '5900')).toBe(60_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1100')).toBe(140_000);
    await expect(
      b.money.requestWriteOff(agency.manager, lines[0]!.id, {
        amountMinor: 40_001,
        reason: 'More than is owed',
      }),
    ).rejects.toMatchObject({ code: 'billing.write_off_too_large' });
    const ahead = await billedLease(ctx, s, b, agency.manager, {
      unitId: legUnit(),
      tenantId: await tenant('Future Write Off'),
      startDate: plusDays(today, 3),
      endDate: endAfter(plusDays(today, 3), 12),
      monthlyRentMinor: 10_000,
      cycle: 'monthly',
      signedOn: today,
    });
    const [future] = await linesOf(agency.companyId, ahead.id);
    await expect(
      b.money.requestWriteOff(agency.manager, future!.id, {
        amountMinor: 1,
        reason: 'Not owed yet',
      }),
    ).rejects.toMatchObject({ code: 'billing.write_off_not_owed' });
  });
});

describe('P23 unmatched direct receipts', () => {
  it('holds money in the agency account in the company book, then moves it into the owner’s book on matching', async () => {
    const lease = await owingLease('Matched Later');
    const recorded = await approvedTransfer(ctx, s, b, agency.manager, agency.admin, {
      receivedInto: 'agency_account',
      amountMinor: 120_000,
      receivedOn: today,
      senderReference: 'GCB TRF 1234',
    });
    const unmatched = await b.read.unmatched(agency.manager);
    const waiting = unmatched.find((u) => u.senderReference === 'GCB TRF 1234')!;
    expect(waiting).toMatchObject({
      receivedInto: 'agency_account',
      ownerId: null,
      amountMinor: 120_000,
    });
    const companyBook = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx
        .select()
        .from(schema.book)
        .where(sql`${schema.book.kind} = 'company'`),
    );
    const bookId = companyBook[0]!.id;
    const inCompany = (account: string) =>
      journalSum(ctx, agency.companyId, `l.book_id = $1 and l.account_code = $2`, [
        bookId,
        account,
      ]);
    expect(await inCompany('2090')).toBe(-120_000);
    expect(await inCompany('1070')).toBe(120_000);
    // A caretaker never sees the agency's unattributed money.
    await expect(b.read.unmatched(caretaker)).rejects.toMatchObject({ status: 403 });
    await b.money.match(agency.manager, waiting.paymentId, lease.id);
    expect(await inCompany('2090')).toBe(0);
    expect(await inCompany('1070')).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1070')).toBe(120_000);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1100')).toBe(80_000);
    const payment = await b.read.payment(agency.manager, waiting.paymentId);
    expect(payment).toMatchObject({ status: 'confirmed', leaseId: lease.id });
    expect(payment.receipts).toHaveLength(1);
    expect(
      (await b.read.unmatched(agency.manager)).some((u) => u.paymentId === waiting.paymentId),
    ).toBe(false);
    expect(recorded.directReceiptId).toBeTruthy();
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
  });

  it('holds money in an owner’s account in that owner’s book, and matches only that owner’s leases', async () => {
    await approvedTransfer(ctx, s, b, agency.manager, agency.admin, {
      receivedInto: 'owner_account',
      ownerId: ownerA,
      amountMinor: 30_000,
      receivedOn: today,
      senderReference: 'OWNER-A TRF',
    });
    const waiting = (await b.read.unmatched(agency.manager)).find(
      (u) => u.senderReference === 'OWNER-A TRF',
    )!;
    expect(waiting).toMatchObject({ receivedInto: 'owner_account', ownerId: ownerA });
    const otherOwners = await owingLease('Owner B Tenant', Object.values(osu.units)[1]!);
    await expect(
      b.money.match(agency.manager, waiting.paymentId, otherOwners.id),
    ).rejects.toMatchObject({
      code: 'payment_other_owner',
    });
    const mine = await owingLease('Owner A Tenant');
    await b.money.match(agency.manager, waiting.paymentId, mine.id);
    // In the same book the money stays where it arrived (1010); the suspense clears and the
    // tenant owes 30,000 less.
    expect(await leaseAccount(ctx, agency.companyId, mine.id, '1100')).toBe(170_000);
    expect(
      await journalSum(ctx, agency.companyId, `l.payment_id = $1 and l.account_code = '2090'`, [
        waiting.paymentId,
      ]),
    ).toBe(0);
    expect(
      await journalSum(ctx, agency.companyId, `l.payment_id = $1 and l.account_code = '1010'`, [
        waiting.paymentId,
      ]),
    ).toBe(30_000);
  });
});

describe('BC-05 and P07 cash on hand', () => {
  it('banks a caretaker’s cash with approval, never more than they hold, property by property', async () => {
    const first = await owingLease('Bank One');
    const second = await owingLease('Bank Two');
    await approvedCash(ctx, s, b, caretaker, agency.admin, {
      leaseId: first.id,
      amountMinor: 50_000,
      receivedOn: today,
    });
    await approvedCash(ctx, s, b, caretaker, agency.admin, {
      leaseId: second.id,
      amountMinor: 70_000,
      receivedOn: today,
    });
    const held = (await b.read.collectorsCash(caretaker)).find((c) => c.ownerId === ownerA)!;
    const slip = await uploadMoneyProof(ctx, b, caretaker, 'banking_slip');
    await expect(
      b.money.recordBanking(caretaker, {
        collectorPersonId: caretaker.personId,
        ownerId: ownerA,
        bankedInto: 'owner_account',
        amountMinor: held.heldMinor + 1,
        bankedOn: today,
        slipUploadId: slip,
      }),
    ).rejects.toMatchObject({ code: 'cash_short' });
    const slip2 = await uploadMoneyProof(ctx, b, caretaker, 'banking_slip');
    const banking = await b.money.recordBanking(caretaker, {
      collectorPersonId: caretaker.personId,
      ownerId: ownerA,
      bankedInto: 'owner_account',
      amountMinor: 100_000,
      bankedOn: today,
      slipUploadId: slip2,
    });
    expect((await s.approvals.get(caretaker, banking.approvalId)).request.payload).toMatchObject({
      amountMinor: 100_000,
      bankedInto: 'owner_account',
      ownerName: 'Owner A',
      collectorName: 'Kojo Caretaker',
    });
    const pending = (await b.read.collectorsCash(caretaker)).find((c) => c.ownerId === ownerA)!;
    expect(pending).toMatchObject({ heldMinor: held.heldMinor, bankingPendingMinor: 100_000 });
    await s.approvals.decide(agency.accountant, banking.approvalId, { decision: 'approve' });
    const after = (await b.read.collectorsCash(caretaker)).find((c) => c.ownerId === ownerA)!;
    expect(after).toMatchObject({ heldMinor: held.heldMinor - 100_000, bankingPendingMinor: 0 });
    // Every banked line keeps its property.
    const lines = await withCompany(ctx.database, sys(agency.companyId), (tx) =>
      tx.execute<{ property_id: string | null }>(
        sql`select l.property_id from journal_line l join journal_entry e on e.id = l.entry_id where e.rule = 'P07'`,
      ),
    );
    expect(lines.rows.every((l) => l.property_id === leg.propertyId)).toBe(true);
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
  });
});

describe('M2 S8 idempotent requests', () => {
  it('replays the same key and body, refuses the same key with another body, and writes once under concurrency', async () => {
    const store = new IdempotencyStore(ctx.database, { attempts: 50, ms: 50 });
    const lease = await owingLease('Idempotent Cash');
    const actor = agency.manager;
    const input = {
      leaseId: lease.id,
      method: 'cash' as const,
      amountMinor: 20_000,
      receivedOn: today,
      payerName: 'Idempotent',
      photoUploadId: await uploadMoneyProof(ctx, b, actor, 'cash_photo'),
    };
    const key = 'retry-key-0001';
    const write = () =>
      store.run(
        {
          companyId: agency.companyId,
          personId: actor.personId,
          key,
          operation: 'payment.cash_record',
          hash: requestHash('payment.cash_record', actor.personId, input),
        },
        (claim) => b.money.recordCash(actor, input, { claim }),
      );
    const results = await Promise.allSettled([write(), write(), write()]);
    const answers = results.flatMap((r) =>
      r.status === 'fulfilled' ? [r.value.cashRecordId] : [],
    );
    expect(new Set(answers).size).toBe(1);
    expect(await count(agency.companyId, 'cash_record', `lease_id = '${lease.id}'`)).toBe(1);
    expect((await write()).cashRecordId).toBe(answers[0]);
    await expect(
      store.run(
        {
          companyId: agency.companyId,
          personId: actor.personId,
          key,
          operation: 'payment.cash_record',
          hash: requestHash('payment.cash_record', actor.personId, { ...input, amountMinor: 1 }),
        },
        (claim) => b.money.recordCash(actor, { ...input, amountMinor: 1 }, { claim }),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'idempotency_key_reused' });
  });
});

describe('AC-01 replaying an event changes nothing', () => {
  it('posts nothing new when invoice runs, accruals, signing events, approvals and postings are replayed', async () => {
    const lease = await owingLease('Replayed');
    const recorded = await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: lease.id,
      amountMinor: 90_000,
      receivedOn: today,
    });
    const snapshot = async () => ({
      entries: await count(agency.companyId, 'journal_entry'),
      lines: await count(agency.companyId, 'journal_line'),
      invoices: await count(agency.companyId, 'invoice'),
      allocations: await count(agency.companyId, 'allocation'),
      payments: await count(agency.companyId, 'payment'),
      receipts: await count(agency.companyId, 'receipt'),
    });
    const before = await snapshot();
    await b.invoicing.generateAll(agency.companyId, today);
    await b.invoicing.accrueAll(agency.companyId, today);
    await b.invoicing.onLeaseSigned(agency.companyId, lease.id);
    await b.invoicing.onLeaseEnded(agency.companyId, lease.id);
    await expect(
      s.approvals.decide(agency.accountant, recorded.approvalId, { decision: 'approve' }),
    ).rejects.toBeDefined();
    // The approved record posted once: receiving its money again finds the payment.
    await withCompany(ctx.database, sys(agency.companyId), async (tx) => {
      const state = await b.engine.load(tx, agency.companyId, lease.id);
      const [record] = await tx
        .select()
        .from(schema.cashRecord)
        .where(sql`${schema.cashRecord.id} = ${recorded.cashRecordId}`);
      await b.engine.receive(tx, state, {
        amountMinor: record!.amountMinor,
        receivedOn: record!.receivedOn,
        method: 'cash',
        rule: 'P06',
        cashAccount: '1060',
        collectorPersonId: record!.collectorPersonId,
        sourceType: 'cash_record',
        sourceId: record!.id,
      });
      // And a posting key already used posts nothing.
      const [entry] = await tx.select().from(schema.journalEntry).limit(1);
      const again = await b.posting.post(tx, {
        companyId: agency.companyId,
        rule: entry!.rule as 'P06',
        key: entry!.idempotencyKey,
        valueDate: entry!.valueDate,
        lines: [],
        record: { type: entry!.recordType, id: entry!.recordId },
      });
      expect(again).toMatchObject({ replayed: true, entryId: entry!.id });
    });
    expect(await snapshot()).toEqual(before);
  });
});

describe('NFR-SEC billing isolation and scope', () => {
  it('shows another company nothing, a tenant only its own money and no journal, and a caretaker only its properties’ cash', async () => {
    const mine = await owingLease('Tenant Session Mine');
    const theirs = await owingLease('Tenant Session Theirs');
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: mine.id,
      amountMinor: 10_000,
      receivedOn: today,
    });
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: theirs.id,
      amountMinor: 20_000,
      receivedOn: today,
    });
    // Another company's staff see nothing of this one.
    const other = await moneyCompany(ctx, s, 'agency', 'Other Agency');
    await expect(b.read.leaseBilling(other.manager, mine.id)).rejects.toMatchObject({
      status: 404,
    });
    expect((await b.read.invoices(other.manager, {})).length).toBe(0);
    // A tenant session reads its own invoices, payments and receipts, and no journal row.
    const tenantId = (
      await withCompany(ctx.database, sys(agency.companyId), (tx) =>
        tx
          .select({ tenantId: schema.lease.tenantId })
          .from(schema.lease)
          .where(sql`${schema.lease.id} = ${mine.id}`),
      )
    )[0]!.tenantId;
    const database = createDatabase(ctx.db.appUrl, { max: 1 });
    try {
      const seen = await withCompany(
        database,
        {
          companyId: agency.companyId,
          actorKind: 'tenant',
          tenantScope: { tenantIds: [tenantId] },
        },
        async (tx) => {
          const n = async (table: string, column = 'lease_id') =>
            (
              await tx.execute<{ n: number; others: number }>(
                sql.raw(
                  `select count(*)::int as n, count(*) filter (where ${column} is distinct from '${mine.id}')::int as others from ${table}`,
                ),
              )
            ).rows[0]!;
          return {
            invoices: await n('invoice'),
            lines: await n('invoice_line'),
            allocations: await n('allocation'),
            payments: await n('payment'),
            receipts: await n('receipt'),
            journalEntries: (await n('journal_entry', 'id')).n,
            journalLines: (await n('journal_line')).n,
            books: (await n('book', 'id')).n,
            cash: (await n('cash_record')).n,
          };
        },
      );
      expect(seen.invoices.n).toBeGreaterThan(0);
      expect(seen.invoices.others).toBe(0);
      expect(seen.lines.others).toBe(0);
      expect(seen.allocations.others).toBe(0);
      expect(seen.payments).toEqual({ n: 1, others: 0 });
      expect(seen.receipts).toEqual({ n: 1, others: 0 });
      expect(seen).toMatchObject({ journalEntries: 0, journalLines: 0, books: 0, cash: 0 });
    } finally {
      await database.close();
    }
    // A caretaker sees only the cash of their assigned properties, and only their own.
    const osuLease = await owingLease('Osu Cash', Object.values(osu.units)[2]!);
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: osuLease.id,
      amountMinor: 33_000,
      receivedOn: today,
    });
    const caretakerCash = await b.read.collectorsCash(caretaker);
    expect(caretakerCash.every((c) => c.collectorPersonId === caretaker.personId)).toBe(true);
    const caretakerRecords = await b.read.cashRecords(caretaker, {});
    expect(caretakerRecords.every((r) => r.collectorPersonId === caretaker.personId)).toBe(true);
    const managerCash = await b.read.collectorsCash(agency.manager);
    expect(managerCash.some((c) => c.ownerId === ownerB)).toBe(true);
    // A caretaker reads a cash record's photo of their own, not anyone else's (coordinator, item 1).
    const theirsPhoto = (await b.read.cashRecords(agency.manager, { leaseId: osuLease.id }))[0]!
      .photoDocumentId!;
    await expect(b.read.paymentFileUrl(caretaker, theirsPhoto)).rejects.toMatchObject({
      status: 404,
    });
    expect(caretakerRecords.length).toBeGreaterThan(0);
    const own = caretakerRecords[0]!;
    await expect(b.read.paymentFileUrl(caretaker, own.photoDocumentId!)).resolves.toMatch(
      /download/,
    );
    // An approver of an open request sees its photo before deciding; so does billing.view.
    await expect(b.read.paymentFileUrl(agency.accountant, theirsPhoto)).resolves.toMatch(
      /download/,
    );
  });
});

describe('BC-07 allocation', () => {
  it('pays the deposit, then the oldest rent; a part payment leaves the line part owed; the rest is credit', async () => {
    const start = plusMonths(today, -1);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: legUnit(),
      tenantId: await tenant('Allocation Order'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 100_000,
      depositMinor: 200_000,
      cycle: 'monthly',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: lease.id,
      amountMinor: 250_000,
      receivedOn: today,
    });
    let card = await moneyCard(ctx, b, agency.companyId, lease.id);
    expect(card).toMatchObject({
      depositHeldMinor: 200_000,
      earnedUnpaidMinor: 150_000,
      creditMinor: 0,
    });
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: lease.id,
      amountMinor: 200_000,
      receivedOn: today,
    });
    card = await moneyCard(ctx, b, agency.companyId, lease.id);
    expect(card).toMatchObject({ earnedUnpaidMinor: 0, creditMinor: 50_000 });
    // Deposits never reach income (BC-11).
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '4000')).toBe(-200_000);
    expect(-(await leaseAccount(ctx, agency.companyId, lease.id, '2100'))).toBe(200_000);
  });
});

describe('BC-03 payment references', () => {
  it('issues one valid reference per lease at signing, unique across the platform', async () => {
    const lease = await owingLease('Reference');
    const card = await moneyCard(ctx, b, agency.companyId, lease.id);
    const { isValidReference } = await import('@rent/domain/billing');
    expect(isValidReference(card.paymentReference!)).toBe(true);
    const all = await runSql<{ n: number; distinct: number }>(
      ctx.db.ownerUrl,
      'select count(*)::int as n, count(distinct reference)::int as distinct from payment_reference',
    );
    expect(all[0]!.n).toBe(all[0]!.distinct);
  });
});
