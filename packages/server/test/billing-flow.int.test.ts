import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { company, startServerTest, type ServerTestContext } from './support';
import {
  billingServices,
  runLeaseEvents,
  uploadMoneyProof,
  type BillingServices,
} from './support/billing';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let agencyId: string;
let today: string;
const day = (n: number) => toIsoDate(addDays(parseBusinessDate(today), n));
const endAfter = (from: string, n: number) =>
  toIsoDate(addDays(addMonths(parseBusinessDate(from), n), -1));

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  agencyId = await company(ctx, 'agency', 'Cash Flow Agency');
});

afterAll(async () => {
  await ctx?.close();
});

describe('BC-05 cash posts only on approval, and the books balance', () => {
  it('bills, accrues, takes cash on approval and balances', async () => {
    const admin = await staffIn(ctx, agencyId, 'agency', 'agency_admin', 'Admin');
    const manager = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Manager');
    const owner = (await s.owners.create(admin, { kind: 'individual', displayName: 'Owner A' })).id;
    const elg = await propertyWithUnits(s, manager, {
      areaCode: 'ACC',
      propertyPart: 'ELG',
      ownerId: owner,
      units: [{ unitType: 'apartment', count: 2, bedrooms: 2 }],
    });
    const tenant = (await s.tenants.create(manager, { kind: 'individual', displayName: 'Kofi' }))
      .tenant;
    const start = toIsoDate(addMonths(parseBusinessDate(today), -2));
    const lease = await s.leases.recordPaper(manager, {
      unitId: Object.values(elg.units)[0]!,
      tenantId: tenant.id,
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 150_000,
      depositMinor: 300_000,
      cycle: 'monthly',
      noticeDays: 30,
      parties: [{ role: 'tenant', name: 'Kofi' }],
      scanUploadId: await uploadLeaseFile(ctx, s, manager),
      signedOn: day(-1),
      billingStartDate: start,
    });
    await runLeaseEvents(ctx, b, agencyId);
    const card = await b.read.leaseBilling(manager, lease.id);
    expect(card.paymentReference).toMatch(/^[0-9A-Z]{7}$/);
    expect(card.depositHeldMinor).toBe(0);
    expect(card.earnedUnpaidMinor).toBe(3 * 150_000);
    const photo = await uploadMoneyProof(ctx, b, manager, 'cash_photo');
    const { approvalId } = await b.money.recordCash(manager, {
      leaseId: lease.id,
      method: 'cash',
      amountMinor: 800_000,
      receivedOn: today,
      payerName: 'Kofi',
      photoUploadId: photo,
    });
    expect((await b.read.leaseBilling(manager, lease.id)).earnedUnpaidMinor).toBe(3 * 150_000);
    await s.approvals.decide(admin, approvalId, { decision: 'approve' });
    const after = await b.read.leaseBilling(manager, lease.id);
    expect(after.depositHeldMinor).toBe(300_000);
    expect(after.earnedUnpaidMinor).toBe(0);
    expect(after.creditMinor).toBe(800_000 - 300_000 - 450_000);
    const check = await b.subledger.check(agencyId);
    expect(check.mismatches).toEqual([]);
    const cash = await b.read.collectorsCash(manager);
    expect(cash).toEqual([expect.objectContaining({ heldMinor: 800_000 })]);
  });
});
