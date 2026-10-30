import { schema, sql, withCompany } from '@rent/db';
import { ageBucket } from '@rent/domain/billing';
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
  approvedCash,
  approvedTransfer,
  billedLease,
  billingServices,
  journalSum,
  leaseAccount,
  moneyCard,
  moneyCompany,
  runLeaseEvents,
  type BillingServices,
} from './support/billing';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

/**
 * Billing against the real database (CLAUDE.md section 12; M4a plan section 6): invoices from
 * lease terms, accrual and the two-year advance, VAT, arrears, period locks, the lease events and
 * owner changes. Each test makes its own lease on its own unit.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let today: string;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let ownerA: string;
let ownerVat: string;
let elg: { propertyId: string; units: Record<string, string> };
let osu: { propertyId: string; units: Record<string, string> };
let unitIndex = 0;
const DAY = 86_400_000;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const endAfter = (from: string, n: number) => plusDays(plusMonths(from, n), -1);
const nextUnit = (p: { units: Record<string, string> }) => Object.values(p.units)[unitIndex++]!;

async function tenant(name: string, kind: 'individual' | 'company' = 'individual') {
  return (
    await s.tenants.create(agency.manager, {
      kind,
      displayName: name,
      ...(kind === 'company' ? { legalName: `${name} Limited` } : {}),
    })
  ).tenant.id;
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

async function invoicesOf(leaseId: string) {
  return withCompany(
    ctx.database,
    { companyId: agency.companyId, actorKind: 'system' },
    async (tx) => {
      const invoices = await tx
        .select()
        .from(schema.invoice)
        .where(sql`${schema.invoice.leaseId} = ${leaseId}`)
        .orderBy(schema.invoice.number);
      const lines = await tx
        .select()
        .from(schema.invoiceLine)
        .where(sql`${schema.invoiceLine.leaseId} = ${leaseId}`)
        .orderBy(schema.invoiceLine.createdAt, schema.invoiceLine.position);
      return invoices.map((i) => ({
        ...i,
        lines: lines.filter((l) => l.invoiceId === i.id).sort((x, y) => x.position - y.position),
      }));
    },
  );
}

const generate = (date: string) =>
  on(date, async () => {
    await b.invoicing.generateAll(agency.companyId, date);
    await b.invoicing.accrueAll(agency.companyId, date);
  });

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  agency = await moneyCompany(ctx, s, 'agency', 'Billing Agency');
  ownerA = (await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Owner A' })).id;
  ownerVat = (
    await s.owners.create(agency.admin, {
      kind: 'company',
      displayName: 'Owner VAT Ltd',
      legalName: 'Owner VAT Limited',
      vatRegistered: true,
      tin: 'C0012345678',
    })
  ).id;
  elg = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: 'ELG',
    ownerId: ownerA,
    units: [{ unitType: 'apartment', count: 40, bedrooms: 2 }],
  });
  osu = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: 'OSU',
    ownerId: ownerVat,
    use: 'mixed',
    units: [
      { unitType: 'shop', count: 10 },
      { unitType: 'apartment', count: 4, bedrooms: 2 },
    ],
  });
});

afterAll(async () => {
  await ctx?.close();
});

describe('BC-01 invoices from lease terms', () => {
  it('issues the deposit at signing and each cycle 14 days ahead, once, with the reference', async () => {
    const start = plusDays(today, 20);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(elg),
      tenantId: await tenant('Monthly Ahead'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 150_000,
      depositMinor: 300_000,
      cycle: 'monthly',
      signedOn: today,
    });
    let invoices = await invoicesOf(lease.id);
    expect(invoices.map((i) => [i.kind, i.dueDate, i.issueDate])).toEqual([
      ['deposit', start, today],
    ]);
    const card = await moneyCard(ctx, b, agency.companyId, lease.id);
    expect(invoices[0]!.paymentReference).toBe(card.paymentReference);
    // Six days on, the first cycle is 14 days away: it is issued, and a rerun issues nothing more.
    await generate(plusDays(today, 6));
    await generate(plusDays(today, 6));
    invoices = await invoicesOf(lease.id);
    expect(invoices.map((i) => [i.kind, i.dueDate, i.cycleStart])).toEqual([
      ['deposit', start, null],
      ['cycle', start, start],
    ]);
    expect(invoices[1]!.lines.map((l) => [l.kind, l.periodStart, l.amountMinor])).toEqual([
      ['rent', start, 150_000],
    ]);
    expect(invoices.map((i) => i.number)).toEqual([invoices[0]!.number, invoices[0]!.number + 1]);
  });

  it('bundles 3, 6 or 12 periods per cycle, rent before service charge, the advance first, with escalation', async () => {
    const start = plusDays(today, 1);
    const quarterly = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(elg),
      tenantId: await tenant('Quarterly'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 100_000,
      serviceChargeMonthlyMinor: 10_000,
      cycle: 'quarterly',
      steps: [{ effectiveFrom: plusMonths(start, 2), monthlyRentMinor: 120_000 }],
      signedOn: today,
    });
    const [first] = await invoicesOf(quarterly.id);
    expect(first!.periodFrom).toBe(start);
    expect(first!.periodTo).toBe(endAfter(start, 3));
    expect(first!.lines.map((l) => [l.kind, l.periodStart, l.amountMinor])).toEqual([
      ['rent', start, 100_000],
      ['service_charge', start, 10_000],
      ['rent', plusMonths(start, 1), 100_000],
      ['service_charge', plusMonths(start, 1), 10_000],
      ['rent', plusMonths(start, 2), 120_000],
      ['service_charge', plusMonths(start, 2), 10_000],
    ]);
    for (const [cycle, months] of [
      ['six_monthly', 6],
      ['annual', 12],
    ] as const) {
      const lease = await billedLease(ctx, s, b, agency.manager, {
        unitId: nextUnit(elg),
        tenantId: await tenant(`Cycle ${cycle}`),
        startDate: start,
        endDate: endAfter(start, 24),
        monthlyRentMinor: 100_000,
        cycle,
        signedOn: today,
      });
      const [invoice] = await invoicesOf(lease.id);
      expect(invoice!.lines).toHaveLength(months);
    }
    // An initial advance of 18 months is the first invoice, whatever the cycle.
    const advance = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(elg),
      tenantId: await tenant('Advance 18'),
      startDate: start,
      endDate: endAfter(start, 24),
      monthlyRentMinor: 100_000,
      cycle: 'six_monthly',
      initialAdvanceMonths: 18,
      signedOn: today,
    });
    const [advanceInvoice] = await invoicesOf(advance.id);
    expect(advanceInvoice!.lines).toHaveLength(18);
    expect(advanceInvoice!.periodTo).toBe(endAfter(start, 18));
  });

  it('bills a paper lease from its billing start: the default, an earlier period, or a later one', async () => {
    const start = plusMonths(today, -5);
    const unitDefault = nextUnit(elg);
    const byDefault = await billedLease(ctx, s, b, agency.manager, {
      unitId: unitDefault,
      tenantId: await tenant('Paper Default'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 50_000,
      depositMinor: 100_000,
      cycle: 'monthly',
      signedOn: plusDays(start, -3),
    });
    const card = await moneyCard(ctx, b, agency.companyId, byDefault.id);
    // The first period starting on or after today; no deposit invoice for a later start.
    expect(card.billingStartDate).toBe(today);
    expect((await invoicesOf(byDefault.id)).map((i) => [i.kind, i.cycleStart])).toEqual([
      ['cycle', today],
    ]);
    const back = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(elg),
      tenantId: await tenant('Paper Back'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 50_000,
      depositMinor: 100_000,
      cycle: 'monthly',
      signedOn: plusDays(start, -3),
      billingStartDate: start,
    });
    const backInvoices = await invoicesOf(back.id);
    expect(backInvoices.map((i) => i.kind)).toEqual([
      'deposit',
      'cycle',
      'cycle',
      'cycle',
      'cycle',
      'cycle',
      'cycle',
    ]);
    // Six started periods are owed at once: 1100 equals them, accrued at signing.
    expect(await leaseAccount(ctx, agency.companyId, back.id, '1100')).toBe(6 * 50_000);
    await expect(
      s.leases.recordPaper(agency.manager, {
        unitId: nextUnit(elg),
        tenantId: await tenant('Paper Bad'),
        startDate: start,
        endDate: endAfter(start, 12),
        monthlyRentMinor: 50_000,
        cycle: 'monthly',
        noticeDays: 30,
        parties: [{ role: 'tenant', name: 'Paper Bad' }],
        scanUploadId: await uploadLeaseFile(ctx, s, agency.manager),
        signedOn: plusDays(start, -3),
        billingStartDate: plusDays(start, 3),
      }),
    ).rejects.toMatchObject({ code: 'billing_start' });
  });

  it('invoices each held-over month the day it starts, and nothing after a lease ends', async () => {
    const start = plusMonths(today, -12);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(elg),
      tenantId: await tenant('Holding Over'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 60_000,
      cycle: 'monthly',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    // The term is over today; holding over adds this month, which is invoiced the day it starts.
    await s.lifecycle.runTransitions(agency.companyId, today);
    await generate(today);
    const invoices = await invoicesOf(lease.id);
    expect(invoices.at(-1)).toMatchObject({
      holdingOver: true,
      cycleStart: today,
      issueDate: today,
    });
    expect(invoices).toHaveLength(13);
  });

  it('cancels the lines of periods after an early move-out with a system credit note naming the end', async () => {
    const start = plusMonths(today, -1);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(elg),
      tenantId: await tenant('Moves Out'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 90_000,
      cycle: 'quarterly',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    // Paid for the quarter in cash, then the tenant leaves today.
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: lease.id,
      amountMinor: 270_000,
      receivedOn: today,
    });
    await s.lifecycle.recordMoveOut(agency.manager, lease.id, { moveOutDate: today });
    await runLeaseEvents(ctx, b, agency.companyId);
    const [quarter] = await invoicesOf(lease.id);
    const detail = await b.read.invoice(agency.manager, quarter!.id);
    // The month starting after today is cancelled, its money returned to the tenant's credit.
    const after = detail.lines.filter((l) => l.periodStart! > today);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ netMinor: 0, creditedMinor: 90_000, outstandingMinor: 0 });
    expect(detail.notes).toEqual([expect.stringMatching(/^The lease ended on /)]);
    const card = await moneyCard(ctx, b, agency.companyId, lease.id);
    expect(card.creditMinor).toBe(90_000);
    // Nothing more is invoiced or charged for this lease.
    await generate(plusMonths(today, 2));
    expect(await invoicesOf(lease.id)).toHaveLength(1);
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '4000')).toBe(-180_000);
  });

  it('does not bill a property with more than one owner on the day, and says why (decision 5)', async () => {
    const joint = await propertyWithUnits(s, agency.manager, {
      areaCode: 'ACC',
      propertyPart: 'JNT',
      ownerId: ownerA,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 2 }],
    });
    const tomorrow = plusDays(today, 1);
    const ownerB = (
      await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Owner B' })
    ).id;
    await withCompany(ctx.database, { companyId: agency.companyId, actorKind: 'system' }, (tx) =>
      tx.insert(schema.propertyOwnership).values(
        [ownerA, ownerB].map((ownerId) => ({
          companyId: agency.companyId,
          propertyId: joint.propertyId,
          ownerId,
          shareBps: 5_000,
          effectiveFrom: tomorrow,
        })),
      ),
    );
    await on(tomorrow, async () => {
      const lease = await billedLease(ctx, s, b, agency.manager, {
        unitId: Object.values(joint.units)[0]!,
        tenantId: await tenant('Joint'),
        startDate: tomorrow,
        endDate: endAfter(tomorrow, 12),
        monthlyRentMinor: 80_000,
        depositMinor: 80_000,
        cycle: 'monthly',
        signedOn: tomorrow,
      });
      expect(await invoicesOf(lease.id)).toEqual([]);
      const card = await moneyCard(ctx, b, agency.companyId, lease.id);
      expect(card.notBilledReason).toBe('joint_owners');
      await expect(
        approvedCash(ctx, s, b, agency.manager, agency.admin, {
          leaseId: lease.id,
          amountMinor: 80_000,
          receivedOn: tomorrow,
        }),
      ).rejects.toMatchObject({ code: 'joint_owners' });
    });
  });
});

describe('AR-01 a two-year advance month by month', () => {
  it('recognises GH₵1,500 a month from GH₵36,000 paid ahead, with paid-until and unearned rent right each month', async () => {
    const start = plusDays(today, 3);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(elg),
      tenantId: await tenant('Two Year'),
      startDate: start,
      endDate: endAfter(start, 24),
      monthlyRentMinor: 150_000,
      cycle: 'annual',
      initialAdvanceMonths: 24,
      signedOn: today,
    });
    await approvedTransfer(ctx, s, b, agency.manager, agency.accountant, {
      leaseId: lease.id,
      receivedInto: 'owner_account',
      amountMinor: 3_600_000,
      receivedOn: today,
      senderReference: 'MOMO 2YR',
    });
    const end = endAfter(start, 24);
    const prepaid = 3_600_000;
    let card = await moneyCard(ctx, b, agency.companyId, lease.id);
    expect(card).toMatchObject({ paidUntil: end, unearnedRentMinor: prepaid, creditMinor: 0 });
    expect(-(await leaseAccount(ctx, agency.companyId, lease.id, '2010'))).toBe(prepaid);
    for (let month = 0; month < 24; month += 1) {
      const date = plusMonths(start, month);
      await on(date, async () => {
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
      expect(recognised, `month ${month}`).toBe(150_000 * (month + 1));
      expect(card.paidUntil, `month ${month}`).toBe(end);
      expect(card.unearnedRentMinor, `month ${month}`).toBe(prepaid - 150_000 * (month + 1));
      expect(-(await leaseAccount(ctx, agency.companyId, lease.id, '4000'))).toBe(
        150_000 * (month + 1),
      );
    }
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '1100')).toBe(0);
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
  });
});

describe('CT-04 VAT on commercial invoices', () => {
  it('charges VAT, NHIL and GETFund on each rent and service-charge line, rounded once, with the rule used', async () => {
    const start = plusDays(today, 2);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: osu.units['ACC-OSU-B1-01']!,
      tenantId: await tenant('Pharmacy', 'company'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 333_333,
      serviceChargeMonthlyMinor: 10_001,
      cycle: 'monthly',
      use: 'commercial',
      signedOn: today,
    });
    const [invoice] = await invoicesOf(lease.id);
    expect(invoice!.lines.map((l) => [l.kind, l.amountMinor, l.rateBps])).toEqual([
      ['rent', 333_333, null],
      ['vat', 50_000, 1_500],
      ['nhil', 8_333, 250],
      ['getfund', 8_333, 250],
      ['service_charge', 10_001, null],
      ['vat', 1_500, 1_500],
      ['nhil', 250, 250],
      ['getfund', 250, 250],
    ]);
    const rule = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ id: string }>(sql`select id from rule where key = 'vat.commercial_rent'`),
    );
    expect(new Set(invoice!.lines.filter((l) => l.rateBps).map((l) => l.ruleId))).toEqual(
      new Set([rule.rows[0]!.id]),
    );
    expect(invoice!.billedFromTin).toMatch(/\*/);
    // The VAT is owed to GRA from the invoice (P32): 1100 on the tax lines, 2210 for the owner.
    expect(await leaseAccount(ctx, agency.companyId, lease.id, '2210')).toBe(
      -(50_000 + 8_333 * 2 + 1_500 + 500),
    );
    const detail = await b.read.invoice(agency.manager, invoice!.id);
    expect(detail.unverifiedRules).toBe(true);
    expect(detail.warnings).toEqual([expect.stringContaining('not verified')]);
  });

  it('charges no VAT on a dwelling, even for a VAT-registered owner', async () => {
    const start = plusDays(today, 2);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: osu.units['ACC-OSU-B1-11']!,
      tenantId: await tenant('Flat Above Shops'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 200_000,
      cycle: 'monthly',
      use: 'residential',
      signedOn: today,
    });
    const [invoice] = await invoicesOf(lease.id);
    expect(invoice!.lines.map((l) => l.kind)).toEqual(['rent']);
  });

  it('issues the invoices an advance pays for at once, so the payment is their tax point (decision 4)', async () => {
    const start = plusDays(today, 2);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: osu.units['ACC-OSU-B1-02']!,
      tenantId: await tenant('Advance Shop', 'company'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 100_000,
      cycle: 'monthly',
      use: 'commercial',
      signedOn: today,
    });
    expect(await invoicesOf(lease.id)).toHaveLength(1);
    // Three months with their VAT and levies: 3 x 120,000.
    await approvedTransfer(ctx, s, b, agency.manager, agency.accountant, {
      leaseId: lease.id,
      receivedInto: 'agency_account',
      amountMinor: 360_000,
      receivedOn: today,
    });
    const invoices = await invoicesOf(lease.id);
    expect(invoices.map((i) => i.cycleStart)).toEqual([
      start,
      plusMonths(start, 1),
      plusMonths(start, 2),
    ]);
    expect(invoices.every((i) => i.issueDate === today)).toBe(true);
    const card = await moneyCard(ctx, b, agency.companyId, lease.id);
    expect(card.creditMinor).toBe(0);
    expect(card.paidUntil).toBe(endAfter(start, 3));
  });
});

describe('BC-08 arrears ageing', () => {
  it('buckets overdue lines by days past due, as of today and as of a past date, by tenant, property and owner', async () => {
    const start = plusMonths(today, -4);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(elg),
      tenantId: await tenant('Ageing Tenant'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 40_000,
      cycle: 'monthly',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    const due = [0, 1, 2, 3].map((k) => plusMonths(start, k)).filter((d) => d < today);
    const expected: Record<string, number> = {};
    for (const d of due) {
      const bucket = ageBucket(d, today)!;
      expected[bucket] = (expected[bucket] ?? 0) + 40_000;
    }
    const byTenant = await b.read.arrears(agency.manager, { by: 'tenant' });
    const tenantRow = byTenant.rows.find((r) => r.leaseIds.includes(lease.id))!;
    expect(tenantRow.label).toBe('Ageing Tenant');
    for (const [bucket, amount] of Object.entries(expected))
      expect(tenantRow.buckets[bucket as keyof typeof tenantRow.buckets], bucket).toBe(amount);
    expect(tenantRow.oldestDueDate).toBe(start);
    for (const by of ['property', 'owner'] as const) {
      const arrears = await b.read.arrears(agency.manager, { by });
      expect(
        arrears.rows.find((r) => r.leaseIds.includes(lease.id)),
        by,
      ).toBeDefined();
    }
    // As of 45 days after the start, only the first line was due: 45 days late.
    const asOf = plusDays(start, 45);
    const past = await b.read.arrears(agency.manager, { by: 'tenant', asOf });
    const row = past.rows.find((r) => r.leaseIds.includes(lease.id))!;
    expect(row.totalMinor).toBe([0, 1].filter((k) => plusMonths(start, k) < asOf).length * 40_000);
    expect(row.buckets['31_60']).toBe(40_000);
    // A payment today does not change the past.
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: lease.id,
      amountMinor: 40_000,
      receivedOn: today,
    });
    const again = await b.read.arrears(agency.manager, { by: 'tenant', asOf });
    expect(again.rows.find((r) => r.leaseIds.includes(lease.id))!.totalMinor).toBe(row.totalMinor);
  });
});

describe('AC-04 accounting dates under a lock', () => {
  it('reports an entry dated in a locked month on the first open day, and the database refuses the month', async () => {
    const start = plusMonths(today, -1);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(elg),
      tenantId: await tenant('Locked Month'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 70_000,
      cycle: 'monthly',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    const bookId = (await invoicesOf(lease.id))[0]!.bookId;
    const month = `${today.slice(0, 7)}-01`;
    await withCompany(ctx.database, { companyId: agency.companyId, actorKind: 'system' }, (tx) =>
      b.posting.lockMonth(tx, { companyId: agency.companyId, bookId, month, source: 'manual' }),
    );
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: lease.id,
      amountMinor: 70_000,
      receivedOn: today,
    });
    const nextMonth = plusMonths(month, 1);
    const [entry] = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select()
          .from(schema.journalEntry)
          .where(
            sql`${schema.journalEntry.rule} = 'P06' and exists (select 1 from journal_line l
              where l.entry_id = ${schema.journalEntry.id} and l.lease_id = ${lease.id})`,
          ),
    );
    expect(entry).toMatchObject({ valueDate: today, accountingDate: nextMonth });
    // Its allocations take the same accounting date.
    const allocations = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select()
          .from(schema.allocation)
          .where(sql`${schema.allocation.entryId} = ${entry!.id}`),
    );
    expect(allocations.length).toBeGreaterThan(0);
    expect(new Set(allocations.map((a) => a.accountingDate))).toEqual(new Set([nextMonth]));
    // A statement of this month leaves it out; next month's has it.
    const thisMonth = await journalSum(
      ctx,
      agency.companyId,
      `l.lease_id = $1 and l.account_code = '1060' and e.accounting_date < $2`,
      [lease.id, nextMonth],
    );
    expect(thisMonth).toBe(0);
    const nextMonthToo = await journalSum(
      ctx,
      agency.companyId,
      `l.lease_id = $1 and l.account_code = '1060' and e.accounting_date < $2`,
      [lease.id, plusMonths(nextMonth, 1)],
    );
    expect(nextMonthToo).toBe(70_000);
    // The database refuses a line in the locked month, whatever the code does.
    const refused = await asOwner(
      ctx,
      `select count(*)::int as n from journal_line l join journal_entry e on e.id = l.entry_id
       where l.book_id = '${bookId}' and e.accounting_date >= '${month}' and e.accounting_date < '${nextMonth}'
         and e.posted_at > now() - interval '1 minute' and e.rule = 'P06'`,
    );
    expect(refused).toEqual([{ n: 0 }]);
  });
});

describe('P29 renewal carry-over', () => {
  it('moves each payment’s credit and the deposit to the renewal when it starts; arrears stay', async () => {
    const start = plusMonths(today, -11);
    const end = endAfter(start, 12);
    const old = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(elg),
      tenantId: await tenant('Renewing Tenant'),
      startDate: start,
      endDate: end,
      monthlyRentMinor: 100_000,
      depositMinor: 200_000,
      cycle: 'monthly',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    // Deposit and eleven months paid; the twelfth month will be owed.
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: old.id,
      amountMinor: 200_000 + 11 * 100_000,
      receivedOn: today,
    });
    // A credit note gives back 70,000 of a paid month: credit while the last month is unpaid.
    const lines = (await invoicesOf(old.id)).flatMap((i) => i.lines);
    const fifth = lines.find((l) => l.periodStart === plusMonths(start, 4))!;
    const requestId = await b.money.requestCreditNote(agency.manager, fifth.id, {
      amountMinor: 70_000,
      reason: 'Agreed discount for repairs',
    });
    await s.approvals.decide(agency.admin, requestId, { decision: 'approve' });
    await generate(plusDays(end, -13));
    // The renewal, signed now, starts the day after the end.
    const renewal = await s.leases.offerRenewal(agency.manager, old.id);
    const scan = await uploadLeaseFile(ctx, s, agency.manager);
    const staged = await s.documents.stageEvidenceUpload(
      { companyId: agency.companyId, personId: agency.manager.personId },
      scan,
      { purpose: 'lease_file', contentTypes: ['application/pdf'], maxBytes: 20_000_000 },
    );
    await withCompany(
      ctx.database,
      { companyId: agency.companyId, personId: agency.manager.personId, actorKind: 'staff' },
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
    await runLeaseEvents(ctx, b, agency.companyId);
    // The renewal asks no new deposit: the old lease's covers it.
    expect((await invoicesOf(renewal.id)).filter((i) => i.kind === 'deposit')).toEqual([]);
    const renewalStart = plusDays(end, 1);
    await on(renewalStart, async () => {
      await s.lifecycle.runTransitions(agency.companyId, renewalStart);
      await runLeaseEvents(ctx, b, agency.companyId);
      await b.invoicing.generateAll(agency.companyId, renewalStart);
      await b.invoicing.accrueAll(agency.companyId, renewalStart);
    });
    expect(await leaseAccount(ctx, agency.companyId, old.id, '2010')).toBe(0);
    expect(await leaseAccount(ctx, agency.companyId, old.id, '2100')).toBe(0);
    expect(-(await leaseAccount(ctx, agency.companyId, renewal.id, '2100'))).toBe(200_000);
    // The old lease's last month stays owed on its own invoice.
    expect(await leaseAccount(ctx, agency.companyId, old.id, '1100')).toBe(100_000);
    // The renewal's first month drew the carried credit, from the old payment.
    const renewalCard = await moneyCard(ctx, b, agency.companyId, renewal.id);
    expect(renewalCard.earnedUnpaidMinor).toBe(100_000 - 70_000);
    expect(renewalCard.depositHeldMinor).toBe(200_000);
    const carried = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select()
          .from(schema.creditCarryOver)
          .where(sql`${schema.creditCarryOver.leaseId} = ${renewal.id}`),
    );
    expect(carried.map((c) => [c.kind, c.amountMinor]).sort()).toEqual([
      ['credit', 70_000],
      ['deposit', 200_000],
    ]);
    expect((await b.subledger.check(agency.companyId)).mismatches).toEqual([]);
  });
});

describe('BC-01 cancelled before its start', () => {
  it('cancels every line of a signed lease cancelled with approval; money paid stays (P27 system)', async () => {
    const start = plusDays(today, 10);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: nextUnit(elg),
      tenantId: await tenant('Never Starts'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 100_000,
      depositMinor: 100_000,
      cycle: 'monthly',
      signedOn: today,
    });
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: lease.id,
      amountMinor: 250_000,
      receivedOn: today,
    });
    const request = await s.leases.requestCancelSigned(
      agency.manager,
      lease.id,
      'The tenant took another flat',
    );
    await s.approvals.decide(agency.admin, request.request.id, { decision: 'approve' });
    await runLeaseEvents(ctx, b, agency.companyId);
    const card = await moneyCard(ctx, b, agency.companyId, lease.id);
    expect(card.depositHeldMinor).toBe(100_000);
    expect(card.creditMinor).toBe(150_000);
    const invoices = await invoicesOf(lease.id);
    for (const invoice of invoices) {
      const detail = await b.read.invoice(agency.manager, invoice.id);
      if (invoice.kind === 'cycle') expect(detail.status).toBe('voided');
    }
  });
});

describe('PR-07 owners once a property is billed (decisions 5 and 6, M2 S5)', () => {
  it('corrects the owner on the same day before any ledger entry, and refuses any change after', async () => {
    const wrong = await propertyWithUnits(s, agency.manager, {
      areaCode: 'ACC',
      propertyPart: 'WRG',
      ownerId: ownerA,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    await s.register.correctOwner(agency.admin, wrong.propertyId, {
      ownerId: ownerVat,
      reason: 'Filed under the wrong owner',
    });
    const detail = await s.read.getProperty(agency.admin, wrong.propertyId);
    expect(detail.ownership.map((o) => [o.ownerId, o.current])).toEqual([[ownerVat, true]]);
    const start = plusDays(today, 1);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: Object.values(wrong.units)[0]!,
      tenantId: await tenant('After Correction'),
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 50_000,
      cycle: 'monthly',
      signedOn: today,
    });
    expect((await invoicesOf(lease.id))[0]!.ownerId).toBe(ownerVat);
    await expect(
      s.register.correctOwner(agency.admin, wrong.propertyId, { ownerId: ownerA, reason: 'Again' }),
    ).rejects.toMatchObject({ code: 'owner_fixed' });
    await expect(
      s.register.changeOwner(agency.admin, wrong.propertyId, {
        ownerId: ownerA,
        effectiveFrom: plusDays(today, 30),
      }),
    ).rejects.toMatchObject({ code: 'owner_fixed' });
    // The database refuses it too, whatever the code does.
    await expect(
      withCompany(ctx.database, { companyId: agency.companyId, actorKind: 'system' }, (tx) =>
        tx.insert(schema.propertyOwnership).values({
          companyId: agency.companyId,
          propertyId: wrong.propertyId,
          ownerId: ownerA,
          shareBps: 10_000,
          effectiveFrom: plusDays(today, 40),
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: 'RA045' } });
  });
});

describe('AC-01 every owner and company has its book', () => {
  it('makes a book with each owner and each landlord or agency company, in the database', async () => {
    const books = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      (tx) => tx.select().from(schema.book),
    );
    expect(books.filter((bk) => bk.kind === 'company')).toHaveLength(1);
    expect(new Set(books.filter((bk) => bk.ownerId).map((bk) => bk.ownerId))).toEqual(
      new Set([ownerA, ownerVat, ...books.filter((bk) => bk.ownerId).map((bk) => bk.ownerId)]),
    );
    const landlord = await moneyCompany(ctx, s, 'landlord', 'Book Landlord');
    const scoped = await staffIn(ctx, landlord.companyId, 'landlord', 'owner', 'Second Owner');
    const created = await s.owners.create(scoped, { kind: 'individual', displayName: 'Self' });
    const landlordBooks = await withCompany(
      ctx.database,
      { companyId: landlord.companyId, actorKind: 'system' },
      (tx) => tx.select().from(schema.book),
    );
    expect(landlordBooks.map((bk) => [bk.kind, bk.ownerId]).sort()).toEqual(
      [
        ['company', null],
        ['owner', created.id],
      ].sort(),
    );
  });
});
