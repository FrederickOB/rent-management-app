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
import { startServerTest, type ServerTestContext } from './support';
import {
  approvedCash,
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import {
  propertyWithUnits,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

/**
 * One lock order for money (review 3): the lease(s), then the collector's cash, then the number
 * counters, then the audit chain head. A reversal of cash "from the collector" used to take the
 * collector's lock after its audited decision, while banking takes it first: they deadlocked.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let today: string;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let unitId: string;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const plusMonths = (date: string, n: number) => toIsoDate(addMonths(parseBusinessDate(date), n));

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  today = toIsoDate(businessDateOf(instantFrom(ctx.clock.now()), 'Africa/Accra'));
  agency = await moneyCompany(ctx, s, 'agency', 'Lock Agency');
  const ownerId = (
    await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Owner L' })
  ).id;
  const property = await propertyWithUnits(s, agency.manager, {
    areaCode: 'ACC',
    propertyPart: 'LCK',
    ownerId,
    units: [{ unitType: 'apartment', count: 1, bedrooms: 2 }],
  });
  unitId = Object.values(property.units)[0]!;
});

afterAll(async () => {
  await ctx?.close();
});

describe('BC-05 a reversal from the collector and banking never deadlock (review 3)', () => {
  it('waits for the transaction holding the collector’s cash, then reverses', async () => {
    const start = plusMonths(today, -1);
    const lease = await billedLease(ctx, s, b, agency.manager, {
      unitId,
      tenantId: (
        await s.tenants.create(agency.manager, { kind: 'individual', displayName: 'Bounce' })
      ).tenant.id,
      startDate: start,
      endDate: plusDays(plusMonths(start, 12), -1),
      monthlyRentMinor: 100_000,
      cycle: 'monthly',
      signedOn: plusDays(start, -1),
      billingStartDate: start,
    });
    await approvedCash(ctx, s, b, agency.manager, agency.admin, {
      leaseId: lease.id,
      amountMinor: 100_000,
      receivedOn: today,
      method: 'cheque',
    });
    const sys = { companyId: agency.companyId, actorKind: 'system' as const };
    const { paymentId, bookId } = await withCompany(ctx.database, sys, async (tx) => {
      const [p] = await tx
        .select({ id: schema.payment.id, bookId: schema.payment.bookId })
        .from(schema.payment)
        .where(sql`${schema.payment.leaseId} = ${lease.id}`);
      return { paymentId: p!.id, bookId: p!.bookId };
    });
    const requestId = await b.money.requestReversal(agency.accountant, paymentId, {
      reason: 'bounced_cheque',
      note: 'Cheque returned unpaid',
      moneyNowIn: 'collector',
    });
    // Another transaction holds the manager's cash in this book, as banking does before it writes.
    const client = await ctx.database.pool.connect();
    let outcome: string[];
    try {
      await client.query('begin');
      await client.query(
        "select set_config('app.company_id', $1, true), set_config('app.actor_kind', 'system', true)",
        [agency.companyId],
      );
      await client.query('select app.lock_collector_cash($1, $2, $3)', [
        agency.companyId,
        agency.manager.personId,
        bookId,
      ]);
      const decide = s.approvals
        .decide(agency.admin, requestId, { decision: 'approve' })
        .then(() => 'decide ok')
        .catch(
          (e: { code?: string; message?: string; cause?: { code?: string } }) =>
            `decide ${e.cause?.code ?? e.code} ${e.message?.slice(0, 80)}`,
        );
      for (let i = 0; i < 100; i += 1) {
        const waiting = await client.query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event = 'advisory'",
        );
        if (waiting.rows[0]!.n > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      // Now this transaction writes something audited, as banking does next.
      const banked = await client
        .query(
          "insert into period_lock (company_id, book_id, month, source) values ($1, $2, '2099-03-01', 'manual')",
          [agency.companyId, bookId],
        )
        .then(() => 'banking ok')
        .catch((e: { code?: string }) => `banking ${e.code}`);
      await client.query('rollback');
      outcome = [await decide, banked];
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
    expect(outcome).toEqual(['decide ok', 'banking ok']);
    const reversed = await withCompany(ctx.database, sys, (tx) =>
      tx
        .select({ id: schema.paymentReversal.id })
        .from(schema.paymentReversal)
        .where(sql`${schema.paymentReversal.paymentId} = ${paymentId}`),
    );
    expect(reversed).toHaveLength(1);
  });
});

describe('PR-07 an owner correction and the first invoice wait for each other (second review B)', () => {
  it('serialises them on the property, in one lock order, without a deadlock', async () => {
    const ownerA = (
      await s.owners.create(agency.admin, { kind: 'individual', displayName: 'First Owner' })
    ).id;
    const ownerB = (
      await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Right Owner' })
    ).id;
    const prop = await propertyWithUnits(s, agency.manager, {
      areaCode: 'ACC',
      propertyPart: 'RCE',
      ownerId: ownerA,
      units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
    });
    const start = plusDays(today, 1);
    const lease = await s.leases.recordPaper(agency.manager, {
      noticeDays: 30,
      parties: [{ role: 'tenant', name: 'Tenant' }],
      scanUploadId: await uploadLeaseFile(ctx, s, agency.manager),
      unitId: Object.values(prop.units)[0]!,
      tenantId: (
        await s.tenants.create(agency.manager, { kind: 'individual', displayName: 'Race' })
      ).tenant.id,
      startDate: start,
      endDate: plusDays(plusMonths(start, 12), -1),
      monthlyRentMinor: 50_000,
      depositMinor: 100_000,
      cycle: 'monthly',
      signedOn: today,
    });
    // A third transaction holds the property's owner lock while both start.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const isHeld = new Promise<void>((r) => (held = r));
    const holder = withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      async (tx) => {
        await tx.execute(
          sql`select app.lock_property_owner(${agency.companyId}::uuid, ${prop.propertyId}::uuid)`,
        );
        held();
        await gate;
      },
    );
    await isHeld;
    const outcome = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: { code?: string; cause?: { code?: string } }) =>
          `${e.code ?? ''}/${e.cause?.code ?? ''}`,
      );
    const correction = outcome(
      s.register.correctOwner(agency.admin, prop.propertyId, {
        ownerId: ownerB,
        reason: 'Filed under the wrong owner',
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    const signing = outcome(b.invoicing.onLeaseSigned(agency.companyId, lease.id));
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holder;
    const results = await Promise.all([correction, signing]);
    expect(results.join(' ')).not.toContain('40P01');
    // Whichever went first, the invoice is in the book of the property's owner.
    const [invoice] = await withCompany(
      ctx.database,
      { companyId: agency.companyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ owner_id: string }>(
          sql`select owner_id from invoice where lease_id = ${lease.id} limit 1`,
        ),
    ).then((r) => r.rows);
    if (results[0] === 'ok') expect(invoice?.owner_id ?? ownerB).toBe(ownerB);
    else expect(invoice?.owner_id).toBe(ownerA);
  });
});
