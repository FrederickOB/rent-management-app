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
  billedLease,
  billingServices,
  journalSum,
  moneyCompany,
  runLeaseEvents,
  type BillingServices,
} from './support/billing';
import {
  feeTermsFrom,
  reportingMoneyServices,
  type ReportingMoneyServices,
} from './support/reporting-money';
import { taxServices, type TaxServices } from './support/tax';
import {
  propertyWithUnits,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

/**
 * AC-02, the M9 review's fee scenarios (must-fix 1) against the real database: fees tied to the
 * allocations they were charged on. Each scenario broke the old pooled guard; each ends with the
 * fees posted (5100) equal to the rate on the money still allocated to rent and service charge,
 * and the nightly check finding nothing. Every test makes its own company; dates are counted from
 * the test clock, so the file passes on any day.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let r: ReportingMoneyServices;
let today: string;
const DAY = 86_400_000;
const LONG_AGO = '2024-01-01';

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const endAfter = (from: string, n: number) => plusDays(plusMonths(from, n), -1);
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

const system = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withCompany(ctx.database, { companyId, actorKind: 'system' }, fn);

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
  units: string[];
  next: number;
};

let partCount = 0;
async function agency(
  name: string,
  termsFrom: string | null,
  options: { use?: 'residential' | 'commercial' } = {},
): Promise<Agency> {
  const c = await moneyCompany(ctx, s, 'agency', name);
  const ownerId = (
    await s.owners.create(c.admin, { kind: 'individual', displayName: `${name} owner` })
  ).id;
  partCount += 1;
  const property = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: `R${String(partCount).padStart(2, '0')}`,
    ownerId,
    ...(options.use === 'commercial' ? { use: 'commercial' as const } : {}),
    units: [
      options.use === 'commercial'
        ? { unitType: 'office', count: 4 }
        : { unitType: 'apartment', count: 4, bedrooms: 2 },
    ],
  });
  await asSuperuser(
    ctx,
    `update property_ownership set effective_from = $2::date where company_id = $1`,
    [c.companyId, LONG_AGO],
  );
  if (termsFrom)
    await feeTermsFrom(ctx, c.companyId, ownerId, { kind: 'percentage', rateBps: 1000 }, termsFrom);
  return { ...c, ownerId, units: Object.values(property.units), next: 0 };
}

let tenantCount = 0;
async function lease(
  c: Agency,
  input: { start: string; rent?: number; months?: number; company?: boolean },
) {
  tenantCount += 1;
  const tenantId = (
    await s.tenants.create(
      c.manager,
      input.company
        ? {
            kind: 'company',
            displayName: `Fee Co ${tenantCount}`,
            legalName: `Fee Co ${tenantCount} Limited`,
          }
        : { kind: 'individual', displayName: `Fee Review Tenant ${tenantCount}` },
    )
  ).tenant.id;
  return billedLease(ctx, s, b, c.manager, {
    unitId: c.units[c.next++]!,
    tenantId,
    startDate: input.start,
    endDate: endAfter(input.start, input.months ?? 12),
    monthlyRentMinor: input.rent ?? 100_000,
    cycle: 'monthly',
    ...(input.company ? { use: 'commercial' as const } : {}),
    signedOn: plusDays(input.start, -1),
    billingStartDate: input.start,
  });
}

const pay = (c: Agency, leaseId: string, amountMinor: number, receivedOn = today) =>
  b.money.recordProviderPayment(c.companyId, { leaseId, amountMinor, receivedOn });

/** The fees posted on these leases (5100). */
const feesPosted = (c: Agency, leaseIds: readonly string[]) =>
  journalSum(
    ctx,
    c.companyId,
    `l.account_code = '5100' and l.lease_id in (${leaseIds.map((id) => `'${id}'`).join(',')})`,
  );

/** Money still allocated to rent and service charge on these leases. */
async function liveBase(c: Agency, leaseIds: readonly string[]): Promise<number> {
  const rows = await system(c.companyId, (tx) =>
    tx.execute<{ total: string }>(
      sql`select coalesce(sum(a.amount_minor), 0)::text as total from allocation a
          join invoice_line il on il.company_id = a.company_id and il.id = a.invoice_line_id
          where a.lease_id = any(${`{${leaseIds.join(',')}}`}::uuid[])
            and il.kind in ('rent', 'service_charge')
            and a.source in ('payment', 'deposit', 'withholding')`,
    ),
  );
  return Number(rows.rows[0]!.total);
}

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

async function linesOf(companyId: string, leaseId: string) {
  return system(companyId, async (tx) => (await b.engine.load(tx, companyId, leaseId)).lines);
}

const checkClean = async (c: Agency) =>
  expect((await r.fees.check(c.companyId, { alert: false })).mismatches).toEqual([]);

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  r = reportingMoneyServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
});

afterAll(async () => {
  await ctx?.close();
});

describe('AC-02 fees tied to allocations: the review scenarios (must-fix 1)', () => {
  it('★ terms starting after earlier receipts, then withholding: released money is charged once, when it pays a month', async () => {
    // Two months paid in full the day before the terms began: no fee on them.
    const c = await agency('Fees Late Terms', null, { use: 'commercial' });
    await feeTermsFrom(ctx, c.companyId, c.ownerId, { kind: 'percentage', rateBps: 1000 }, today);
    const start = plusMonths(monthStart(today), -1);
    const l = await lease(c, { start, rent: 1_000_000, company: true });
    await pay(c, l.id, 2_000_000, plusDays(today, -1));
    expect(await feesPosted(c, [l.id])).toBe(0);
    // The tenant then advises GH₵1,500 withheld on this month: the withholding settles it, and
    // as much of the cash comes back as credit. The withholding carries a fee; the cash it
    // releases carried none, so nothing is taken back.
    const [line] = (await linesOf(c.companyId, l.id)).filter(
      (x) => x.kind === 'rent' && x.periodStart === monthStart(today),
    );
    await t.withholding.record(c.manager, {
      leaseId: l.id,
      valueDate: today,
      lines: [{ lineId: line!.id, amountMinor: 150_000 }],
    });
    expect(await feesPosted(c, [l.id])).toBe(15_000);
    // Next month draws the credit: rent settled under the terms, charged once.
    const next = plusMonths(monthStart(today), 1);
    await on(next, async () => {
      await b.invoicing.generateAll(c.companyId, next);
      await b.invoicing.accrueAll(c.companyId, next);
    });
    expect(await feesPosted(c, [l.id])).toBe(30_000);
    await checkClean(c);
  });

  it('★ a reversal with a second payment’s credit: the month it redraws carries its fee', async () => {
    const c = await agency('Fees Redraw', LONG_AGO);
    const l = await lease(c, { start: plusMonths(today, -1) });
    const first = await pay(c, l.id, 100_000);
    await pay(c, l.id, 150_000);
    expect(await feesPosted(c, [l.id])).toBe(20_000);
    // The first payment is charged back: its month reopens and the second payment's credit pays
    // it. The first payment's fee comes back; the redrawn month is charged.
    await chargeback(c.companyId, l.id, first.paymentId);
    expect(await liveBase(c, [l.id])).toBe(150_000);
    expect(await feesPosted(c, [l.id])).toBe(15_000);
    const redraw = await system(c.companyId, (tx) =>
      tx
        .select()
        .from(schema.managementFee)
        .where(sql`lease_id = ${l.id} and source = 'credit_draw'`),
    );
    expect(redraw.map((f) => [f.baseMinor, f.feeMinor])).toEqual([[50_000, 5_000]]);
    await checkClean(c);
  });

  it('★ a refund of a drawn surplus: cancelling the month takes its fee back before the refund', async () => {
    const c = await agency('Fees Drawn Refund', LONG_AGO);
    // A month before today: two months owed, and the third not yet invoiced (14 days ahead) on any
    // day of the month (founder-approved setup fix, 2026-11-19).
    const start = plusMonths(today, -1);
    const l = await lease(c, { start });
    await pay(c, l.id, 300_000);
    expect(await feesPosted(c, [l.id])).toBe(20_000);
    const next = plusMonths(start, 2);
    await on(plusDays(next, 3), async () => {
      // Next month starts and draws the GH₵1,000 of credit: charged.
      await b.invoicing.generateAll(c.companyId, next);
      await b.invoicing.accrueAll(c.companyId, next);
      expect(await feesPosted(c, [l.id])).toBe(30_000);
      // The drawn month is credited in full (agreed: the tenant had left), which releases the
      // credit it drew; the tenant's move-out is recorded and the credit refunded.
      const drawn = (await linesOf(c.companyId, l.id)).find(
        (x) => x.kind === 'rent' && x.periodStart === next,
      )!;
      const creditNote = await b.money.requestCreditNote(c.manager, drawn.id, {
        amountMinor: 100_000,
        reason: 'Tenant left at the end of last month',
      });
      await s.approvals.decide(c.admin, creditNote, { decision: 'approve' });
      expect(await feesPosted(c, [l.id])).toBe(20_000);
      await s.lifecycle.recordMoveOut(c.manager, l.id, { moveOutDate: plusDays(next, -1) });
      await runLeaseEvents(ctx, b, c.companyId);
      const { approvalId, terminationId } = await t.termination.request(c.manager, l.id, {
        charges: [],
        deductions: [],
      });
      await s.approvals.decide(c.accountant, approvalId, { decision: 'approve' });
      const [settled] = await t.termination.list(c.manager, { ids: [terminationId] });
      expect(settled!.refundMinor).toBe(100_000);
    });
    expect(await liveBase(c, [l.id])).toBe(200_000);
    expect(await feesPosted(c, [l.id])).toBe(20_000);
    const back = await system(c.companyId, (tx) =>
      tx
        .select()
        .from(schema.managementFee)
        .where(sql`lease_id = ${l.id} and source = 'refund'`),
    );
    expect(back.map((f) => f.feeMinor)).toEqual([-10_000]);
    await checkClean(c);
  });

  it('★ a credit-note redraw: the released money is charged again only where it pays a month', async () => {
    const c = await agency('Fees Credit Note', LONG_AGO);
    const l = await lease(c, { start: plusMonths(today, -1) });
    await pay(c, l.id, 150_000);
    expect(await feesPosted(c, [l.id])).toBe(15_000);
    // A GH₵500 credit note on the first month releases that much of the payment, which pays
    // the half of this month still owed.
    const [firstMonth] = (await linesOf(c.companyId, l.id))
      .filter((x) => x.kind === 'rent')
      .sort((x, y) => (x.periodStart! < y.periodStart! ? -1 : 1));
    const requestId = await b.money.requestCreditNote(c.manager, firstMonth!.id, {
      amountMinor: 50_000,
      reason: 'Agreed discount',
    });
    await s.approvals.decide(c.admin, requestId, { decision: 'approve' });
    expect(await liveBase(c, [l.id])).toBe(150_000);
    expect(await feesPosted(c, [l.id])).toBe(15_000);
    await checkClean(c);
  });

  it('★ a renewal chain: credit a credit note released, carried to the renewal and drawn there, is charged once', async () => {
    const c = await agency('Fees Renewal', LONG_AGO);
    const start = plusMonths(today, -11);
    const end = endAfter(start, 12);
    const old = await lease(c, { start });
    await pay(c, old.id, 12 * 100_000);
    expect(await feesPosted(c, [old.id])).toBe(120_000);
    const fifth = (await linesOf(c.companyId, old.id)).find(
      (x) => x.kind === 'rent' && x.periodStart === plusMonths(start, 4),
    )!;
    const requestId = await b.money.requestCreditNote(c.manager, fifth.id, {
      amountMinor: 70_000,
      reason: 'Agreed discount for repairs',
    });
    await s.approvals.decide(c.admin, requestId, { decision: 'approve' });
    // The released GH₵700 waits as credit: its fee came back.
    expect(await feesPosted(c, [old.id])).toBe(113_000);
    const renewal = await s.leases.offerRenewal(c.manager, old.id);
    const scan = await uploadLeaseFile(ctx, s, c.manager);
    const staged = await s.documents.stageEvidenceUpload(
      { companyId: c.companyId, personId: c.manager.personId },
      scan,
      { purpose: 'lease_file', contentTypes: ['application/pdf'], maxBytes: 20_000_000 },
    );
    await withCompany(
      ctx.database,
      { companyId: c.companyId, personId: c.manager.personId, actorKind: 'staff' },
      async (tx) => {
        const documentId = await s.documents.recordStagedEvidence(tx, staged, 'lease_scan');
        await s.lifecycle.markSigned(tx, {
          leaseId: renewal.id,
          signedAt: ctx.clock.now(),
          source: 'paper',
          signedDocumentId: documentId,
        });
      },
    );
    await runLeaseEvents(ctx, b, c.companyId);
    const renewalStart = plusDays(end, 1);
    await on(renewalStart, async () => {
      await s.lifecycle.runTransitions(c.companyId, renewalStart);
      await runLeaseEvents(ctx, b, c.companyId);
      await b.invoicing.generateAll(c.companyId, renewalStart);
      await b.invoicing.accrueAll(c.companyId, renewalStart);
    });
    // The renewal's first month drew the carried credit: charged there, once.
    expect(await liveBase(c, [old.id, renewal.id])).toBe(1_200_000);
    expect(await feesPosted(c, [old.id, renewal.id])).toBe(120_000);
    expect(await feesPosted(c, [renewal.id])).toBe(7_000);
    await checkClean(c);
  });

  it('the nightly check finds a fee posted without its allocation’s share, and an owner book whose 5100 disagrees', async () => {
    const c = await agency('Fees Check Review', LONG_AGO);
    const l = await lease(c, { start: monthStart(today) });
    await pay(c, l.id, 100_000);
    await checkClean(c);
    await asSuperuser(ctx, `update allocation_fee set fee_minor = 9000 where lease_id = $1`, [
      l.id,
    ]);
    const { mismatches } = await r.fees.check(c.companyId, { alert: false });
    expect(mismatches).toEqual([
      expect.objectContaining({
        key: `P14:${(await paymentIdOf(c, l.id))!}`,
        problems: ['allocations'],
      }),
    ]);
  });
});

async function paymentIdOf(c: Agency, leaseId: string) {
  const [row] = await system(c.companyId, (tx) =>
    tx
      .select({ id: schema.payment.id })
      .from(schema.payment)
      .where(sql`lease_id = ${leaseId}`),
  );
  return row?.id;
}
