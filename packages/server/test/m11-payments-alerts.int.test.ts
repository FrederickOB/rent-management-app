import { randomUUID } from 'node:crypto';
import { eq, schema, sql, withCompany } from '@rent/db';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoNow } from '../src/billing/records';
import { startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import {
  activeAccount,
  agreementInForce,
  CLIENT,
  paymentsServices,
  type PaymentsServices,
} from './support/payments';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * NFR-AVAIL: while every provider is down, the pay page raises one incident per company in 15
 * minutes, not one per tenant (the M11 outage drill: 500 tenants must not page 500 times).
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let p: PaymentsServices;
let today: string;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const sys = (companyId: string) => ({ companyId, actorKind: 'system' as const });

async function companyWithLeases(name: string, count: number) {
  const company = await moneyCompany(ctx, s, 'agency', name);
  const second = await staffIn(ctx, company.companyId, 'agency', 'agency_admin', `${name} Second`);
  const owner = (
    await s.owners.create(company.admin, { kind: 'individual', displayName: `${name} Owner` })
  ).id;
  const property = await propertyWithUnits(s, company.manager, {
    areaCode: 'ACC',
    propertyPart: name.slice(0, 3).toUpperCase(),
    ownerId: owner,
    units: [{ unitType: 'apartment', count, bedrooms: 2 }],
  });
  await activeAccount(ctx, s, p, company.admin, second, { holder: 'agency' });
  await agreementInForce(ctx, s, p, company.admin, second, owner, 'agency_client_account');
  await withCompany(ctx.database, sys(company.companyId), (tx) =>
    tx
      .update(schema.company)
      .set({
        settings: sql`settings || ${JSON.stringify({ paymentProviderOrder: ['paystack'] })}::jsonb`,
      })
      .where(eq(schema.company.id, company.companyId)),
  );
  const tokens: string[] = [];
  for (const unitId of Object.values(property.units)) {
    const { tenant } = await s.tenants.create(company.manager, {
      kind: 'individual',
      displayName: `Tenant ${randomUUID().slice(0, 6)}`,
    });
    const lease = await billedLease(ctx, s, b, company.manager, {
      unitId,
      tenantId: tenant.id,
      startDate: today,
      endDate: plusDays(toIsoDate(addMonths(parseBusinessDate(today), 12)), -1),
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      depositMinor: null,
      signedOn: plusDays(today, -1),
      billingStartDate: today,
    });
    const [invoice] = await withCompany(ctx.database, sys(company.companyId), (tx) =>
      tx.select().from(schema.invoice).where(eq(schema.invoice.leaseId, lease.id)),
    );
    const { url } = await withCompany(ctx.database, sys(company.companyId), async (tx) =>
      p.links.mint(tx, await p.links.invoice(tx, invoice!.id)),
    );
    tokens.push(url.split('/p/')[1]!);
  }
  return { companyId: company.companyId, tokens };
}

async function start(token: string, n: number) {
  return p.page.start(
    token,
    { ...CLIENT, ip: `198.51.100.${n + 1}` },
    {
      amountMinor: 150_000,
      method: 'momo',
      momo: { phone: '024 000 0003', network: 'mtn' },
      submissionId: randomUUID(),
    },
  );
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  p = paymentsServices(ctx, s, b);
  today = isoNow(ctx.clock, 'Africa/Accra');
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

describe('NFR-AVAIL one provider-unavailable incident per company per 15 minutes', () => {
  it('raises one alert for many failed starts, and one for each other company', async () => {
    const first = await companyWithLeases('Outage One', 4);
    const second = await companyWithLeases('Outage Two', 2);
    const before = p.alerts.filter((a) => a.code === 'payments.provider_unavailable').length;
    p.primary.failCharges = true;
    try {
      let n = 0;
      for (const token of first.tokens) {
        const intent = await start(token, n++);
        expect(intent.status).toBe('failed');
      }
      for (const token of second.tokens) expect((await start(token, n++)).status).toBe('failed');
    } finally {
      p.primary.failCharges = false;
    }
    const raised = p.alerts.filter((a) => a.code === 'payments.provider_unavailable').slice(before);
    expect(raised.map((a) => a.context?.companyId)).toEqual([first.companyId, second.companyId]);
  });
});
