import { schema, sql, withCompany } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ComplianceItem } from '../src/reporting/compliance.service';
import { asSuperuser, startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import {
  reportingDashboardServices,
  type ReportingDashboardServices,
} from './support/reporting-dashboard';
import { setAdvancePolicy, taxServices, type TaxServices } from './support/tax';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * The compliance list (M9 decision 14) against the real database with RLS on: rent tax due and
 * overdue (TX-02), Rent Control registrations outstanding (TX-05), withholding certificates
 * awaited (TX-04), VAT returns not yet paid (P33), and advances over the cap only while the company
 * flags them (OQ-28); filtered by owner and property, and within the reader's scope. Dates are
 * relative to the test clock's day; the one move of the clock is undone at once.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let r: ReportingDashboardServices;
let today: string;
let c: Awaited<ReturnType<typeof setup>>;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));
const endAfter = (from: string, months: number) => plusDays(plusMonths(from, months), -1);
const kinds = (items: readonly ComplianceItem[]) => items.map((i) => i.kind).sort();

/**
 * Owner P (an individual) lets flats: lease X paid once 40 days ago and once today, lease Z paid a
 * year ahead under `warn`. Owner Q (a VAT-registered company) lets a shop to a company that
 * withheld tax; its first invoice, with VAT, was issued last month.
 */
async function setup() {
  const company = await moneyCompany(ctx, s, 'agency', 'Compliance Agency');
  const ownerP = (
    await s.owners.create(company.admin, { kind: 'individual', displayName: 'Owner P' })
  ).id;
  const ownerQ = (
    await s.owners.create(company.admin, {
      kind: 'company',
      displayName: 'Owner Q Ltd',
      legalName: 'Owner Q Limited',
      vatRegistered: true,
      tin: 'C0011223344',
    })
  ).id;
  const flats = await propertyWithUnits(s, company.manager, {
    areaCode: 'ACC',
    propertyPart: 'CMP',
    ownerId: ownerP,
    units: [{ unitType: 'apartment', count: 2, bedrooms: 2 }],
  });
  const [x, z] = Object.values(flats.units) as [string, string];
  const tenant = async (name: string, kind: 'individual' | 'company' = 'individual') =>
    (
      await s.tenants.create(company.manager, {
        kind,
        displayName: name,
        ...(kind === 'company' ? { legalName: `${name} Limited` } : {}),
      })
    ).tenant.id;
  const leaseX = await billedLease(ctx, s, b, company.manager, {
    unitId: x,
    tenantId: await tenant('Tenant X'),
    startDate: plusMonths(today, -3),
    endDate: endAfter(plusMonths(today, -3), 12),
    monthlyRentMinor: 100_000,
    cycle: 'monthly',
    signedOn: plusDays(plusMonths(today, -3), -1),
    billingStartDate: plusMonths(today, -3),
  });
  await b.money.recordProviderPayment(company.companyId, {
    leaseId: leaseX.id,
    amountMinor: 100_000,
    receivedOn: plusDays(today, -40),
  });
  await b.money.recordProviderPayment(company.companyId, {
    leaseId: leaseX.id,
    amountMinor: 100_000,
    receivedOn: today,
  });
  await setAdvancePolicy(ctx, company.companyId, 'warn');
  const leaseZ = await billedLease(ctx, s, b, company.manager, {
    unitId: z,
    tenantId: await tenant('Tenant Z'),
    startDate: today,
    endDate: endAfter(today, 12),
    monthlyRentMinor: 100_000,
    cycle: 'monthly',
    signedOn: plusDays(today, -1),
    billingStartDate: today,
  });
  await b.money.recordProviderPayment(company.companyId, {
    leaseId: leaseZ.id,
    amountMinor: 12 * 100_000,
    receivedOn: today,
  });
  // Q's shop, owned from, signed and first invoiced on the 10th of last month, so its VAT falls in
  // that month.
  const saved = ctx.clock.now();
  const lastMonth = plusMonths(`${today.slice(0, 7)}-01`, -1);
  ctx.clock.set(new Date(`${lastMonth.slice(0, 7)}-10T10:00:00Z`));
  let leaseY: Awaited<ReturnType<typeof billedLease>>;
  let shops: Awaited<ReturnType<typeof propertyWithUnits>>;
  try {
    shops = await propertyWithUnits(s, company.manager, {
      areaCode: 'ACC',
      propertyPart: 'CMQ',
      ownerId: ownerQ,
      use: 'commercial',
      units: [{ unitType: 'shop', count: 1 }],
    });
    leaseY = await billedLease(ctx, s, b, company.manager, {
      unitId: Object.values(shops.units)[0]!,
      tenantId: await tenant('Shop Tenant', 'company'),
      startDate: lastMonth,
      endDate: endAfter(lastMonth, 12),
      monthlyRentMinor: 1_000_000,
      cycle: 'monthly',
      use: 'commercial',
      signedOn: plusDays(lastMonth, -1),
      billingStartDate: lastMonth,
    });
  } finally {
    ctx.clock.set(saved);
  }
  const [line] = await withCompany(
    ctx.database,
    { companyId: company.companyId, actorKind: 'system' },
    (tx) =>
      tx
        .select({ id: schema.invoiceLine.id })
        .from(schema.invoiceLine)
        .where(sql`lease_id = ${leaseY.id} and kind = 'rent' and period_start = ${lastMonth}`),
  );
  await t.withholding.record(company.manager, {
    leaseId: leaseY.id,
    valueDate: today,
    lines: [{ lineId: line!.id, amountMinor: 150_000 }],
  });
  return {
    ...company,
    ownerP,
    ownerQ,
    flats: flats.propertyId,
    shops: shops.propertyId,
    leaseX: leaseX.id,
    leaseY: leaseY.id,
    leaseZ: leaseZ.id,
    lastMonth,
  };
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  r = reportingDashboardServices(ctx, s, b);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  c = await setup();
});

afterAll(async () => {
  await ctx?.close();
});

describe('TX-02 TX-04 TX-05 P33 AR-05 the compliance list (decision 14)', () => {
  it('lists what needs doing from the records that exist, each with its link', async () => {
    const items = await r.compliance.list(c.accountant);
    // Rent tax: 8% on the receipt 40 days ago, overdue since 10 days ago; and on today's two
    // receipts (X's month and Z's year ahead), due in 30 days.
    const overdue = items.filter((i) => i.kind === 'rent_tax_overdue');
    expect(overdue).toEqual([
      {
        kind: 'rent_tax_overdue',
        owner: { id: c.ownerP, name: 'Owner P' },
        property: { id: c.flats, name: 'ACC-CMP property' },
        lease: null,
        dueDate: plusDays(today, -10),
        amountMinor: 8_000,
        description: expect.stringContaining('was due to GRA'),
        link: { screen: 'rent_tax', id: null },
      },
    ]);
    const due = items.filter((i) => i.kind === 'rent_tax_due');
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      dueDate: plusDays(today, 30),
      amountMinor: 8_000 + 96_000,
      description: expect.stringContaining('2 receipts'),
    });
    // Rent Control: the residential leases with no registration recorded, the unverified period
    // named (CLAUDE.md section 7).
    const control = items.filter((i) => i.kind === 'rent_control_registration');
    const controlled = control.map((i) => i.lease?.id);
    expect(controlled).toEqual(expect.arrayContaining([c.leaseX, c.leaseZ]));
    for (const item of control) {
      expect(item.link).toEqual({ screen: 'rent_control', id: item.lease!.id });
      expect(item.dueDate).not.toBeNull();
      expect(item.description).toContain('counsel to confirm');
    }
    // Withholding: Q's tenant withheld GH₵1,500 and no certificate has come yet.
    expect(items.filter((i) => i.kind === 'withholding_certificate')).toEqual([
      expect.objectContaining({
        owner: { id: c.ownerQ, name: 'Owner Q Ltd' },
        lease: expect.objectContaining({ id: c.leaseY }),
        amountMinor: 150_000,
        dueDate: null,
        link: { screen: 'withholding', id: c.leaseY },
      }),
    ]);
    // VAT: last month's VAT and levies (15% + 2.5% + 2.5% of GH₵10,000), not yet paid with a
    // return; no due date is invented.
    expect(items.filter((i) => i.kind === 'vat_return')).toEqual([
      expect.objectContaining({
        owner: { id: c.ownerQ, name: 'Owner Q Ltd' },
        property: null,
        amountMinor: 200_000,
        dueDate: null,
        link: { screen: 'vat', id: c.ownerQ },
      }),
    ]);
    // Advance: Z paid twelve months ahead against the one-month limit, flagged under `warn`.
    const advances = items.filter((i) => i.kind === 'advance_over_cap');
    expect(advances).toEqual([
      expect.objectContaining({
        lease: expect.objectContaining({ id: c.leaseZ }),
        amountMinor: 1_200_000,
        link: { screen: 'advance_rent', id: c.leaseZ },
      }),
    ]);
    expect(advances[0]!.description).not.toMatch(/compliant/i);
    // Dated items first, in date order.
    const dated = items.filter((i) => i.dueDate !== null).map((i) => i.dueDate!);
    expect(dated).toEqual([...dated].sort());
  });

  it('lists advances over the cap only while the company flags them (OQ-28)', async () => {
    await setAdvancePolicy(ctx, c.companyId, 'off');
    try {
      expect(kinds(await r.compliance.list(c.manager))).not.toContain('advance_over_cap');
    } finally {
      await setAdvancePolicy(ctx, c.companyId, 'warn');
    }
    expect(kinds(await r.compliance.list(c.manager))).toContain('advance_over_cap');
  });

  it('filters by owner and by property', async () => {
    const p = await r.compliance.list(c.admin, { ownerId: c.ownerP });
    expect(p.every((i) => i.owner?.id === c.ownerP)).toBe(true);
    expect(kinds(p)).toEqual(
      expect.arrayContaining(['rent_tax_due', 'rent_tax_overdue', 'advance_over_cap']),
    );
    expect(kinds(p)).not.toContain('vat_return');
    const q = await r.compliance.list(c.admin, { ownerId: c.ownerQ });
    expect(q.every((i) => i.owner?.id === c.ownerQ)).toBe(true);
    expect(kinds(q)).toEqual(expect.arrayContaining(['vat_return', 'withholding_certificate']));
    // A property is not an owner's VAT return: owner-level items drop out.
    const shop = await r.compliance.list(c.admin, { propertyId: c.shops });
    expect(kinds(shop)).toContain('withholding_certificate');
    expect(kinds(shop)).not.toContain('vat_return');
    expect(shop.every((i) => i.property?.id === c.shops)).toBe(true);
    await expect(r.compliance.list(c.admin, { ownerId: 'not-a-uuid' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('keeps to the reader’s scope: an owner’s user sees their own; a caretaker is refused', async () => {
    const qUser = await staffIn(ctx, c.companyId, 'agency', 'owner', 'Owner Q user', {
      owners: [c.ownerQ],
    });
    const seen = await r.compliance.list(qUser);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((i) => i.owner?.id === c.ownerQ)).toBe(true);
    expect(kinds(seen)).toEqual(expect.arrayContaining(['vat_return', 'withholding_certificate']));
    // Asking for P's items gives nothing of theirs.
    expect(await r.compliance.list(qUser, { ownerId: c.ownerP })).toEqual([]);
    const adviser = await staffIn(ctx, c.companyId, 'agency', 'adviser', 'P adviser', {
      owners: [c.ownerP],
    });
    const advised = await r.compliance.list(adviser);
    expect(advised.length).toBeGreaterThan(0);
    expect(advised.every((i) => i.owner?.id === c.ownerP)).toBe(true);
    const caretaker = await staffIn(ctx, c.companyId, 'agency', 'caretaker', 'Caretaker', {
      properties: [c.flats],
    });
    await expect(r.compliance.list(caretaker)).rejects.toMatchObject({ status: 403 });
    // Another company sees none of it.
    const other = await moneyCompany(ctx, s, 'landlord', 'Other Compliance');
    expect(await r.compliance.list(other.admin)).toEqual([]);
  });

  it('drops an item once it is dealt with: a Rent Control registration recorded', async () => {
    await s.leases.recordRentControl(c.manager, c.leaseX, {
      registrationNumber: 'RC-2026-001',
      registeredOn: today,
    });
    const items = await r.compliance.list(c.manager);
    expect(
      items.filter((i) => i.kind === 'rent_control_registration').map((i) => i.lease?.id),
    ).not.toContain(c.leaseX);
  });

  it('shows a VAT return as "Due date unverified" while vat.return_due_days has no value (OQ-61)', async () => {
    const rule = await s.rules.resolve('GH', 'vat.return_due_days', parseBusinessDate(today));
    expect(rule).toMatchObject({ value: null, verificationStatus: 'unverified', warning: true });
    expect(rule.source).toContain('OQ-61');
    const vat = (list: readonly ComplianceItem[]) => list.filter((i) => i.kind === 'vat_return');
    const [unset] = vat(await r.compliance.list(c.manager));
    expect(unset).toMatchObject({ owner: { id: c.ownerQ }, dueDate: null, amountMinor: 200_000 });
    expect(unset!.description).toContain('Due date unverified');
    expect(unset!.description).toContain('OQ-61');
    // Once the rules table has a value, the date is that many days after the month's end, and the
    // warning stays while the value is unverified. A test value, below the application, not GRA's.
    await asSuperuser(
      ctx,
      `insert into rule (country, key, value, effective_from, source, verification_status, created_by)
       values ('GH', 'vat.return_due_days', '{"days": 9}'::jsonb, date '2000-01-02',
               'Test value only', 'unverified', 'test')`,
    );
    const lastMonthEnd = plusDays(`${today.slice(0, 7)}-01`, -1);
    const [dated] = vat(await r.compliance.list(c.manager));
    expect(dated).toMatchObject({ dueDate: plusDays(lastMonthEnd, 9), amountMinor: 200_000 });
    expect(dated!.description).toContain('Due date unverified');
  });
});
