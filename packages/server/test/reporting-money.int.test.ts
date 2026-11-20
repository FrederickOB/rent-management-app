import { schema, sql, withCompany, type Tx } from '@rent/db';
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
import { lockCounters, lockLeases, leaseGroup, paymentsByIds } from '../src/billing/records';
import { asSuperuser, startServerTest, type ServerTestContext } from './support';
import {
  approvedTransfer,
  billedLease,
  billingServices,
  journalSum,
  leaseAccount,
  moneyCompany,
  runLeaseEvents,
  type BillingServices,
} from './support/billing';
import { maintenanceServices, type MaintenanceServices } from './support/maintenance';
import {
  feeTermsFrom,
  reportingMoneyServices,
  type ReportingMoneyServices,
} from './support/reporting-money';
import { taxServices, uploadEvidence, type TaxServices } from './support/tax';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * M9 management fees (AC-02; P14, plan 4.2, decisions 1 to 3 and the founder's decision on drawn
 * surplus) and the owner's money (AC-05; P16 and P30, decision 8) against the real database with
 * RLS on. Fees: the rate on the rent and service charge a receipt settles, advances included and
 * deposits excluded, rounded once (★); on credit drawn onto a month; on rent settled from a
 * deposit at move-out; mirrored by a reversal and taken back by a chargeback's deposit unwind (★);
 * taken back in proportion by a refund (★); fixed fees once per billable unit (D8); the nightly
 * check; terms that change only through a second person. Owner money: a remittance with fees
 * retained balances (★), the suggestion holds back the rent tax when the agency pays GRA, fees
 * taken and owner funding, refusals, scope and plan. Every test makes its own company; dates are
 * counted from the test clock, so the file passes on any day.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let m: MaintenanceServices;
let r: ReportingMoneyServices;
let today: string;
const DAY = 86_400_000;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const endAfter = (from: string, n: number) => plusDays(plusMonths(from, n), -1);
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
const LONG_AGO = '2024-01-01';

const system = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId, actorKind: 'system' }, fn);

/** Moves the test clock to a day for the call, and back. */
async function on<T>(date: string, fn: () => Promise<T>): Promise<T> {
  const ms = daysBetween(parseBusinessDate(today), parseBusinessDate(date)) * DAY;
  ctx.clock.advance(ms);
  try {
    return await fn();
  } finally {
    ctx.clock.advance(-ms);
  }
}

type Agency = Awaited<ReturnType<typeof moneyCompany>> & {
  ownerId: string;
  bookId: string;
  propertyId: string;
  units: string[];
  next: number;
};

let partCount = 0;
async function agencyWithOwner(
  name: string,
  terms: Parameters<typeof feeTermsFrom>[3] | null,
  options: { kind?: 'agency' | 'landlord'; units?: number } = {},
): Promise<Agency> {
  const c = await moneyCompany(ctx, s, options.kind ?? 'agency', name);
  const ownerId = (
    await s.owners.create(c.admin, { kind: 'individual', displayName: `${name} owner` })
  ).id;
  partCount += 1;
  const property = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: `F${String(partCount).padStart(2, '0')}`,
    ownerId,
    units: [{ unitType: 'apartment', count: options.units ?? 6, bedrooms: 2 }],
  });
  // Registered long ago, as a register built at go-live would have it.
  await asSuperuser(
    ctx,
    `update property_ownership set effective_from = $2::date where company_id = $1`,
    [c.companyId, LONG_AGO],
  );
  if (terms) await feeTermsFrom(ctx, c.companyId, ownerId, terms, LONG_AGO);
  const [book] = await system(c.companyId, (tx) =>
    tx
      .select({ id: schema.book.id })
      .from(schema.book)
      .where(sql`owner_id = ${ownerId}`),
  );
  return {
    ...c,
    ownerId,
    bookId: book!.id,
    propertyId: property.propertyId,
    units: Object.values(property.units),
    next: 0,
  };
}

let tenantCount = 0;
async function lease(
  c: Agency,
  input: { start: string; rent?: number; deposit?: number; cycle?: 'monthly' | 'annual' },
) {
  tenantCount += 1;
  const { tenant } = await s.tenants.create(c.manager, {
    kind: 'individual',
    displayName: `Fee Tenant ${tenantCount}`,
  });
  return billedLease(ctx, s, b, c.manager, {
    unitId: c.units[c.next++]!,
    tenantId: tenant.id,
    startDate: input.start,
    endDate: endAfter(input.start, 12),
    monthlyRentMinor: input.rent ?? 100_000,
    depositMinor: input.deposit ?? null,
    cycle: input.cycle ?? 'monthly',
    signedOn: input.start <= today ? plusDays(input.start, -1) : today,
    ...(input.start <= today ? { billingStartDate: input.start } : {}),
  });
}

const transfer = (
  c: Agency,
  leaseId: string,
  amountMinor: number,
  receivedOn: string,
  receivedInto: 'owner_account' | 'agency_account' = 'owner_account',
) =>
  approvedTransfer(ctx, s, b, c.manager, c.accountant, {
    leaseId,
    receivedInto,
    amountMinor,
    receivedOn,
    senderReference: 'TEST',
  });

/** The fee records of a lease (or an owner), oldest first. */
function feesOf(companyId: string, where: { leaseId?: string; ownerId?: string }) {
  return system(companyId, (tx) =>
    tx
      .select()
      .from(schema.managementFee)
      .where(where.leaseId ? sql`lease_id = ${where.leaseId}` : sql`owner_id = ${where.ownerId!}`)
      .orderBy(schema.managementFee.createdAt, schema.managementFee.key),
  );
}

/** Rent and service charge a payment settles, from its allocations. */
async function settledBy(companyId: string, paymentId: string): Promise<number> {
  const rows = await system(companyId, (tx) =>
    tx.execute<{ total: string }>(
      sql`select coalesce(sum(a.amount_minor), 0)::bigint as total from allocation a
          join invoice_line il on il.id = a.invoice_line_id
          where a.payment_id = ${paymentId}::uuid and a.source = 'payment'
            and il.kind in ('rent', 'service_charge')`,
    ),
  );
  return Number(rows.rows[0]?.total ?? 0);
}

async function paymentOf(companyId: string, leaseId: string): Promise<string> {
  const [row] = await system(companyId, (tx) =>
    tx
      .select({ id: schema.payment.id })
      .from(schema.payment)
      .where(sql`lease_id = ${leaseId}`)
      .orderBy(schema.payment.createdAt),
  );
  return row!.id;
}

/** A chargeback, as the provider reconciliation records it: it cannot be refused (P21b). */
function chargeback(companyId: string, leaseId: string, paymentId: string) {
  return system(companyId, async (tx) => {
    const leases = await leaseGroup(tx, leaseId);
    await lockLeases(tx, companyId, leases);
    await lockCounters(tx, companyId);
    const [payment] = await paymentsByIds(tx, [paymentId]);
    const states = [];
    for (const id of leases) states.push(await b.engine.load(tx, companyId, id));
    return b.engine.reverse(tx, states, payment!, {
      reason: 'chargeback',
      note: 'Charged back at the provider',
      moneyNowIn: 'provider',
      approvalRequestId: null,
      requestedBy: null,
      today,
    });
  });
}

const bookAccount = (c: Agency, account: string) =>
  journalSum(ctx, c.companyId, `l.book_id = $1 and l.account_code = $2`, [c.bookId, account]);

const tenPercent = { kind: 'percentage' as const, rateBps: 1000 };

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  m = maintenanceServices(ctx, s, b, t);
  r = reportingMoneyServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
});

afterAll(async () => {
  await ctx?.close();
});

describe('AC-02 management fees per receipt (P14)', () => {
  it('★ charges the rate on the rent a receipt settles, advances included and deposits excluded, rounded half up once, with the receipt', async () => {
    const c = await agencyWithOwner('Fee Receipts', tenPercent);
    // A month's rent of GH₵1,000.05 and a GH₵1,000 deposit, both paid: the fee is 10% of the
    // rent only, GH₵100.005 rounded half up to GH₵100.01.
    const monthly = await lease(c, { start: monthStart(today), rent: 100_005, deposit: 100_000 });
    const first = await b.money.recordProviderPayment(c.companyId, {
      leaseId: monthly.id,
      amountMinor: 200_005,
      receivedOn: today,
    });
    expect(await feesOf(c.companyId, { leaseId: monthly.id })).toEqual([
      expect.objectContaining({
        key: `P14:${first.paymentId}`,
        source: 'payment',
        paymentId: first.paymentId,
        rateBps: 1000,
        baseMinor: 100_005,
        feeMinor: 10_001,
      }),
    ]);
    expect(await leaseAccount(ctx, c.companyId, monthly.id, '5100')).toBe(10_001);
    expect(await leaseAccount(ctx, c.companyId, monthly.id, '2300')).toBe(-10_001);
    // A year paid ahead on an annual lease: every month it settles bears the fee now.
    const annual = await lease(c, { start: monthStart(today), cycle: 'annual' });
    const ahead = await b.money.recordProviderPayment(c.companyId, {
      leaseId: annual.id,
      amountMinor: 1_200_000,
      receivedOn: today,
    });
    expect(await settledBy(c.companyId, ahead.paymentId)).toBe(1_200_000);
    const [fee] = await feesOf(c.companyId, { leaseId: annual.id });
    expect(fee).toMatchObject({ baseMinor: 1_200_000, feeMinor: 120_000, source: 'payment' });
    // Surplus bears no fee until a month draws it. From today, so its next month is not yet
    // invoiced (14 days ahead) on any day of the month (founder-approved setup fix, 2026-11-19).
    const over = await lease(c, { start: today });
    await b.money.recordProviderPayment(c.companyId, {
      leaseId: over.id,
      amountMinor: 150_000,
      receivedOn: today,
    });
    expect((await feesOf(c.companyId, { leaseId: over.id })).map((f) => f.baseMinor)).toEqual([
      100_000,
    ]);
    // Fees equal rate × base per receipt, and the ledger agrees.
    expect((await r.fees.check(c.companyId, { alert: false })).mismatches).toEqual([]);
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
  });

  it('charges nothing for an owner without percentage terms, nor for receipts before the terms began (no backfill)', async () => {
    const none = await agencyWithOwner('Fee None', null);
    const l1 = await lease(none, { start: monthStart(today) });
    await b.money.recordProviderPayment(none.companyId, {
      leaseId: l1.id,
      amountMinor: 100_000,
      receivedOn: today,
    });
    expect(await feesOf(none.companyId, { leaseId: l1.id })).toEqual([]);
    // Terms from tomorrow: today's receipt carries none.
    const later = await agencyWithOwner('Fee Later', null);
    await feeTermsFrom(ctx, later.companyId, later.ownerId, tenPercent, plusDays(today, 1));
    const l2 = await lease(later, { start: monthStart(today) });
    await b.money.recordProviderPayment(later.companyId, {
      leaseId: l2.id,
      amountMinor: 100_000,
      receivedOn: today,
    });
    expect(await feesOf(later.companyId, { leaseId: l2.id })).toEqual([]);
    expect(await leaseAccount(ctx, later.companyId, l2.id, '5100')).toBe(0);
  });

  it('★ charges surplus when a month draws it, and a reversal mirrors every fee of the payment (P21b)', async () => {
    const c = await agencyWithOwner('Fee Draws', tenPercent);
    // Two months started and owed; GH₵2,500 pays both and leaves GH₵500 of credit.
    const start = plusMonths(today, -1);
    const l = await lease(c, { start });
    const paid = await b.money.recordProviderPayment(c.companyId, {
      leaseId: l.id,
      amountMinor: 250_000,
      receivedOn: today,
    });
    expect(await leaseAccount(ctx, c.companyId, l.id, '5100')).toBe(20_000);
    // Next month starts and draws the credit: rent settled like any other.
    const next = plusMonths(start, 2);
    await on(next, async () => {
      await b.invoicing.generateAll(c.companyId, next);
      await b.invoicing.accrueAll(c.companyId, next);
    });
    const drawn = (await feesOf(c.companyId, { leaseId: l.id })).filter(
      (f) => f.source === 'credit_draw',
    );
    expect(drawn).toEqual([
      expect.objectContaining({
        paymentId: paid.paymentId,
        baseMinor: 50_000,
        feeMinor: 5_000,
        valueDate: next,
      }),
    ]);
    expect(drawn[0]!.key).toMatch(/^P14:P02:/);
    expect(await leaseAccount(ctx, c.companyId, l.id, '5100')).toBe(25_000);
    // A replayed accrual charges nothing twice.
    await on(next, () => b.invoicing.accrueAll(c.companyId, next));
    expect(await leaseAccount(ctx, c.companyId, l.id, '5100')).toBe(25_000);

    // The payment is charged back: both fees are mirrored, from what is left of them.
    await chargeback(c.companyId, l.id, paid.paymentId);
    const rows = await feesOf(c.companyId, { leaseId: l.id });
    const mirrors = rows.filter((f) => f.source === 'reversal');
    expect(mirrors.map((f) => f.feeMinor).sort((x, y) => x - y)).toEqual([-20_000, -5_000]);
    expect(
      mirrors.every((f) => f.reversesFeeId && f.key.startsWith(`P21:${paid.paymentId}:fee#`)),
    ).toBe(true);
    expect(await leaseAccount(ctx, c.companyId, l.id, '5100')).toBe(0);
    expect(await leaseAccount(ctx, c.companyId, l.id, '2300')).toBe(0);
    expect((await r.fees.check(c.companyId, { alert: false })).mismatches).toEqual([]);
    expect((await b.subledger.check(c.companyId, { alert: false })).mismatches).toEqual([]);
  });

  it('charges rent settled from a deposit at move-out (P11); a chargeback takes it back with the receipt’s fee', async () => {
    const c = await agencyWithOwner('Fee Deposit', tenPercent);
    const start = plusMonths(today, -3);
    const l = await lease(c, { start, deposit: 100_000 });
    // Four months started and the deposit: GH₵3,600 leaves rent owed.
    await transfer(c, l.id, 360_000, start);
    const paymentId = await paymentOf(c.companyId, l.id);
    const receiptBase = await settledBy(c.companyId, paymentId);
    expect(receiptBase).toBeGreaterThan(0);
    expect(await leaseAccount(ctx, c.companyId, l.id, '5100')).toBe(receiptBase / 10);
    const planned = await m.moveOuts.plan(c.manager, l.id, {
      plannedDate: today,
      reason: 'end_of_term',
    });
    const submitted = await m.moveOuts.submit(c.manager, planned.id);
    await s.approvals.decide(c.accountant, submitted.approval!.request.id, { decision: 'approve' });
    const done = await m.moveOuts.get(c.manager, planned.id);
    const applied = done.statement!.depositAppliedMinor;
    expect(applied).toBe(100_000);
    const deposit = (await feesOf(c.companyId, { leaseId: l.id })).filter(
      (f) => f.source === 'deposit',
    );
    expect(deposit).toEqual([
      expect.objectContaining({ key: `P14:${planned.id}`, baseMinor: applied, feeMinor: 10_000 }),
    ]);
    expect(await leaseAccount(ctx, c.companyId, l.id, '5100')).toBe(receiptBase / 10 + 10_000);

    // The payment that paid the deposit is charged back: the deposit's share is unwound, and the
    // fee on the rent it settled goes with it, as does the receipt's.
    const result = await chargeback(c.companyId, l.id, paymentId);
    expect(result.depositUnwound).toEqual([
      expect.objectContaining({ moveOutId: planned.id, amountMinor: 100_000 }),
    ]);
    const rows = await feesOf(c.companyId, { leaseId: l.id });
    expect(rows.filter((f) => f.source === 'unwind').map((f) => f.feeMinor)).toEqual([-10_000]);
    expect(rows.filter((f) => f.source === 'reversal').map((f) => f.feeMinor)).toEqual([
      -receiptBase / 10,
    ]);
    expect(await leaseAccount(ctx, c.companyId, l.id, '5100')).toBe(0);
    expect((await r.fees.check(c.companyId, { alert: false })).mismatches).toEqual([]);
  });

  it('charges tax withheld as rent settled (P19), with the cash, to the same total', async () => {
    const c = await agencyWithOwner('Fee Withheld', tenPercent);
    const start = monthStart(today);
    const l = await lease(c, { start, rent: 1_000_000 });
    await b.invoicing.accrueAll(c.companyId, today);
    const [line] = await system(c.companyId, (tx) =>
      tx
        .select({ id: schema.invoiceLine.id })
        .from(schema.invoiceLine)
        .where(sql`lease_id = ${l.id} and kind = 'rent' and period_start = ${start}`),
    );
    const paid = await b.money.recordProviderPayment(c.companyId, {
      leaseId: l.id,
      amountMinor: 850_000,
      receivedOn: today,
    });
    const withholdingId = await t.withholding.record(c.manager, {
      leaseId: l.id,
      paymentId: paid.paymentId,
      valueDate: today,
      lines: [{ lineId: line!.id, amountMinor: 150_000 }],
    });
    const rows = await feesOf(c.companyId, { leaseId: l.id });
    expect(rows.map((f) => [f.key, f.source, f.baseMinor, f.feeMinor])).toEqual([
      [`P14:${paid.paymentId}`, 'payment', 850_000, 85_000],
      [`P14:${withholdingId}`, 'withholding', 150_000, 15_000],
    ]);
    expect(await leaseAccount(ctx, c.companyId, l.id, '5100')).toBe(100_000);
  });

  it('★ takes the fee back in proportion when a refund returns rent paid ahead (decision 3)', async () => {
    const c = await agencyWithOwner('Fee Refund', tenPercent, { units: 2 });
    const start = plusMonths(monthStart(today), -3);
    const l = await lease(c, { start, cycle: 'annual' });
    await transfer(c, l.id, 1_200_000, start);
    expect(await leaseAccount(ctx, c.companyId, l.id, '5100')).toBe(120_000);
    // Moved out early, never on a period's last day (periods start on the 1st here).
    const fiveDaysAgo = plusDays(today, -5);
    const lastDay =
      monthStart(plusDays(fiveDaysAgo, 1)) === plusDays(fiveDaysAgo, 1)
        ? plusDays(today, -6)
        : fiveDaysAgo;
    await s.lifecycle.recordMoveOut(c.manager, l.id, { moveOutDate: lastDay });
    await runLeaseEvents(ctx, b, c.companyId);
    const { approvalId, terminationId } = await t.termination.request(c.manager, l.id, {
      charges: [],
      deductions: [],
    });
    await s.approvals.decide(c.accountant, approvalId, { decision: 'approve' });
    const [settled] = await t.termination.list(c.manager, { ids: [terminationId] });
    const refunded = settled!.refundMinor;
    expect(refunded).toBeGreaterThan(0);
    const taken = (await feesOf(c.companyId, { leaseId: l.id })).filter(
      (f) => f.source === 'refund',
    );
    expect(taken.reduce((n, f) => n + f.baseMinor, 0)).toBe(-refunded);
    // The agent keeps the fee on the rent the owner keeps, to the pesewa.
    expect(await leaseAccount(ctx, c.companyId, l.id, '5100')).toBe((1_200_000 - refunded) / 10);
    expect((await r.fees.check(c.companyId, { alert: false })).mismatches).toEqual([]);
  });
});

describe('AC-02 fixed fees and the nightly check', () => {
  it('posts a fixed fee once per unit billable in the month (D8), on its last day, and on the 1st again for a zone ahead', async () => {
    const c = await agencyWithOwner(
      'Fee Fixed',
      { kind: 'fixed_per_unit', fixedMinor: 5_000 },
      { units: 3 },
    );
    const lastMonth = plusMonths(monthStart(today), -1).slice(0, 7);
    // One unit let from two months ago, one from next month, one vacant.
    await lease(c, { start: plusMonths(monthStart(today), -2) });
    await lease(c, { start: plusMonths(monthStart(today), 1) });
    await s.lifecycle.runTransitions(c.companyId, today);
    expect(await r.fees.runFixedFees(c.companyId, lastMonth)).toBe(1);
    expect(await r.fees.runFixedFees(c.companyId, lastMonth)).toBe(0);
    const rows = await feesOf(c.companyId, { ownerId: c.ownerId });
    expect(rows).toEqual([
      expect.objectContaining({
        source: 'fixed',
        baseMinor: 0,
        feeMinor: 5_000,
        unitId: c.units[0],
        key: `P14:${c.ownerId}:${c.units[0]}:${lastMonth}`,
      }),
    ]);
    expect(rows[0]!.valueDate).toBe(plusDays(`${monthStart(today)}`, -1));
    expect(await bookAccount(c, '5100')).toBe(5_000);
    // The month-end run: this month on its last day; on the 1st, last month again (a no-op).
    const lastDay = plusDays(plusMonths(monthStart(today), 1), -1);
    const done = await on(lastDay, () => r.fees.runMonthEnd(c.companyId));
    expect(done).toEqual({ months: [today.slice(0, 7)], posted: 1 });
    const firstOfNext = plusMonths(monthStart(today), 1);
    expect(await on(firstOfNext, () => r.fees.runMonthEnd(c.companyId))).toEqual({
      months: [today.slice(0, 7)],
      posted: 0,
    });
    // A day mid-month runs nothing.
    expect(
      await on(plusDays(monthStart(today), 14), () => r.fees.runMonthEnd(c.companyId)),
    ).toEqual({
      months: [],
      posted: 0,
    });
    // A landlord pays no management fee.
    const landlord = await agencyWithOwner(
      'Fee Landlord',
      { kind: 'fixed_per_unit', fixedMinor: 5_000 },
      { kind: 'landlord', units: 1 },
    );
    await lease(landlord, { start: plusMonths(monthStart(today), -2) });
    await s.lifecycle.runTransitions(landlord.companyId, today);
    expect(await r.fees.runFixedFees(landlord.companyId, lastMonth)).toBe(0);
  });

  it('raises the critical reporting.fee_mismatch when a fee is not its rate on its base', async () => {
    const c = await agencyWithOwner('Fee Check', tenPercent);
    const l = await lease(c, { start: monthStart(today) });
    await b.money.recordProviderPayment(c.companyId, {
      leaseId: l.id,
      amountMinor: 100_000,
      receivedOn: today,
    });
    expect((await r.fees.check(c.companyId)).mismatches).toEqual([]);
    expect(r.alerts).toEqual([]);
    // A fee record altered below the application: the check finds it.
    await asSuperuser(ctx, `update management_fee set base_minor = 90000 where lease_id = $1`, [
      l.id,
    ]);
    const { mismatches } = await r.fees.check(c.companyId);
    expect(mismatches).toEqual([
      expect.objectContaining({ expectedMinor: 9_000, actualMinor: 10_000 }),
    ]);
    expect(r.alerts).toEqual([
      expect.objectContaining({ severity: 'critical', code: 'reporting.fee_mismatch' }),
    ]);
    r.alerts.length = 0;
  });
});

describe('AC-02 fee terms through a second person (decision 1)', () => {
  it('asks for new terms from today; a second person approves; the next receipt carries them', async () => {
    const c = await agencyWithOwner('Fee Terms', null);
    expect(await r.money.feeTerms(c.manager, c.ownerId)).toEqual({
      owner: { id: c.ownerId, name: 'Fee Terms owner' },
      current: null,
      upcoming: [],
      pending: null,
    });
    const asked = await r.money.requestFeeTerms(c.manager, {
      ownerId: c.ownerId,
      kind: 'percentage',
      rateBps: 800,
      graPaidBy: 'agency',
      effectiveFrom: today,
    });
    expect(asked.pending?.terms).toEqual({
      kind: 'percentage',
      rateBps: 800,
      fixedMinor: null,
      graPaidBy: 'agency',
      effectiveFrom: today,
    });
    // One at a time per owner; the initiator never approves.
    await expect(
      r.money.requestFeeTerms(c.admin, {
        ownerId: c.ownerId,
        kind: 'none',
        graPaidBy: 'owner',
        effectiveFrom: today,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      s.approvals.decide(c.manager, asked.pending!.approvalId, { decision: 'approve' }),
    ).rejects.toThrow();
    await s.approvals.decide(c.admin, asked.pending!.approvalId, { decision: 'approve' });
    const now = await r.money.feeTerms(c.accountant, c.ownerId);
    expect(now.current).toEqual({
      kind: 'percentage',
      rateBps: 800,
      fixedMinor: null,
      graPaidBy: 'agency',
      effectiveFrom: today,
    });
    expect(now.pending).toBeNull();
    const l = await lease(c, { start: monthStart(today) });
    await b.money.recordProviderPayment(c.companyId, {
      leaseId: l.id,
      amountMinor: 100_000,
      receivedOn: today,
    });
    expect(await leaseAccount(ctx, c.companyId, l.id, '5100')).toBe(8_000);
  });

  it('refuses a landlord, a past date, terms that do not make sense, people without fees.manage and Starter', async () => {
    const c = await agencyWithOwner('Fee Terms Refused', null);
    const ask = (
      over: Partial<Parameters<ReportingMoneyServices['money']['requestFeeTerms']>[1]>,
    ) => ({
      ownerId: c.ownerId,
      kind: 'percentage' as const,
      rateBps: 1000,
      graPaidBy: 'owner' as const,
      effectiveFrom: today,
      ...over,
    });
    await expect(
      r.money.requestFeeTerms(c.manager, ask({ effectiveFrom: plusDays(today, -1) })),
    ).rejects.toMatchObject({ status: 400, code: 'effective_from_past' });
    await expect(r.money.requestFeeTerms(c.manager, ask({ rateBps: null }))).rejects.toMatchObject({
      status: 400,
      code: 'fee_terms',
    });
    await expect(
      r.money.requestFeeTerms(c.manager, ask({ kind: 'fixed_per_unit', rateBps: null })),
    ).rejects.toMatchObject({ status: 400, code: 'fee_terms' });
    await expect(r.money.requestFeeTerms(c.accountant, ask({}))).rejects.toMatchObject({
      status: 403,
    });
    const landlord = await agencyWithOwner('Fee Terms Landlord', null, { kind: 'landlord' });
    await expect(
      r.money.requestFeeTerms(landlord.manager, ask({ ownerId: landlord.ownerId })),
    ).rejects.toMatchObject({ status: 409, code: 'not_an_agency' });
    await asSuperuser(ctx, `update company set plan = 'starter' where id = $1`, [c.companyId]);
    await expect(r.money.requestFeeTerms(c.manager, ask({}))).rejects.toMatchObject({
      code: 'not_on_plan',
    });
    await expect(r.money.feeTerms(c.manager, c.ownerId)).rejects.toMatchObject({
      code: 'not_on_plan',
    });
  });
});

describe('AC-05 remittances, fees taken and owner funding (P16, P30)', () => {
  /** An agency holding GH₵1,000 of rent for its owner in its own account, the fee charged. */
  async function holding(name: string, graPaidBy: 'agency' | 'owner') {
    const c = await agencyWithOwner(name, { ...tenPercent, graPaidBy });
    const l = await lease(c, { start: monthStart(today) });
    await transfer(c, l.id, 100_000, today, 'agency_account');
    return { c, l };
  }
  const proof = (actor: Parameters<ReportingMoneyServices['money']['createUpload']>[0]) =>
    uploadEvidence(ctx, (i) => r.money.createUpload(actor, i));

  it('★ records a remittance with fees retained that balances: Dr 1010 net, Dr 2300 fees, Cr 1070', async () => {
    const { c } = await holding('Remit Owner Pays GRA', 'owner');
    expect(await bookAccount(c, '1070')).toBe(100_000);
    expect(await bookAccount(c, '2300')).toBe(-10_000);
    const suggestion = await r.money.suggestion(c.accountant, c.ownerId);
    expect(suggestion).toMatchObject({
      owner: { id: c.ownerId },
      asOf: today,
      agentCashMinor: 100_000,
      feesDueMinor: 10_000,
      graPaidBy: 'owner',
      rentTaxHeldBackMinor: 0,
      totalMinor: 100_000,
      feesRetainedMinor: 10_000,
      netMinor: 90_000,
    });
    const cashBefore = await bookAccount(c, '1010');
    const { id } = await r.money.remit(c.accountant, {
      ownerId: c.ownerId,
      on: today,
      method: 'bank',
      reference: 'GCB 0042',
      proofUploadId: await proof(c.accountant),
      netMinor: 90_000,
      feesRetainedMinor: 10_000,
    });
    expect(await bookAccount(c, '1070')).toBe(0);
    expect(await bookAccount(c, '2300')).toBe(0);
    expect((await bookAccount(c, '1010')) - cashBefore).toBe(90_000);
    const entry = await journalSum(ctx, c.companyId, `e.idempotency_key = $1`, [`P16:${id}`]);
    expect(entry).toBe(0);
    expect(await r.money.get(c.manager, id)).toMatchObject({
      kind: 'remittance',
      owner: { id: c.ownerId, name: 'Remit Owner Pays GRA owner' },
      on: today,
      amountMinor: 90_000,
      feesRetainedMinor: 10_000,
      method: 'bank',
      reference: 'GCB 0042',
      hasProof: true,
      recordedByName: 'Remit Owner Pays GRA accountant',
    });
    expect((await r.money.proofUrl(c.manager, id)).url).toBeTruthy();
    // Nothing left to remit: a second is refused before its proof is kept.
    await expect(
      r.money.remit(c.accountant, {
        ownerId: c.ownerId,
        on: today,
        method: 'bank',
        reference: 'GCB 0043',
        proofUploadId: await proof(c.accountant),
        netMinor: 1_000,
        feesRetainedMinor: 0,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'over_agent_cash' });
  });

  it('holds back the rent tax payable when the agency pays GRA, and refuses a remittance into it', async () => {
    const { c } = await holding('Remit Agency Pays GRA', 'agency');
    const payable = -(await bookAccount(c, '2200'));
    expect(payable).toBeGreaterThan(0);
    const suggestion = await r.money.suggestion(c.manager, c.ownerId);
    expect(suggestion).toMatchObject({
      graPaidBy: 'agency',
      rentTaxHeldBackMinor: payable,
      totalMinor: 100_000 - payable,
      feesRetainedMinor: 10_000,
      netMinor: 90_000 - payable,
    });
    await expect(
      r.money.remit(c.accountant, {
        ownerId: c.ownerId,
        on: today,
        method: 'momo',
        reference: 'MOMO 1',
        proofUploadId: await proof(c.accountant),
        netMinor: 90_000,
        feesRetainedMinor: 10_000,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'into_rent_tax' });
    await expect(
      r.money.remit(c.accountant, {
        ownerId: c.ownerId,
        on: today,
        method: 'momo',
        reference: 'MOMO 1',
        proofUploadId: await proof(c.accountant),
        netMinor: 1_000,
        feesRetainedMinor: 20_000,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'fees_over_due' });
    await r.money.remit(c.accountant, {
      ownerId: c.ownerId,
      on: today,
      method: 'momo',
      reference: 'MOMO 1',
      proofUploadId: await proof(c.accountant),
      netMinor: suggestion.netMinor,
      feesRetainedMinor: suggestion.feesRetainedMinor,
    });
    expect(await bookAccount(c, '1070')).toBe(payable);
  });

  it('records fees taken on their own and owner funding, and lists them newest first', async () => {
    const { c } = await holding('Remit Fees And Funding', 'owner');
    await expect(
      r.money.takeFees(c.accountant, { ownerId: c.ownerId, on: today, amountMinor: 10_001 }),
    ).rejects.toMatchObject({ status: 409, code: 'fees_over_due' });
    const taken = await r.money.takeFees(c.accountant, {
      ownerId: c.ownerId,
      on: today,
      amountMinor: 4_000,
      reference: 'October fees',
    });
    expect(await bookAccount(c, '2300')).toBe(-6_000);
    expect(await bookAccount(c, '1070')).toBe(96_000);
    const funded = await r.money.fund(c.manager, {
      ownerId: c.ownerId,
      on: plusDays(today, -1),
      method: 'bank',
      reference: 'OWNER TOPUP',
      proofUploadId: await proof(c.manager),
      amountMinor: 50_000,
    });
    expect(await bookAccount(c, '1070')).toBe(146_000);
    const list = await r.money.list(c.accountant, { ownerId: c.ownerId });
    expect(list.map((x) => [x.id, x.kind, x.amountMinor, x.feesRetainedMinor, x.hasProof])).toEqual(
      [
        [taken.id, 'fees_taken', 4_000, 0, false],
        [funded.id, 'owner_funding', 50_000, 0, true],
      ],
    );
    expect(await r.money.list(c.accountant, { kind: 'owner_funding' })).toHaveLength(1);
    // A transfer is recorded once made: not for tomorrow.
    await expect(
      r.money.takeFees(c.accountant, {
        ownerId: c.ownerId,
        on: plusDays(today, 1),
        amountMinor: 1_000,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'date_in_future' });
  });

  it('★ keeps each owner’s money to their own users; refuses caretakers, landlords and Starter', async () => {
    const { c } = await holding('Remit Scope', 'owner');
    const otherOwner = (
      await s.owners.create(c.admin, { kind: 'individual', displayName: 'Remit Scope other' })
    ).id;
    await r.money.takeFees(c.accountant, { ownerId: c.ownerId, on: today, amountMinor: 1_000 });
    const ownUser = await staffIn(ctx, c.companyId, 'agency', 'owner', 'Remit Scope user', {
      owners: [c.ownerId],
    });
    const otherUser = await staffIn(ctx, c.companyId, 'agency', 'owner', 'Remit Other user', {
      owners: [otherOwner],
    });
    // The positive case: the owner's user sees their record and suggestion.
    expect(await r.money.list(ownUser, {})).toHaveLength(1);
    expect((await r.money.suggestion(ownUser, c.ownerId)).owner.id).toBe(c.ownerId);
    // Another owner's user sees nothing of it.
    expect(await r.money.list(otherUser, {})).toEqual([]);
    await expect(r.money.suggestion(otherUser, c.ownerId)).rejects.toMatchObject({ status: 404 });
    await expect(r.money.feeTerms(otherUser, c.ownerId)).rejects.toMatchObject({ status: 404 });
    // A manager limited to properties sees an owner's money only when every property the owner
    // has held is theirs (as statements, decision 15), and then the owner's whole balances.
    const otherProperty = await propertyWithUnits(s, c.manager, {
      areaCode: 'ACC',
      propertyPart: 'RSO',
      ownerId: otherOwner,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const ownManager = await staffIn(ctx, c.companyId, 'agency', 'property_manager', 'Remit own', {
      properties: [c.propertyId],
    });
    const otherManager = await staffIn(
      ctx,
      c.companyId,
      'agency',
      'property_manager',
      'Remit other',
      { properties: [otherProperty.propertyId] },
    );
    expect((await r.money.list(ownManager, {})).map((x) => x.owner.name)).toEqual([
      'Remit Scope owner',
    ]);
    expect(await r.money.suggestion(ownManager, c.ownerId)).toMatchObject({
      agentCashMinor: 99_000,
      feesDueMinor: 9_000,
    });
    expect(await r.money.list(otherManager, {})).toEqual([]);
    await expect(r.money.suggestion(otherManager, c.ownerId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      r.money.takeFees(otherManager, { ownerId: c.ownerId, on: today, amountMinor: 1_000 }),
    ).rejects.toMatchObject({ status: 404 });
    const [record] = await r.money.list(c.accountant, { ownerId: c.ownerId });
    await expect(r.money.get(otherManager, record!.id)).rejects.toMatchObject({ status: 404 });
    // Owners read; they never record.
    await expect(
      r.money.takeFees(ownUser, { ownerId: c.ownerId, on: today, amountMinor: 1_000 }),
    ).rejects.toMatchObject({ status: 403 });
    const caretaker = await staffIn(ctx, c.companyId, 'agency', 'caretaker', 'Remit caretaker');
    await expect(r.money.list(caretaker, {})).rejects.toMatchObject({ status: 403 });
    const landlord = await agencyWithOwner('Remit Landlord', null, { kind: 'landlord' });
    await expect(
      r.money.takeFees(landlord.accountant, {
        ownerId: landlord.ownerId,
        on: today,
        amountMinor: 1_000,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'not_an_agency' });
    await asSuperuser(ctx, `update company set plan = 'starter' where id = $1`, [c.companyId]);
    await expect(r.money.list(c.accountant, {})).rejects.toMatchObject({ code: 'not_on_plan' });
  });
});
