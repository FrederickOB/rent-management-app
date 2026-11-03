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
import { MESSAGE_SEND_JOB } from '../src/core/messages';
import { company, startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { taxServices, type TaxServices } from './support/tax';
import { propertyWithUnits, tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * M5 review 8 on its own database, since it adds rules rows (rules are global): the rent tax
 * alert text and the item views take their days from the rules rows the item used, never from
 * the code (CLAUDE.md section 7; TX-02, TX-08).
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let today: string;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));

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

describe('TX-02 rent tax alerts say what the rules rows the item used say (M5 review 8)', () => {
  it('writes "within 45 days" from a 45-day rules row, and shows the item’s due and alert days', async () => {
    const platformId = await company(ctx, 'platform', 'Review Platform');
    const from = plusMonths(today, -3);
    // New rows with their own effective date (rows are never edited): what an amendment does.
    for (const [key, value] of [
      ['rent_tax.due_days_after_receipt', { days: 45 }],
      ['rent_tax.alert_days', { days: [7, 40] }],
    ] as const)
      await s.rules.add(
        {
          country: 'GH',
          key,
          value,
          effectiveFrom: from,
          source: 'M5 review test amendment',
          verificationStatus: 'unverified',
          createdBy: 'test',
        },
        platformId,
      );
    const agency = await moneyCompany(ctx, s, 'agency', 'Rules Agency');
    const ownerId = (
      await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Rules Owner' })
    ).id;
    const property = await propertyWithUnits(s, agency.manager, {
      areaCode: 'ACC',
      propertyPart: 'RUL',
      ownerId,
      use: 'commercial',
      units: [{ unitType: 'office', count: 1 }],
    });
    const tenantId = (
      await s.tenants.create(agency.manager, {
        kind: 'company',
        displayName: 'Rules Corp',
        legalName: 'Rules Corp Ltd',
      })
    ).tenant.id;
    const start = `${plusMonths(today, -2).slice(0, 7)}-01`;
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId: Object.values(property.units)[0]!,
      tenantId,
      startDate: start,
      endDate: plusDays(plusMonths(start, 12), -1),
      monthlyRentMinor: 1_000_000,
      cycle: 'monthly',
      use: 'commercial',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    await b.invoicing.accrueAll(agency.companyId, today);
    await b.money.recordProviderPayment(agency.companyId, {
      leaseId: lease.id,
      amountMinor: 1_000_000,
      receivedOn: plusDays(today, -41),
    });
    const [item] = await t.reports.items(agency.accountant, { leaseId: lease.id });
    expect(item).toMatchObject({ dueDays: 45, alertDays: [7, 40] });
    expect(item!.dueDate).toBe(plusDays(today, 4));
    expect(await t.taxAlerts.run(agency.companyId, today)).toBe(2);
    const bodies = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ body: string }>(
          sql`select payload->>'body' as body from ${schema.outboxEvent}
              where type = ${MESSAGE_SEND_JOB} and payload->>'subject' like 'Rent tax due%'`,
        ),
    );
    expect(bodies.rows.length).toBeGreaterThan(0);
    for (const { body } of bodies.rows) {
      expect(body).toContain('within 45 days of the rent being received');
      expect(body).toContain('45 days after it was received');
      expect(body).not.toContain('30 days');
    }
  });
});
