import { businessDateOf, instantFrom, toIsoDate } from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServerTest, type ServerTestContext } from './support';
import { billingServices, journalSum, moneyCompany, type BillingServices } from './support/billing';
import { maintenanceServices, type MaintenanceServices } from './support/maintenance';
import { fundAgentCash } from './support/owner-funding';
import { taxServices, type TaxServices } from './support/tax';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  type TenancyServices,
} from './support/tenancy';

/**
 * AC-03 and AD-02 (M9 review): a manager limited to some properties records expenses on them.
 * The expense's journal rows are written unscoped after the scoped check, as refunds and GRA
 * payments are; before, the ledger's `unscoped_writes` policy refused them with a raw 500.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let t: TaxServices;
let m: MaintenanceServices;
let today: string;

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  t = taxServices(ctx, s, b);
  m = maintenanceServices(ctx, s, b, t);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
});

afterAll(async () => {
  await ctx?.close();
});

describe('AC-03 AD-02 a property-limited manager records expenses on their own properties', () => {
  it('records an expense on their property, owner-paid and agent-paid, and is refused (403) on another', async () => {
    const c = await moneyCompany(ctx, s, 'agency', 'Scoped Expenses');
    const ownerId = (
      await s.owners.create(c.admin, { kind: 'individual', displayName: 'Scoped Expenses owner' })
    ).id;
    const mine = await propertyWithUnits(s, c.admin, {
      areaCode: 'ACC',
      propertyPart: 'SEM',
      ownerId,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const other = await propertyWithUnits(s, c.admin, {
      areaCode: 'ACC',
      propertyPart: 'SEO',
      ownerId,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const scoped = await staffIn(ctx, c.companyId, 'agency', 'property_manager', 'Scoped manager', {
      properties: [mine.propertyId],
    });
    const record = (propertyId: string, paidBy: 'owner' | 'agent', key: string) =>
      m.expenses.record(scoped, {
        propertyId,
        category: 'repairs',
        supplierName: `Scoped supplier ${key}`,
        amountMinor: 15_000,
        expenseDate: today,
        paidBy,
      });
    const paidByOwner = await record(mine.propertyId, 'owner', 'owner');
    await fundAgentCash(ctx, s, b, c.accountant, ownerId, 15_000);
    const paidByAgent = await record(mine.propertyId, 'agent', 'agent');
    expect(
      await journalSum(
        ctx,
        c.companyId,
        `e.record_type = 'expense' and e.record_id = $1 and l.account_code = '1010'`,
        [paidByOwner.expenseId],
      ),
    ).toBe(-15_000);
    expect(
      await journalSum(
        ctx,
        c.companyId,
        `e.record_type = 'expense' and e.record_id = $1 and l.account_code = '1070'`,
        [paidByAgent.expenseId],
      ),
    ).toBe(-15_000);
    expect((await m.expenses.list(scoped, {})).map((e) => e.id).sort()).toEqual(
      [paidByOwner.expenseId, paidByAgent.expenseId].sort(),
    );
    await expect(record(other.propertyId, 'owner', 'other')).rejects.toMatchObject({
      status: 403,
    });
  });
});
