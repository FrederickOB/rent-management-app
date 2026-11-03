import { schema, sql, withCompany } from '@rent/db';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoNow } from '../src/billing/records';
import { startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  moneyCompany,
  uploadMoneyProof,
  type BillingServices,
} from './support/billing';
import {
  activeAccount,
  agreementInForce,
  CLIENT,
  paymentsServices,
  type PaymentsServices,
} from './support/payments';
import { setAdvancePolicy, taxServices } from './support/tax';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * M5 review 9: one advance cap (AR-05, decision 4) on every path. On a VAT-registered commercial
 * lease the pay page and cash or transfers once disagreed: the pay page counted rent alone, the
 * money service the walk with VAT. Now both take `advancePaymentCapMinor`: months of rent count
 * against the limit, and their VAT and levies are paid with them.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let p: PaymentsServices;
let today: string;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  p = paymentsServices(ctx, s, b);
  taxServices(ctx, s, b);
  today = isoNow(ctx.clock, 'Africa/Accra');
});

afterAll(async () => {
  await ctx?.close();
});

describe('AR-05 one advance cap for the pay page, cash and transfers (M5 review 9)', () => {
  it('gives a VAT-registered commercial lease the same most on the pay page as for a transfer, VAT included', async () => {
    const agency = await moneyCompany(ctx, s, 'agency', 'Cap Agency');
    const secondAdmin = await staffIn(ctx, agency.companyId, 'agency', 'agency_admin', 'Cap Admin');
    const ownerId = (
      await s.owners.create(agency.admin, {
        kind: 'company',
        displayName: 'Cap VAT Owner Ltd',
        legalName: 'Cap VAT Owner Limited',
        vatRegistered: true,
        tin: 'C0011223344',
      })
    ).id;
    const place = await propertyWithUnits(s, agency.manager, {
      areaCode: 'ACC',
      propertyPart: 'CAP',
      ownerId,
      use: 'commercial',
      units: [{ unitType: 'shop', count: 1 }],
    });
    await activeAccount(ctx, s, p, agency.admin, secondAdmin, { holder: 'owner', ownerId });
    await agreementInForce(ctx, s, p, agency.admin, secondAdmin, ownerId, 'owner_account');
    const tenantId = (
      await s.tenants.create(agency.manager, { kind: 'individual', displayName: 'Cap Tenant' })
    ).tenant.id;
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: Object.values(place.units)[0]!,
      tenantId,
      startDate: today,
      endDate: plusDays(plusMonths(today, 12), -1),
      monthlyRentMinor: 1_000_000,
      cycle: 'monthly',
      use: 'commercial',
      depositMinor: null,
      signedOn: today,
      billingStartDate: today,
    });
    await setAdvancePolicy(ctx, agency.companyId, 'block');
    const [invoice] = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ id: schema.invoice.id })
          .from(schema.invoice)
          .where(sql`${schema.invoice.leaseId} = ${lease.id}`),
    );
    const { url } = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      async (tx) => p.links.mint(tx, await p.links.invoice(tx, invoice!.id)),
    );
    const page = await p.page.open(url.split('/p/')[1]!, CLIENT);
    expect(page.advance).toMatchObject({ policy: 'block', limitMonths: 6 });
    // This month and six ahead, each GH₵10,000 rent with 15% VAT, 2.5% NHIL and 2.5% GETFund.
    const most = 7 * (1_000_000 + 150_000 + 25_000 + 25_000);
    expect(page.advance!.capMinor).toBe(most);
    const proof = await uploadMoneyProof(ctx, b, agency.manager, 'transfer_proof');
    await expect(
      b.money.recordTransfer(agency.manager, {
        leaseId: lease.id,
        receivedInto: 'owner_account',
        amountMinor: most + 1,
        receivedOn: today,
        proofUploadId: proof,
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'advance_over_limit',
      details: { maxMinor: String(most), limitMonths: '6' },
    });
  });
});
