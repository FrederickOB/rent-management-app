import { randomUUID } from 'node:crypto';
import { eq, schema, sql, withCompany } from '@rent/db';
import { lineBalance, paymentCredit } from '@rent/domain/billing';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { chargeReference } from '@rent/domain/payments';
import type { PaymentWebhookRequest } from '@rent/integrations';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoNow } from '../src/billing/records';
import { startServerTest, type ServerTestContext } from './support';
import {
  approvedCash,
  billedLease,
  billingServices,
  journalSum,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import {
  activeAccount,
  CLIENT,
  deliverWebhook,
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
 * ★ BC-07 any sequence of invoices and payments keeps the ledger whole (M4b plan section 6): M4a's
 * sequences with provider payments mixed in, through the pay page, the webhook (delivered twice)
 * and chargebacks, and cash. After every step the database's own sub-ledger check passes (every
 * entry zero per book, no line or payment over-allocated, allocated plus credit equal to what was
 * paid, suspense and deposits matching), and a replayed webhook changes nothing. Run counts are
 * modest because CI runs the integration suites together; M4B_PROPERTY_RUNS raises them.
 */
const RUNS = Number(process.env.M4B_PROPERTY_RUNS ?? 6);
const DAY = 86_400_000;

let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let p: PaymentsServices;
let today: string;

type Op =
  | { kind: 'days'; days: number }
  | { kind: 'provider'; amountMinor: number; replay: boolean }
  | { kind: 'cash'; amountMinor: number }
  | { kind: 'chargeback'; pick: number };

const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant('days' as const),
      days: fc.integer({ min: 1, max: 40 }),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant('provider' as const),
      amountMinor: fc.integer({ min: 100, max: 600_000 }),
      replay: fc.boolean(),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant('cash' as const),
      amountMinor: fc.integer({ min: 100, max: 300_000 }),
    }),
    weight: 1,
  },
  { arbitrary: fc.record({ kind: fc.constant('chargeback' as const), pick: fc.nat() }), weight: 1 },
);

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  p = paymentsServices(ctx, s, b);
  today = isoNow(ctx.clock, 'Africa/Accra');
});

afterAll(async () => {
  await ctx?.close();
});

describe('BC-07 any sequence of invoices and payments keeps the ledger whole', () => {
  it('holds with provider payments, replayed webhooks, chargebacks and cash mixed in', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          rent: fc.integer({ min: 10_000, max: 400_000 }),
          serviceCharge: fc.option(fc.integer({ min: 1_000, max: 50_000 }), { nil: null }),
          deposit: fc.option(fc.integer({ min: 10_000, max: 400_000 }), { nil: null }),
          cycle: fc.constantFrom('monthly' as const, 'quarterly' as const, 'annual' as const),
        }),
        fc.array(opArbitrary, { minLength: 4, maxLength: 12 }),
        async (terms, ops) => {
          const base = ctx.clock.now();
          const company = await moneyCompany(
            ctx,
            s,
            'landlord',
            `Prop ${randomUUID().slice(0, 6)}`,
          );
          const second = await staffIn(ctx, company.companyId, 'landlord', 'owner', 'Second Owner');
          const owner = (
            await s.owners.create(company.admin, {
              kind: 'individual',
              displayName: 'Property Owner',
            })
          ).id;
          const property = await propertyWithUnits(s, company.manager, {
            areaCode: 'ACC',
            propertyPart: 'PRP',
            ownerId: owner,
            units: [{ unitType: 'apartment', count: 1, bedrooms: 1 }],
          });
          await activeAccount(ctx, s, p, company.admin, second, {
            holder: 'owner',
            ownerId: owner,
          });
          const lease = await billedLease(ctx, s, b, company.manager, {
            unitId: Object.values(property.units)[0]!,
            tenantId: (
              await s.tenants.create(company.manager, {
                kind: 'individual',
                displayName: 'Property Tenant',
              })
            ).tenant.id,
            startDate: today,
            endDate: toIsoDate(addDays(addMonths(parseBusinessDate(today), 12), -1)),
            monthlyRentMinor: terms.rent,
            serviceChargeMonthlyMinor: terms.serviceCharge,
            depositMinor: terms.deposit,
            cycle: terms.cycle,
            signedOn: today,
            billingStartDate: today,
          });
          const sys = { companyId: company.companyId, actorKind: 'system' as const };
          const posted: { reference: string; webhook: PaymentWebhookRequest }[] = [];
          let day = today;
          try {
            for (const op of ops) {
              switch (op.kind) {
                case 'days':
                  ctx.clock.advance(op.days * DAY);
                  day = isoNow(ctx.clock, 'Africa/Accra');
                  await b.invoicing.generateAll(company.companyId, day);
                  await b.invoicing.accrueAll(company.companyId, day);
                  break;
                case 'provider': {
                  const invoices = await withCompany(ctx.database, sys, (tx) =>
                    tx.select().from(schema.invoice).where(eq(schema.invoice.leaseId, lease.id)),
                  );
                  const open: (typeof invoices)[number][] = [];
                  for (const invoice of invoices) {
                    const reason = await withCompany(ctx.database, sys, async (tx) =>
                      p.links.unavailableReason(
                        tx,
                        company.companyId,
                        await p.links.invoice(tx, invoice.id),
                      ),
                    );
                    if (!reason) open.push(invoice);
                  }
                  if (open.length === 0) break;
                  const { url } = await withCompany(ctx.database, sys, async (tx) =>
                    p.links.mint(tx, await p.links.invoice(tx, open[0]!.id)),
                  );
                  const token = url.split('/p/')[1]!;
                  const page = await p.page.open(token, CLIENT);
                  if (page.screen !== 'pay') break;
                  const amountMinor = Math.min(op.amountMinor, page.amounts.maxMinor);
                  const intent = await p.page.start(
                    token,
                    { ...CLIENT, ip: `192.0.2.${(posted.length % 250) + 1}` },
                    { amountMinor, method: 'card', submissionId: randomUUID() },
                  );
                  const reference = chargeReference(intent.intentId);
                  const webhook = (await p.primary.completeCharge(reference, {
                    status: 'success',
                  }))!;
                  await deliverWebhook(ctx, p, 'paystack', webhook);
                  posted.push({ reference, webhook });
                  if (op.replay) {
                    const before = await journalSum(ctx, company.companyId, 'true');
                    const count = await countOf(company.companyId, 'journal_entry');
                    expect((await deliverWebhook(ctx, p, 'paystack', webhook)).intake).toBe(
                      'duplicate',
                    );
                    expect(await countOf(company.companyId, 'journal_entry')).toBe(count);
                    expect(await journalSum(ctx, company.companyId, 'true')).toBe(before);
                  }
                  break;
                }
                case 'cash':
                  await approvedCash(ctx, s, b, company.manager, company.accountant, {
                    leaseId: lease.id,
                    amountMinor: op.amountMinor,
                    receivedOn: day,
                  });
                  break;
                case 'chargeback': {
                  const live: typeof posted = [];
                  for (const x of posted)
                    if ((await p.primary.verify(x.reference)).status === 'success') live.push(x);
                  if (live.length === 0) break;
                  const target = live[op.pick % live.length]!;
                  await deliverWebhook(
                    ctx,
                    p,
                    'paystack',
                    await p.primary.chargeback(target.reference),
                  );
                  break;
                }
              }
              const check = await b.subledger.check(company.companyId, { alert: false });
              expect(check.mismatches).toEqual([]);
              const state = await withCompany(ctx.database, sys, (tx) =>
                b.engine.load(tx, company.companyId, lease.id),
              );
              for (const line of state.lines) {
                const balance = lineBalance(line, state.allocations);
                expect(balance.outstandingMinor).toBeGreaterThanOrEqual(0);
              }
              for (const payment of state.payments)
                expect(paymentCredit(payment, state.allocations)).toBeGreaterThanOrEqual(0);
            }
          } finally {
            ctx.clock.set(base);
          }
        },
      ),
      { numRuns: RUNS, endOnFailure: true },
    );
  }, 600_000);
});

async function countOf(companyId: string, table: 'journal_entry'): Promise<number> {
  const rows = await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
    tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)),
  );
  return rows.rows[0]!.n;
}
