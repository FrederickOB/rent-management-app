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
  leaseAccount,
  moneyCard,
  moneyCompany,
  runLeaseEvents,
  uploadMoneyProof,
  type BillingServices,
} from './support/billing';
import {
  setAdvancePolicy,
  taxItemsOf,
  taxServices,
  uploadEvidence,
  type TaxServices,
} from './support/tax';
import {
  deliverMessages,
  messagesOf,
  propertyWithUnits,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * Early termination, advance rent and the paid-until prompt against the real database (AR-04 to
 * AR-06; M5 plan 5.4, 5.5 and decisions 4 to 6).
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let today: string;
const DAY = 86_400_000;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const endAfter = (from: string, n: number) => plusDays(plusMonths(from, n), -1);
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

type Company = Awaited<ReturnType<typeof moneyCompany>> & { units: string[]; next: number };

async function companyWithUnits(name: string, part: string): Promise<Company> {
  const company = await moneyCompany(ctx, s, 'agency', name);
  const ownerId = (
    await s.owners.create(company.admin, { kind: 'individual', displayName: `${name} owner` })
  ).id;
  const property = await propertyWithUnits(s, company.manager, {
    areaCode: 'ACC',
    propertyPart: part,
    ownerId,
    units: [{ unitType: 'apartment', count: 12, bedrooms: 2 }],
  });
  return { ...company, units: Object.values(property.units), next: 0 };
}

async function lease(
  c: Company,
  input: {
    start: string;
    months?: number;
    rent?: number;
    cycle?: 'monthly' | 'annual' | 'two_yearly';
    breakCredit?: boolean;
    phone?: string;
    consent?: boolean;
  },
) {
  const { tenant } = await s.tenants.create(c.manager, {
    kind: 'individual',
    displayName: `Tenant ${c.next}`,
    ...(input.phone ? { phone: input.phone } : {}),
  });
  if (input.consent)
    await s.tenants.recordConsent(c.manager, tenant.id, { channel: 'sms', action: 'grant' });
  return billedLease(ctx, s, b, c.manager, {
    unitId: c.units[c.next++]!,
    tenantId: tenant.id,
    startDate: input.start,
    endDate: endAfter(input.start, input.months ?? 12),
    monthlyRentMinor: input.rent ?? 100_000,
    cycle: input.cycle ?? 'monthly',
    ...(input.cycle === 'two_yearly' ? { initialAdvanceMonths: 24 } : {}),
    signedOn: input.start < today ? plusDays(input.start, -1) : today,
    ...(input.start < today ? { billingStartDate: input.start } : {}),
    ...(input.breakCredit !== undefined
      ? {
          breakClause: {
            fromDate: plusMonths(input.start, 1),
            party: 'tenant' as const,
            noticeDays: 30,
            creditUnusedDays: input.breakCredit,
          },
        }
      : {}),
  });
}

const transfer = (c: Company, leaseId: string, amountMinor: number, receivedOn: string) =>
  approvedTransfer(ctx, s, b, c.manager, c.accountant, {
    leaseId,
    receivedInto: 'owner_account',
    amountMinor,
    receivedOn,
    senderReference: 'TEST',
  });

async function advanceOf(c: Company, leaseId: string) {
  return withCompany(ctx.database, { companyId: c.companyId, actorKind: 'system' }, (tx) =>
    tx
      .select()
      .from(schema.paymentAdvance)
      .where(sql`lease_id = ${leaseId}`)
      .orderBy(schema.paymentAdvance.createdAt),
  );
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
});

afterAll(async () => {
  await ctx?.close();
});

describe('AR-04 early termination', () => {
  let c: Company;
  beforeAll(async () => {
    c = await companyWithUnits('Termination Agency', 'TRM');
  });

  async function endedEarly(breakCredit: boolean) {
    const start = plusMonths(monthStart(today), -3);
    const l = await lease(c, { start, breakCredit });
    await transfer(c, l.id, 600_000, start);
    // Five days ago, but never a rent period's last day: a move-out then leaves no unused days,
    // so on the 5th of every month the test would prove nothing (founder-approved, 2026-11-05).
    // Periods start on the 1st here.
    const fiveDaysAgo = plusDays(today, -5);
    const lastDay =
      monthStart(plusDays(fiveDaysAgo, 1)) === plusDays(fiveDaysAgo, 1)
        ? plusDays(today, -6)
        : fiveDaysAgo;
    await s.lifecycle.recordMoveOut(c.manager, l.id, { moveOutDate: lastDay });
    await runLeaseEvents(ctx, b, c.companyId);
    return { lease: l, lastDay };
  }

  it('credits the unused days where the break clause allows, pays open lines from the prepayment, and refunds the rest with two people', async () => {
    const { lease: l, lastDay } = await endedEarly(true);
    const taxBefore = await taxItemsOf(ctx, c.companyId, l.id);
    const charges = [{ description: 'Agreed termination charge', amountMinor: 50_000 }];
    const preview = await t.termination.preview(c.manager, l.id, { charges, deductions: [] });
    expect(preview.breakClauseCreditsUnusedDays).toBe(true);
    expect(preview.unusedDays.length).toBe(1);
    const u = preview.unusedDays[0]!;
    expect(u.unusedDays).toBe(
      daysBetween(parseBusinessDate(lastDay), parseBusinessDate(u.periodEnd!)),
    );
    expect(u.creditMinor).toBe(Math.floor((100_000 * u.unusedDays) / u.periodDays + 0.5));
    expect(preview.appliedMinor).toBe(50_000);
    expect(preview.appliedLines.map((a) => a.amountMinor)).toEqual([50_000]);
    expect(preview.refundMinor).toBe(preview.creditLeftMinor);
    expect(preview.arrearsMinor).toBe(0);
    // Nothing is kept by a preview.
    expect(await leaseAccount(ctx, c.companyId, l.id, '2400')).toBe(0);

    const { terminationId, approvalId } = await t.termination.request(c.manager, l.id, {
      charges,
      deductions: [],
    });
    await expect(
      s.approvals.decide(c.manager, approvalId, { decision: 'approve' }),
    ).rejects.toThrow();
    await s.approvals.decide(c.accountant, approvalId, { decision: 'approve' });
    const [settled] = await t.termination.list(c.manager, { ids: [terminationId] });
    expect(settled).toMatchObject({
      status: 'settled',
      refundMinor: preview.refundMinor,
      appliedMinor: 50_000,
      unusedDaysCreditMinor: u.creditMinor,
    });
    expect(settled!.appliedLines.map((a) => a.amountMinor)).toEqual([50_000]);
    expect(await leaseAccount(ctx, c.companyId, l.id, '2400')).toBe(-preview.refundMinor);
    expect(await leaseAccount(ctx, c.companyId, l.id, '2010')).toBe(0);
    expect((await moneyCard(ctx, b, c.companyId, l.id)).creditMinor).toBe(0);

    // Paid outside the platform, with a reference and proof (D1).
    const proof = await uploadEvidence(ctx, (i) => t.termination.createUpload(c.manager, i));
    await t.termination.recordPaid(c.manager, terminationId, {
      paidOn: today,
      paidFrom: 'owner_account',
      reference: 'MOMO REFUND 1',
      proofUploadId: proof,
    });
    expect(await leaseAccount(ctx, c.companyId, l.id, '2400')).toBe(0);
    expect((await t.termination.list(c.manager, { ids: [terminationId] }))[0]!.status).toBe(
      'refund_paid',
    );
    // Rent tax on the refunded advance is not reversed (OQ-19).
    expect(await taxItemsOf(ctx, c.companyId, l.id)).toEqual(taxBefore);
    expect((await b.subledger.check(c.companyId)).mismatches).toEqual([]);
  });

  it('credits nothing for the last month without the break clause’s credit, and refunds only what is left after deductions', async () => {
    const { lease: l } = await endedEarly(false);
    const deductions = [{ description: 'Cleaning', amountMinor: 20_000 }];
    const preview = await t.termination.preview(c.manager, l.id, { charges: [], deductions });
    expect(preview).toMatchObject({
      breakClauseCreditsUnusedDays: false,
      unusedDaysCreditMinor: 0,
    });
    expect(preview.refundMinor).toBe(preview.creditLeftMinor - 20_000);
    await expect(
      t.termination.preview(c.manager, l.id, {
        charges: [],
        deductions: [{ description: 'Too much', amountMinor: preview.creditLeftMinor + 1 }],
      }),
    ).rejects.toMatchObject({ code: 'termination.deductions_too_large' });
    const { terminationId, approvalId } = await t.termination.request(c.manager, l.id, {
      charges: [],
      deductions,
    });
    await s.approvals.decide(c.admin, approvalId, { decision: 'approve' });
    const [settled] = await t.termination.list(c.manager, { ids: [terminationId] });
    expect(settled).toMatchObject({
      status: 'settled',
      refundMinor: preview.refundMinor,
      deductionsMinor: 20_000,
    });
    expect(await leaseAccount(ctx, c.companyId, l.id, '4200')).toBe(-20_000);
    expect((await b.subledger.check(c.companyId)).mismatches).toEqual([]);
  });

  it('is only for a lease that ended before its end date', async () => {
    const l = await lease(c, { start: plusMonths(monthStart(today), -1) });
    await expect(
      t.termination.preview(c.manager, l.id, { charges: [], deductions: [] }),
    ).rejects.toMatchObject({ code: 'not_ended_early' });
  });
});

describe('AR-05 months paid ahead and the cap', () => {
  it('`off` records months paid ahead and flags nothing (OQ-28)', async () => {
    const c = await companyWithUnits('Advance Off Agency', 'AOF');
    const start = plusDays(today, 5);
    const l = await lease(c, { start, months: 24, cycle: 'two_yearly' });
    await transfer(c, l.id, 2_400_000, today);
    const [row] = await advanceOf(c, l.id);
    expect(row).toMatchObject({
      monthsAhead: 24,
      policy: 'off',
      ruleKey: 'advance_rent.max_months.over_six_months',
      limitMonths: 6,
      overLimit: true,
      flagged: false,
    });
    expect((await t.advance.complianceReport(c.accountant)).rows).toEqual([]);
  });

  it('`warn` flags the lease and lists it in the compliance report with the rule and its status', async () => {
    const c = await companyWithUnits('Advance Warn Agency', 'AWN');
    await setAdvancePolicy(ctx, c.companyId, 'warn');
    const within = await lease(c, { start: plusDays(today, 5) });
    await transfer(c, within.id, 600_000, today);
    const over = await lease(c, { start: plusDays(today, 5) });
    await transfer(c, over.id, 900_000, today);
    expect((await advanceOf(c, within.id))[0]).toMatchObject({ monthsAhead: 6, flagged: false });
    expect((await advanceOf(c, over.id))[0]).toMatchObject({ monthsAhead: 9, flagged: true });
    const report = await t.advance.complianceReport(c.accountant);
    expect(report.policy).toBe('warn');
    expect(report.rows.map((r) => [r.leaseId, r.monthsAhead, r.limitMonths])).toEqual([
      [over.id, 9, 6],
    ]);
    expect(report.rows[0]!.rule).toMatchObject({
      key: 'advance_rent.max_months.over_six_months',
      verificationStatus: 'unverified',
    });
    const page = await t.advance.leaseAdvance(c.manager, over.id);
    expect(page).toMatchObject({
      policy: 'warn',
      limitMonths: 6,
      monthsAheadNow: 9,
      overLimitNow: true,
    });
    expect(page.flaggedPayments.length).toBe(1);
    expect(page.payments.length).toBe(1);
  });

  it('`block` refuses cash and transfers over the cap, and flags provider money that arrives anyway (decision 4)', async () => {
    const c = await companyWithUnits('Advance Block Agency', 'ABK');
    await setAdvancePolicy(ctx, c.companyId, 'block');
    const l = await lease(c, { start: plusDays(today, 5) });
    const proof = await uploadMoneyProof(ctx, b, c.manager, 'transfer_proof');
    await expect(
      b.money.recordTransfer(c.manager, {
        leaseId: l.id,
        receivedInto: 'owner_account',
        amountMinor: 700_000,
        receivedOn: today,
        proofUploadId: proof,
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'advance_over_limit',
      details: { maxMinor: '600000', limitMonths: '6' },
    });
    const photo = await uploadMoneyProof(ctx, b, c.manager, 'cash_photo');
    await expect(
      b.money.recordCash(c.manager, {
        leaseId: l.id,
        method: 'cash',
        amountMinor: 600_001,
        receivedOn: today,
        payerName: 'Payer',
        photoUploadId: photo,
      }),
    ).rejects.toMatchObject({ code: 'advance_over_limit' });
    // Exactly the cap is taken.
    await transfer(c, l.id, 600_000, today);
    expect((await advanceOf(c, l.id))[0]).toMatchObject({ monthsAhead: 6, flagged: false });
    // Money a provider confirmed is never refused: it is recorded and flagged for a person.
    await b.money.recordProviderPayment(c.companyId, {
      leaseId: l.id,
      amountMinor: 200_000,
      receivedOn: today,
    });
    const rows = await advanceOf(c, l.id);
    expect(rows[1]).toMatchObject({
      monthsAhead: 8,
      policy: 'block',
      overLimit: true,
      flagged: true,
    });
    expect((await t.advance.complianceReport(c.accountant)).rows.length).toBe(1);
  });
});

describe('AR-06 the paid-until prompt', () => {
  it('prompts once per lease and paid-until date when it is 90 days away: the manager by email, the tenant where consent is recorded', async () => {
    const c = await companyWithUnits('Prompt Agency', 'PRM');
    const consented = await lease(c, {
      start: plusDays(today, 2),
      phone: '+233200000781',
      consent: true,
    });
    const silent = await lease(c, { start: plusDays(today, 2), phone: '+233200000782' });
    for (const l of [consented, silent]) await transfer(c, l.id, 300_000, today);
    const paidUntil = (await moneyCard(ctx, b, c.companyId, consented.id)).paidUntil!;
    const day = plusDays(paidUntil, -90);
    expect(await t.advance.runPaidUntilPrompts(c.companyId, plusDays(day, -1))).toBe(0);
    expect(await t.advance.runPaidUntilPrompts(c.companyId, day)).toBe(2);
    expect(await t.advance.runPaidUntilPrompts(c.companyId, day)).toBe(0);
    expect(await t.advance.runPaidUntilPrompts(c.companyId, plusDays(day, 3))).toBe(0);
    await deliverMessages(ctx, s, c.companyId);
    const messages = (await messagesOf(ctx, c.companyId)).filter((m) =>
      m.body.includes('paid until'),
    );
    // The tenant's messages: everything not sent to staff.
    const tenantMessages = messages.filter((m) => m.recipient_type !== 'staff');
    expect(tenantMessages.map((m) => m.status).sort()).toEqual(['not_sent', 'sent']);
    expect(tenantMessages.find((m) => m.status === 'not_sent')!.reason).toBe('no_consent');
    expect(messages.filter((m) => m.recipient_type === 'staff').length).toBeGreaterThanOrEqual(2);
    const list = await on(day, () => t.advance.paidUntilEnding(c.manager));
    expect(list.map((r) => [r.paidUntil, r.daysLeft, r.promptedOn])).toEqual([
      [paidUntil, 90, day],
      [paidUntil, 90, day],
    ]);
  });
});

async function on<T>(date: string, fn: () => Promise<T>): Promise<T> {
  const ms = daysBetween(parseBusinessDate(today), parseBusinessDate(date)) * DAY;
  ctx.clock.advance(ms);
  try {
    return await fn();
  } finally {
    ctx.clock.advance(-ms);
  }
}
