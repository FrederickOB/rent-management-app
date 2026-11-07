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
  billedLease,
  billingServices,
  leaseAccount,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { propertyWithUnits, tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * AC-04 (M9 review): a posting that meets an owner statement being issued is refused with 409
 * STATEMENT_ISSUING and is retried, never lost. Money from a provider (the webhook job and
 * reconciliation call the same `receive`) is refused whole, so the job's backoff retries it; the
 * daily billing run finishes its other leases and then throws the same conflict, so its job is
 * retried too, instead of raising a critical alert and waiting a day.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let today: string;
const DAY = 86_400_000;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));

async function on<T>(date: string, fn: () => Promise<T>): Promise<T> {
  const ms = daysBetween(parseBusinessDate(today), parseBusinessDate(date)) * DAY;
  ctx.clock.advance(ms);
  try {
    return await fn();
  } finally {
    ctx.clock.advance(-ms);
  }
}

/** Runs `fn` while another transaction holds the book's issue lock, as `issue()` does. */
async function whileIssuing<T>(companyId: string, bookId: string, fn: () => Promise<T>) {
  return withCompany(ctx.database, { companyId, actorKind: 'system' }, async (tx) => {
    await b.posting.lockBookForIssue(tx, bookId);
    return fn();
  });
}

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
});

afterAll(async () => {
  await ctx?.close();
});

describe('AC-04 postings that meet an issue in progress are retried, never lost', () => {
  it('refuses money and the daily accrual while a statement is issued, and posts both once it is done', async () => {
    const c = await moneyCompany(ctx, s, 'agency', 'Issuing Retry');
    const ownerId = (
      await s.owners.create(c.admin, { kind: 'individual', displayName: 'Issuing Retry owner' })
    ).id;
    const place = await propertyWithUnits(s, c.manager, {
      areaCode: 'ACC',
      propertyPart: 'IRT',
      ownerId,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const start = `${today.slice(0, 7)}-01`;
    const lease = await billedLease(ctx, s, b, c.manager, {
      unitId: Object.values(place.units)[0]!,
      tenantId: (
        await s.tenants.create(c.manager, { kind: 'individual', displayName: 'Issuing tenant' })
      ).tenant.id,
      startDate: start,
      endDate: plusDays(plusMonths(start, 12), -1),
      monthlyRentMinor: 100_000,
      cycle: 'monthly',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    const [book] = await withCompany(
      ctx.database,
      { companyId: c.companyId, actorKind: 'system' },
      (tx) =>
        tx
          .select({ id: schema.book.id })
          .from(schema.book)
          .where(sql`owner_id = ${ownerId}`),
    );
    // The provider's money (the webhook job's path) is refused whole while the issue runs.
    await whileIssuing(c.companyId, book!.id, () =>
      expect(
        b.money.recordProviderPayment(c.companyId, {
          leaseId: lease.id,
          amountMinor: 100_000,
          receivedOn: today,
          reference: 'ISSUING-1',
        }),
      ).rejects.toMatchObject({ status: 409, code: 'statement_issuing' }),
    );
    expect(await leaseAccount(ctx, c.companyId, lease.id, '1050')).toBe(0);
    // The retry posts it.
    await b.money.recordProviderPayment(c.companyId, {
      leaseId: lease.id,
      amountMinor: 100_000,
      receivedOn: today,
      reference: 'ISSUING-1',
    });
    expect(await leaseAccount(ctx, c.companyId, lease.id, '1050')).toBe(100_000);

    // Next month's accrual run meets an issue: the run throws the conflict, so its job retries.
    const next = plusMonths(start, 1);
    await on(next, async () => {
      await b.invoicing.generateAll(c.companyId, next);
      await whileIssuing(c.companyId, book!.id, () =>
        expect(b.invoicing.accrueAll(c.companyId, next)).rejects.toMatchObject({
          status: 409,
          code: 'statement_issuing',
        }),
      );
      expect(await leaseAccount(ctx, c.companyId, lease.id, '4000')).toBe(-100_000);
      expect(await b.invoicing.accrueAll(c.companyId, next)).toBe(1);
    });
    expect(await leaseAccount(ctx, c.companyId, lease.id, '4000')).toBe(-200_000);
  });
});
