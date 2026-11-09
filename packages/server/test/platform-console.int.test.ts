import { schema, sql, withCompany, withSystem } from '@rent/db';
import { sqlState } from '@rent/db/testing';
import {
  addDays,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import type { Actor } from '@rent/domain/policy';
import { monthOf, previousMonth, shiftMonth } from '@rent/domain/subscription';
import { InMemoryAlert, type Alert, type AlertPort } from '@rent/integrations';
import { PgBoss } from 'pg-boss';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapPlatform } from '../src/admin/bootstrap';
import { SystemHealthService } from '../src/admin/health.service';
import { PlatformPricingService } from '../src/admin/pricing.service';
import { RulesConsoleService } from '../src/admin/rules-console.service';
import { UsageService } from '../src/admin/usage.service';
import { AppError } from '../src/core/errors';
import { DEAD_LETTER_QUEUE } from '../src/core/jobs/job';
import { PGBOSS_SCHEMA } from '../src/core/jobs/jobs.service';
import { StoredAlert } from '../src/core/stored-alert';
import { PolicyService } from '../src/policy/policy.service';
import { RulesService } from '../src/rules/rules.service';
import { termsAsOf } from '../src/subscription/catalogue';
import { SubscriptionCoreService } from '../src/subscription/core.service';
import { nextSubscriptionNumber } from '../src/subscription/numbering';
import { withPlatform } from '../src/subscription/platform';
import { asOwner, company, startServerTest, type ServerTestContext } from './support';
import { propertyWithUnits, staffIn, tenancyServices } from './support/tenancy';

/**
 * AD-10, the platform admin console (M10 decisions 3, 8, 14, 15 and 16; plan 4.8 and 4.9): the
 * platform bootstrap, prices, terms, discount codes and WhatsApp rates, usage and messaging costs,
 * system health with stored alerts, and the rules screen. Platform admins only, through
 * PolicyService; real PostgreSQL with RLS, pg-boss's schema installed.
 */
let ctx: ServerTestContext;
let policy: PolicyService;
let core: SubscriptionCoreService;
let pricing: PlatformPricingService;
let usage: UsageService;
let health: SystemHealthService;
let rulesConsole: RulesConsoleService;
let platformId: string;
let agencyId: string;
let landlordId: string;
let admin: Extract<Actor, { kind: 'platform_admin' }>;
let agencyAdmin: Awaited<ReturnType<typeof staffIn>>;
const invited: string[] = [];
const ADMIN_EMAIL = 'first.admin@platform.invalid';

const today = () => toIsoDate(businessDateOf(instantFrom(ctx.clock.now())));
const plusDays = (date: string, days: number) => toIsoDate(addDays(parseBusinessDate(date), days));

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
}

/** People as PersonAccounts makes them, without Better Auth (sign-up is off either way). */
const accounts = {
  async create(input: { name: string; email?: string }) {
    const id = uuidv7();
    await withSystem(ctx.database, {}, (tx) =>
      tx.insert(schema.person).values({
        id,
        name: input.name,
        email: (input.email ?? `${id}@test.invalid`).toLowerCase(),
        isTestContact: true,
      }),
    );
    return { personId: id };
  },
};

const bootstrap = () =>
  bootstrapPlatform(
    ctx.database,
    {
      accounts,
      audit: ctx.audit,
      invite: async (email) => {
        invited.push(email);
      },
    },
    {
      name: 'Rent Platform',
      legalName: 'Rent Platform Ltd (test)',
      email: ADMIN_EMAIL,
      adminName: 'Abena Platform',
    },
  );

/** The platform company's own chain: events with an action. */
async function platformEvents(action: string) {
  return withCompany(ctx.database, { companyId: platformId, actorKind: 'system' }, async (tx) => {
    const rows = await tx.execute<{
      actor_kind: string;
      actor_person_id: string | null;
      record_id: string | null;
      data: Record<string, unknown>;
    }>(
      sql`select actor_kind, actor_person_id, record_id, data from audit_event
          where action = ${action} order by seq`,
    );
    return rows.rows;
  });
}

beforeAll(async () => {
  ctx = await startServerTest();
  policy = new PolicyService();
  core = new SubscriptionCoreService(ctx.database, ctx.audit, ctx.clock);
  pricing = new PlatformPricingService(ctx.database, policy, ctx.audit, ctx.clock);
  usage = new UsageService(ctx.database, policy, core, ctx.clock);
  health = new SystemHealthService(ctx.database, policy, ctx.clock);
  rulesConsole = new RulesConsoleService(
    ctx.database,
    policy,
    new RulesService(ctx.database),
    ctx.audit,
    ctx.clock,
  );
  agencyId = await company(ctx, 'agency', 'Console Agency');
  landlordId = await company(ctx, 'landlord', 'Console Landlord');
  agencyAdmin = await staffIn(ctx, agencyId, 'agency', 'agency_admin', 'Agency Admin');
});

afterAll(async () => {
  await ctx?.close();
});

describe('AD-10 platform bootstrap (decision 14)', () => {
  it('makes the platform company, its book and its first admin, and invites them by email', async () => {
    const first = await bootstrap();
    platformId = first.platformCompanyId;
    expect(first).toMatchObject({
      companyCreated: true,
      personCreated: true,
      membershipCreated: true,
      invitationSent: true,
    });
    expect(invited).toEqual([ADMIN_EMAIL]);
    const made = await withCompany(
      ctx.database,
      { companyId: platformId, actorKind: 'system' },
      async (tx) =>
        (
          await tx.execute<{ kind: string; books: number; admin: string; membership: string }>(
            sql`select c.kind, (select count(*)::int from book b where b.kind = 'platform') as books,
                  p.id as admin, m.id as membership
                from company c join membership m on m.company_id = c.id and m.role = 'platform_admin'
                join person p on p.id = m.person_id`,
          )
        ).rows,
    );
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ kind: 'platform', books: 1 });
    admin = {
      kind: 'platform_admin',
      personId: made[0]!.admin,
      companyId: platformId,
      membershipId: made[0]!.membership,
      authMethod: 'password_totp',
    };
    // A real platform admin: the database's own check agrees.
    const check = await withSystem(
      ctx.database,
      { personId: admin.personId, actorKind: 'platform_admin' },
      async (tx) =>
        (await tx.execute<{ ok: boolean }>(sql`select app.is_platform_admin() as ok`)).rows[0]!.ok,
    );
    expect(check).toBe(true);
    expect(await platformEvents('platform.bootstrapped')).toHaveLength(1);
    expect((await platformEvents('membership.invited'))[0]!.data).toEqual({
      role: 'platform_admin',
      via: 'platform.bootstrap',
    });
  });

  it('is idempotent: a second run makes nothing, and invites again only until a password is set', async () => {
    const again = await bootstrap();
    expect(again).toEqual({
      platformCompanyId: platformId,
      companyCreated: false,
      personCreated: false,
      membershipCreated: false,
      invitationSent: true,
    });
    expect(invited).toEqual([ADMIN_EMAIL, ADMIN_EMAIL]);
    await withSystem(ctx.database, {}, (tx) =>
      tx.insert(schema.account).values({
        accountId: admin.personId,
        providerId: 'credential',
        userId: admin.personId,
        password: 'hashed-elsewhere',
      }),
    );
    expect((await bootstrap()).invitationSent).toBe(false);
    expect(invited).toHaveLength(2);
    const platforms = await withSystem(ctx.database, {}, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from app.company_ids()`),
    );
    expect(platforms.rows[0]!.n).toBe(3);
    await expect(
      bootstrapPlatform(
        ctx.database,
        { accounts, audit: ctx.audit, invite: async () => undefined },
        { name: 'Rent Platform', legalName: 'Rent Platform Ltd', email: 'not-an-email' },
      ),
    ).rejects.toThrow('The email address is not valid');
  });
});

describe('AD-10 plans and billing (decisions 3, 5, 8 and 15)', () => {
  it('lists the placeholder price lists, and adds a version from a future date only', async () => {
    const lists = await pricing.priceLists(admin);
    expect(lists.filter((l) => l.placeholder).map((l) => l.tier)).toEqual(
      expect.arrayContaining(['starter', 'growth', 'portfolio']),
    );
    const from = plusDays(today(), 1);
    const added = await pricing.addPriceList(admin, {
      tier: 'growth',
      ratesMinor: { single_room: 900, self_contained: 1600, commercial: 3200 },
      minimumMinor: 16_000,
      annualDiscountBps: 1_000,
      effectiveFrom: from,
    });
    expect(added).toMatchObject({
      tier: 'growth',
      ratesMinor: { single_room: 900, self_contained: 1600, commercial: 3200 },
      minimumMinor: 16_000,
      effectiveFrom: from,
      placeholder: false,
    });
    expect((await pricing.priceLists(admin)).map((l) => l.id)).toContain(added.id);
    expect(await platformEvents('pricing.price_list_added')).toEqual([
      expect.objectContaining({
        actor_kind: 'platform_admin',
        actor_person_id: admin.personId,
        record_id: added.id,
      }),
    ]);
    const input = {
      tier: 'growth' as const,
      ratesMinor: { single_room: 1, self_contained: 1, commercial: 1 },
      minimumMinor: 1,
      annualDiscountBps: 0,
    };
    expect(
      await refusal(pricing.addPriceList(admin, { ...input, effectiveFrom: today() })),
    ).toEqual({ status: 400, code: 'effective_from_past' });
    expect(await refusal(pricing.addPriceList(admin, { ...input, effectiveFrom: from }))).toEqual({
      status: 409,
      code: 'price_list_version_exists',
    });
    // The database refuses the past too when the code is bypassed (RA112).
    expect(
      await sqlState(
        withPlatform(
          ctx.database,
          { personId: admin.personId, actorKind: 'platform_admin' },
          (tx) =>
            tx.execute(
              sql`select app.add_price_list('starter', 1, 1, 1, 1, 0, current_date, false)`,
            ),
        ),
      ),
    ).toBe('RA112');
    expect(await refusal(pricing.priceLists(agencyAdmin))).toEqual({
      status: 403,
      code: 'forbidden',
    });
  });

  it('adds terms from today on, never in the past', async () => {
    const before = await pricing.terms(admin);
    expect(before.length).toBeGreaterThan(0);
    const terms = {
      trialDays: 45,
      graceDays: 14,
      readOnlyEnabled: true,
      dueDays: 7,
      retentionDaysAfterCancel: 90,
      vatRegistered: false,
    };
    const added = await pricing.addTerms(admin, { ...terms, effectiveFrom: today() });
    expect(added).toMatchObject({ ...terms, effectiveFrom: today() });
    expect((await pricing.terms(admin))[0]!.id).toBe(added.id);
    expect(
      await refusal(pricing.addTerms(admin, { ...terms, effectiveFrom: plusDays(today(), -1) })),
    ).toEqual({ status: 400, code: 'effective_from_past' });
    expect(await refusal(pricing.terms(agencyAdmin))).toEqual({ status: 403, code: 'forbidden' });
  });

  it('defines discount codes, each name once, and counts their uses', async () => {
    const code = await pricing.addDiscountCode(admin, {
      code: 'WELCOME10',
      kind: 'percentage',
      percentBps: 1_000,
      months: 3,
      expiresOn: plusDays(today(), 30),
      maxUses: 5,
    });
    expect(code).toMatchObject({
      code: 'WELCOME10',
      kind: 'percentage',
      percentBps: 1_000,
      amountMinor: null,
      months: 3,
      maxUses: 5,
      uses: 0,
    });
    for (const name of ['WELCOME10', ' welcome10 '])
      expect(
        await refusal(
          pricing.addDiscountCode(admin, {
            code: name,
            kind: 'fixed',
            amountMinor: 500,
            months: 1,
          }),
        ),
      ).toEqual({ status: 409, code: 'discount_code_taken' });
    expect(
      await refusal(
        pricing.addDiscountCode(admin, {
          code: 'BOTH',
          kind: 'fixed',
          amountMinor: 500,
          percentBps: 100,
          months: 1,
        }),
      ),
    ).toEqual({ status: 400, code: 'discount_terms' });
    expect(
      await refusal(
        pricing.addDiscountCode(admin, {
          code: 'LATE',
          kind: 'fixed',
          amountMinor: 500,
          months: 1,
          expiresOn: plusDays(today(), -1),
        }),
      ),
    ).toEqual({ status: 400, code: 'expires_on_past' });
    // A redemption counts as a use.
    await withPlatform(ctx.database, {}, async (tx, platform) => {
      const subscriber = (await core.subscriberCompany(tx, agencyId))!;
      const subscription = await core.ensure(tx, platform, subscriber, { trialDays: 0 });
      await tx.execute(
        sql`insert into discount_redemption (company_id, discount_code_id, subscription_id,
              subscriber_company_id, first_month, months)
            values (${platform}::uuid, ${code.id}::uuid, ${subscription.id}::uuid,
              ${agencyId}::uuid, ${monthOf(today())}, 3)`,
      );
    });
    expect((await pricing.discountCodes(admin)).find((c) => c.id === code.id)!.uses).toBe(1);
    expect(await refusal(pricing.discountCodes(agencyAdmin))).toEqual({
      status: 403,
      code: 'forbidden',
    });
  });

  it('keeps an editable WhatsApp rate table, one version per category and day', async () => {
    const utility = await pricing.addWhatsappRate(admin, {
      category: 'utility',
      rateMinor: 35,
      effectiveFrom: '2026-01-01',
    });
    await pricing.addWhatsappRate(admin, {
      category: 'service',
      rateMinor: 20,
      effectiveFrom: '2026-01-01',
    });
    expect(utility).toMatchObject({
      category: 'utility',
      rateMinor: 35,
      effectiveFrom: '2026-01-01',
    });
    expect((await pricing.whatsappRates(admin)).map((r) => r.category)).toEqual([
      'service',
      'utility',
    ]);
    expect(
      await refusal(
        pricing.addWhatsappRate(admin, {
          category: 'utility',
          rateMinor: 40,
          effectiveFrom: '2026-01-01',
        }),
      ),
    ).toEqual({ status: 409, code: 'whatsapp_rate_version_exists' });
  });
});

describe('AD-10 usage and messaging costs (decision 15)', () => {
  const month = () => previousMonth(monthOf(today()));

  beforeAll(async () => {
    const s = tenancyServices(ctx);
    const manager = await staffIn(ctx, agencyId, 'agency', 'property_manager', 'Usage Manager');
    const ownerId = (
      await s.owners.create(agencyAdmin, { kind: 'individual', displayName: 'Usage Owner' })
    ).id;
    await propertyWithUnits(s, manager, {
      areaCode: 'ACC',
      propertyPart: 'USE',
      ownerId,
      units: [{ unitType: 'apartment', count: 3, bedrooms: 1 }],
    });

    // Last month's snapshot and invoice, past due (as the invoice job leaves them).
    await withPlatform(ctx.database, {}, async (tx, platform) => {
      const subscription = (await core.find(tx, agencyId))!;
      const snapshot = await tx.execute<{ id: string }>(
        sql`insert into billing_snapshot (company_id, subscription_id, subscriber_company_id, month,
              single_room_units, self_contained_units, commercial_units)
            values (${platform}::uuid, ${subscription.id}::uuid, ${agencyId}::uuid, ${month()},
              1, 2, 0)
            returning id`,
      );
      const terms = await termsAsOf(tx, today());
      const prices = await tx.execute<{ id: string }>(sql`select id from price_list`);
      const number = await nextSubscriptionNumber(tx, platform, 'invoice', 2026);
      await tx.execute(
        sql`insert into subscription_invoice (company_id, subscription_id, subscriber_company_id,
              number, month, snapshot_id, issued_on, due_on, subtotal_minor, discount_minor,
              net_minor, vat_minor, total_minor, price_list_ids, terms_id, template_key,
              template_version)
            values (${platform}::uuid, ${subscription.id}::uuid, ${agencyId}::uuid, ${number},
              ${month()}, ${snapshot.rows[0]!.id}::uuid, ${plusDays(today(), -10)}::date,
              ${plusDays(today(), -3)}::date, 4000, 0, 4000, 0, 4000,
              ${`{${prices.rows.map((r) => r.id).join(',')}}`}::uuid[], ${terms.id}::uuid,
              'subscription.invoice', 1)`,
      );
    });

    // Messages the agency sent: the month's, and one the month before (not counted).
    const at = `${month()}-15T12:00:00Z`;
    const before = `${shiftMonth(month(), -1)}-15T12:00:00Z`;
    await withCompany(ctx.database, { companyId: agencyId, actorKind: 'system' }, async (tx) => {
      const message = async (channel: string) => {
        const id = uuidv7();
        await tx.execute(
          sql`insert into message (id, company_id, recipient_type, staff_person_id, purpose, body,
                channels)
              values (${id}::uuid, ${agencyId}::uuid, 'staff', ${agencyAdmin.personId}::uuid,
                'staff_notice', 'Test', ${`{${channel}}`}::text[])`,
        );
        return id;
      };
      const event = (
        messageId: string,
        fields: {
          status: string;
          channel: string;
          provider: string;
          id: string;
          at: string;
          cost?: number;
          pricing?: string;
          billable?: boolean;
        },
      ) =>
        tx.execute(
          sql`insert into message_event (company_id, message_id, status, channel, provider,
                provider_message_id, cost_minor, currency, pricing_category, billable, occurred_at)
              values (${agencyId}::uuid, ${messageId}::uuid, ${fields.status}, ${fields.channel},
                ${fields.provider}, ${fields.id}, ${fields.cost ?? null}::bigint,
                ${fields.cost === undefined ? null : 'GHS'}, ${fields.pricing ?? null},
                ${fields.billable ?? null}::boolean, ${fields.at}::timestamptz)`,
        );
      const sms1 = await message('sms');
      await event(sms1, {
        status: 'sent',
        channel: 'sms',
        provider: 'hubtel',
        id: 'sms-1',
        at,
        cost: 6,
      });
      await event(sms1, {
        status: 'delivered',
        channel: 'sms',
        provider: 'hubtel',
        id: 'sms-1',
        at,
      });
      const sms2 = await message('sms');
      await event(sms2, { status: 'sent', channel: 'sms', provider: 'hubtel', id: 'sms-2', at });
      await event(sms2, {
        status: 'delivered',
        channel: 'sms',
        provider: 'hubtel',
        id: 'sms-2',
        at,
        cost: 4,
      });
      const wa1 = await message('whatsapp');
      await event(wa1, { status: 'sent', channel: 'whatsapp', provider: 'meta', id: 'wa-1', at });
      await event(wa1, {
        status: 'delivered',
        channel: 'whatsapp',
        provider: 'meta',
        id: 'wa-1',
        at,
        pricing: 'utility',
        billable: true,
      });
      await event(wa1, {
        status: 'read',
        channel: 'whatsapp',
        provider: 'meta',
        id: 'wa-1',
        at,
        pricing: 'utility',
        billable: true,
      });
      const wa2 = await message('whatsapp');
      await event(wa2, { status: 'sent', channel: 'whatsapp', provider: 'meta', id: 'wa-2', at });
      await event(wa2, {
        status: 'delivered',
        channel: 'whatsapp',
        provider: 'meta',
        id: 'wa-2',
        at,
        pricing: 'service',
        billable: false,
      });
      const mail = await message('email');
      await event(mail, { status: 'sent', channel: 'email', provider: 'smtp', id: 'em-1', at });
      const push = await message('push');
      await event(push, { status: 'sent', channel: 'push', provider: 'expo', id: 'push-1a', at });
      await event(push, { status: 'sent', channel: 'push', provider: 'expo', id: 'push-1b', at });
      const old = await message('sms');
      await event(old, {
        status: 'sent',
        channel: 'sms',
        provider: 'hubtel',
        id: 'sms-old',
        at: before,
        cost: 9,
      });
    });
  });

  it('reports each company’s month: units, billable units, money and messages, WhatsApp estimated', async () => {
    const rows = await usage.usage(admin);
    expect(rows.map((r) => r.company.name).sort()).toEqual(['Console Agency', 'Console Landlord']);
    expect(rows.find((r) => r.company.id === agencyId)).toEqual({
      company: { id: agencyId, name: 'Console Agency' },
      month: month(),
      units: 3,
      billableUnits: { single_room: 1, self_contained: 2, commercial: 0 },
      invoicedMinor: 4000,
      paidMinor: 0,
      arrearsMinor: 4000,
      messages: { sms: 2, whatsapp: 2, email: 1, push: 1 },
      smsCostMinor: 10,
      // One utility message at the rate table's 35 pesewas; the service one was free.
      whatsappCostEstimatedMinor: 35,
    });
    expect(rows.find((r) => r.company.id === landlordId)).toMatchObject({
      units: 0,
      invoicedMinor: 0,
      messages: { sms: 0, whatsapp: 0, email: 0, push: 0 },
    });
    // The month before: only the old SMS.
    const earlier = await usage.usage(admin, shiftMonth(month(), -1));
    expect(earlier.find((r) => r.company.id === agencyId)).toMatchObject({
      messages: { sms: 1, whatsapp: 0, email: 0, push: 0 },
      smsCostMinor: 9,
      billableUnits: { single_room: 0, self_contained: 0, commercial: 0 },
    });
    const page = await usage.ofCompany(admin, agencyId, 2);
    expect(page.map((r) => r.month)).toEqual([month(), shiftMonth(month(), -1)]);
  });

  it('is for platform admins only, in the API and in the database', async () => {
    expect(await refusal(usage.usage(agencyAdmin))).toEqual({ status: 403, code: 'forbidden' });
    expect(await refusal(usage.usage(admin, '2026-13'))).toEqual({
      status: 400,
      code: 'bad_month',
    });
    for (const call of [
      sql`select * from app.platform_messaging_usage(${month()})`,
      sql`select * from app.platform_unit_counts()`,
      sql`select * from app.support_sessions('{}'::uuid[])`,
      sql`select * from app.platform_job_queues()`,
      sql`select * from app.platform_scheduled_jobs()`,
      sql`select app.platform_failed_webhooks(24)`,
    ])
      expect(
        await sqlState(
          withCompany(
            ctx.database,
            { companyId: agencyId, personId: agencyAdmin.personId, actorKind: 'staff' },
            (tx) => tx.execute(call),
          ),
        ),
      ).toBe('RA063');
  });
});

describe('AD-10 system health (decision 15)', () => {
  let boss: PgBoss;
  const queue = 'm10.health-test';

  beforeAll(async () => {
    boss = new PgBoss({
      connectionString: ctx.db.appUrl,
      schema: PGBOSS_SCHEMA,
      migrate: false,
      supervise: false,
      schedule: false,
      max: 2,
    });
    await boss.start();
    await boss.createQueue(queue, { retryLimit: 0 });
    await boss.createQueue(DEAD_LETTER_QUEUE, { retryLimit: 0 });
    await boss.send(queue, { n: 1 });
    await boss.send(queue, { n: 2 });
    const [job] = await boss.fetch(queue);
    await boss.fail(queue, job!.id, { why: 'test' });
    await boss.send(DEAD_LETTER_QUEUE, { __job: queue });
    await boss.schedule(queue, '0 3 * * *', {}, { tz: 'Africa/Accra' });

    await withSystem(ctx.database, {}, async (tx) => {
      for (const [eventId, status] of [
        ['evt-failed', 'failed'],
        ['evt-done', 'processed'],
      ] as const)
        await tx.execute(
          sql`insert into webhook_inbox (provider, event_id, raw_body, headers, signature_valid, status)
              values ('paystack', ${eventId}, '{}', '{}'::jsonb, true, ${status})`,
        );
    });

    // The nightly verification's results, as audit.verify-chain records them.
    await withCompany(ctx.database, { companyId: platformId, actorKind: 'system' }, async (tx) => {
      for (const [companyId, ok] of [
        [agencyId, true],
        [landlordId, false],
      ] as const)
        await ctx.audit.append(tx, {
          companyId: platformId,
          action: 'audit.chain_verified',
          recordType: 'company',
          recordId: companyId,
          data: { date: today(), ok, events: 3, firstBadSeq: ok ? null : 2 },
        });
    });
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false, close: true });
  });

  it('shows queues, dead letters, failed webhooks, scheduled jobs, chain checks and alerts', async () => {
    await new StoredAlert(new InMemoryAlert(), ctx.database).raise({
      severity: 'critical',
      code: 'job.dead_lettered',
      message: 'Job m10.health-test failed after all retries',
      context: { job: queue, companyId: agencyId },
    });
    const view = await health.health(admin);
    expect(view.queues.find((q) => q.name === queue)).toEqual({
      name: queue,
      queued: 1,
      active: 0,
      failed24h: 1,
    });
    expect(view.queues.map((q) => q.name)).not.toContain(DEAD_LETTER_QUEUE);
    expect(view.deadLettered24h).toBe(1);
    expect(view.failedWebhooks).toBe(1);
    const scheduled = view.scheduledJobs.find((j) => j.name === queue)!;
    expect(scheduled.lastState).toBe('failed');
    expect(scheduled.lastRunAt).toBeInstanceOf(Date);
    expect(view.auditChains.broken).toBe(1);
    expect(view.auditChains.checkedAt).toBeInstanceOf(Date);
    expect(view.recentAlerts[0]).toMatchObject({
      severity: 'critical',
      code: 'job.dead_lettered',
      message: 'Job m10.health-test failed after all retries',
      companyId: agencyId,
    });
    expect(await refusal(health.health(agencyAdmin))).toEqual({ status: 403, code: 'forbidden' });
  });
});

describe('AD-10 stored alerts (decision 15)', () => {
  it('stores every alert with ids only, sends it as before, and never stops it', async () => {
    const sent = new InMemoryAlert();
    const alert: Alert = {
      severity: 'warning',
      code: 'm10.test_alert',
      message: 'Call +233 20 000 0001 or write to ama@example.com about it',
      context: {
        companyId: landlordId,
        phone: '+233200000001',
        email: 'ama@example.com',
        count: 2,
      },
    };
    await new StoredAlert(sent, ctx.database).raise(alert);
    expect(sent.byCode('m10.test_alert')).toHaveLength(1);
    // A target that fails: the alert is stored all the same, and the failure still surfaces.
    const failing: AlertPort = {
      raise: async () => {
        throw new Error('the mail server is down');
      },
    };
    await expect(
      new StoredAlert(failing, ctx.database).raise({ ...alert, code: 'm10.test_alert_2' }),
    ).rejects.toThrow('the mail server is down');
    // The application role only appends; the console reads through app.recent_alerts. Here, as
    // the owner role, to see the stored row whole.
    const rows = await asOwner(
      ctx,
      `select code, severity, message, subject_company_id, data from alert_event
       where code like 'm10.test_alert%' order by occurred_at, id`,
    );
    expect(rows.map((r) => r.code)).toEqual(['m10.test_alert', 'm10.test_alert_2']);
    const stored = rows[0]!;
    expect(stored).toMatchObject({ severity: 'warning', subject_company_id: landlordId });
    expect(stored.message).toBe('Call [PHONE] or write to [EMAIL] about it');
    expect(stored.data).toEqual({
      companyId: landlordId,
      phone: '[REDACTED]',
      email: '[REDACTED]',
      count: 2,
    });
    // Append-only, even for the owner role.
    expect(
      await sqlState(
        asOwner(ctx, `update alert_event set message = 'changed' where code = 'm10.test_alert'`),
      ),
    ).toBe('RA001');
  });
});

describe('TX-08 the rules screen (M10 decision 16)', () => {
  it('lists every row with its state: in force, superseded or from a future date', async () => {
    const rows = await rulesConsole.history(admin, { country: 'GH' });
    const residential = rows.filter((r) => r.key === 'rent_tax.rate.residential');
    expect(residential).toHaveLength(1);
    expect(residential[0]).toMatchObject({
      value: { bps: 800 },
      verificationStatus: 'from_prd',
      warning: true,
      state: 'in_force',
    });
    expect(rows.find((r) => r.key === 'vat.platform_subscription')).toMatchObject({
      verificationStatus: 'unverified',
      warning: true,
      state: 'in_force',
    });
    expect(await refusal(rulesConsole.history(agencyAdmin, { country: 'GH' }))).toEqual({
      status: 403,
      code: 'forbidden',
    });
  });

  it('adds a row as rules:add does, append-only and audited, refusing a bad value', async () => {
    const future = plusDays(today(), 60);
    const added = await rulesConsole.add(admin, {
      country: 'GH',
      key: 'rent_tax.due_days_after_receipt',
      value: { days: 30 },
      effectiveFrom: future,
      source: 'TX-02; GRA guidance (test)',
      verificationStatus: 'verified',
      verifiedBy: 'Kwame Tax Adviser (test)',
    });
    expect(added).toMatchObject({
      key: 'rent_tax.due_days_after_receipt',
      effectiveFrom: future,
      verificationStatus: 'verified',
      verifiedBy: 'Kwame Tax Adviser (test)',
      warning: false,
      createdBy: 'Abena Platform',
      state: 'future',
    });
    const history = await rulesConsole.history(admin, {
      country: 'GH',
      key: 'rent_tax.due_days_after_receipt',
    });
    expect(history.map((r) => r.state)).toEqual(['future', 'in_force']);
    expect(await platformEvents('rule.added')).toEqual([
      expect.objectContaining({
        actor_kind: 'platform_admin',
        actor_person_id: admin.personId,
        record_id: added.id,
      }),
    ]);
    // A version from an earlier date supersedes the old one from that day.
    const now = await rulesConsole.add(admin, {
      country: 'GH',
      key: 'rent_tax.due_days_after_receipt',
      value: { days: 30 },
      effectiveFrom: plusDays(today(), -1),
      source: 'TX-02 (test)',
      verificationStatus: 'from_prd',
    });
    expect(
      (
        await rulesConsole.history(admin, { country: 'GH', key: 'rent_tax.due_days_after_receipt' })
      ).map((r) => [r.id === now.id, r.state]),
    ).toEqual([
      [false, 'future'],
      [true, 'in_force'],
      [false, 'superseded'],
    ]);

    const base = {
      country: 'GH',
      effectiveFrom: future,
      source: 'Test',
      verificationStatus: 'unverified' as const,
    };
    expect(
      await refusal(
        rulesConsole.add(admin, {
          ...base,
          key: 'rent_tax.due_days_after_receipt',
          value: { days: -1 },
        }),
      ),
    ).toEqual({ status: 400, code: 'rule_value' });
    expect(
      await refusal(rulesConsole.add(admin, { ...base, key: 'made_up.key', value: { days: 1 } })),
    ).toEqual({ status: 400, code: 'rule_key' });
    expect(
      await refusal(
        rulesConsole.add(admin, {
          ...base,
          key: 'rent_tax.due_days_after_receipt',
          value: { days: 30 },
          verificationStatus: 'verified',
        }),
      ),
    ).toEqual({ status: 400, code: 'rule_verifier_required' });
    expect(
      await refusal(
        rulesConsole.add(agencyAdmin, {
          ...base,
          key: 'rent_tax.due_days_after_receipt',
          value: { days: 30 },
        }),
      ),
    ).toEqual({ status: 403, code: 'forbidden' });
  });
});
