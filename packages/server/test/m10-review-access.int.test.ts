import { randomUUID } from 'node:crypto';
import { sql, withSystem } from '@rent/db';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import type { Actor } from '@rent/domain/policy';
import {
  monthOf,
  shiftMonth,
  SUBSCRIPTION_ENDED_MESSAGE,
  SUBSCRIPTION_READ_ONLY_MESSAGE,
} from '@rent/domain/subscription';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoNow } from '../src/billing/records';
import { MembershipsService } from '../src/companies/memberships.service';
import { createLogger } from '../src/core/logging/logger';
import { createAuth, type Auth } from '../src/identity/auth';
import { IdentityService } from '../src/identity/identity.service';
import { MembershipDirectory } from '../src/identity/memberships';
import { PersonAccounts } from '../src/identity/person-accounts';
import { withPlatform } from '../src/subscription/platform';
import { asSuperuser, company, startServerTest, type ServerTestContext } from './support';
import { billingServices, moneyCompany, type BillingServices } from './support/billing';
import { noticesServices, type NoticesServices } from './support/notices';
import { deliverWebhook, paymentsServices, type PaymentsServices } from './support/payments';
import {
  reportingDashboardServices,
  type ReportingDashboardServices,
} from './support/reporting-dashboard';
import {
  openInvoice,
  subscribe,
  subscriptionPaymentsServices,
  type SubscriptionPaymentsServices,
} from './support/subscription-payments';
import {
  propertyWithUnits,
  staffIn,
  tenancyServices,
  uploadLeaseFile,
  type TenancyServices,
} from './support/tenancy';

/**
 * M10 review, access items, on real PostgreSQL with RLS and a fixed clock:
 * - BE-17: read-only reaches a signed-in staff member through the real chain: the session's
 *   person → MembershipDirectory.forPerson → app.company_access_for_person → actorFor sets
 *   `subscriptionAccess`; a change is refused with subscription_read_only; after paying, the next
 *   request's actor has full access again. Only Better Auth's session lookup is a stand-in.
 * - BE-27: a cancelled company's staff are told the subscription has ended, not that it is past
 *   due (app.company_ended_for_person → `subscriptionEnded`).
 * - BE-18: an admin of a read-only company removes a member, whose sessions lose the company at
 *   once; inviting stays paused.
 * - BE-24: refreshing the dashboard stays open while read-only, to the roles that may start it.
 * - BE-19: after a downgrade, notices already issued stay readable and servable; composing new
 *   ones stays with the plan.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let p: PaymentsServices;
let sp: SubscriptionPaymentsServices;
let n: NoticesServices;
let r: ReportingDashboardServices;
let memberships: MembershipsService;
let today: string;
let agency: Awaited<ReturnType<typeof moneyCompany>>;
let leaver: Awaited<ReturnType<typeof staffIn>>;
let issuedNoticeId: string;
let draftNoticeId: string;

/** Monday 9 November 2026, 10:00 in Accra. */
const START = new Date('2026-11-09T10:00:00Z');
const plusDays = (date: string, days: number) => toIsoDate(addDays(parseBusinessDate(date), days));

/**
 * The actor a request from this person gets, as the API's guard resolves it: a session whose
 * Better Auth lookup is a stand-in (password and TOTP, in this company), then the real identity
 * service, directory and database functions.
 */
async function signedIn(personId: string, companyId: string): Promise<Actor | null> {
  const now = ctx.clock.now();
  const auth = {
    api: {
      getSession: async () => ({
        session: {
          id: randomUUID(),
          createdAt: now,
          expiresAt: new Date(now.getTime() + 3_600_000),
          authMethod: 'password_totp',
          activeCompanyId: companyId,
        },
        user: { id: personId, name: 'Signed in' },
      }),
    },
  } as unknown as Auth;
  const resolved = await new IdentityService(auth, ctx.database, ctx.config, ctx.clock).resolve(
    new Headers(),
  );
  return resolved?.actor ?? null;
}

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as { status?: number; code?: string; message?: string };
    return { status: e.status, code: e.code, message: e.message };
  }
  throw new Error('expected a refusal');
}

async function refreshSubscription(companyId: string) {
  return withPlatform(ctx.database, {}, async (tx, platformId) => {
    const subscriber = await sp.core.subscriberCompany(tx, companyId);
    const sub = await sp.core.find(tx, companyId);
    return sp.core.refresh(tx, platformId, sub!, subscriber!);
  });
}

beforeAll(async () => {
  ctx = await startServerTest();
  ctx.clock.set(START);
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  p = paymentsServices(ctx, s, b);
  sp = subscriptionPaymentsServices(ctx, s, b, p);
  n = noticesServices(ctx, s, b);
  r = reportingDashboardServices(ctx, s, b);
  const auth = createAuth({
    database: ctx.database,
    config: ctx.config,
    sms: s.sms,
    email: s.email,
    clock: ctx.clock,
    logger: createLogger({ level: 'silent' }),
    memberships: new MembershipDirectory(ctx.database),
  });
  memberships = new MembershipsService(
    ctx.database,
    s.policy,
    new PersonAccounts(auth),
    ctx.audit,
    auth,
    ctx.config,
  );
  await company(ctx, 'platform', 'Rent Platform');
  today = isoNow(ctx.clock, 'Africa/Accra');

  // While it has full access and notices on its plan: a notice issued, and one still a draft.
  agency = await moneyCompany(ctx, s, 'agency', 'Access Review Agency');
  leaver = await staffIn(ctx, agency.companyId, 'agency', 'property_manager', 'Leaving Manager');
  const ownerId = (
    await s.owners.create(agency.admin, { kind: 'individual', displayName: 'Review Owner' })
  ).id;
  const units = Object.values(
    (
      await propertyWithUnits(s, agency.manager, {
        areaCode: 'ACC',
        propertyPart: 'REV',
        ownerId,
        units: [{ unitType: 'apartment', count: 2, bedrooms: 2 }],
      })
    ).units,
  );
  const leaseIds: string[] = [];
  for (const [i, unitId] of units.entries()) {
    const { tenant } = await s.tenants.create(agency.manager, {
      kind: 'individual',
      displayName: `Review Tenant ${i}`,
      phone: `+23320000085${i}`,
      consent: { sms: true },
    });
    const start = plusDays(today, -60);
    const lease = await s.leases.recordPaper(agency.manager, {
      unitId,
      tenantId: tenant.id,
      startDate: start,
      endDate: plusDays(start, 364),
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      noticeDays: 30,
      parties: [{ role: 'tenant', name: tenant.displayName }],
      scanUploadId: await uploadLeaseFile(ctx, s, agency.manager),
      signedOn: start,
    });
    leaseIds.push(lease.id);
  }
  const breach = (leaseId: string) =>
    n.notices.create(agency.manager, {
      type: 'breach',
      subtype: 'noise',
      leaseId,
      fields: { particulars: 'Loud music after midnight', remedyBy: plusDays(today, 10) },
    });
  issuedNoticeId = (await breach(leaseIds[0]!)).id;
  await n.notices.issue(agency.manager, issuedNoticeId);
  draftNoticeId = (await breach(leaseIds[1]!)).id;

  // Then the subscription falls into arrears beyond the grace period: read-only, by the engine.
  await subscribe(ctx, sp, agency.companyId);
  await openInvoice(ctx, b.posting, agency.companyId, {
    month: shiftMonth(monthOf(today), -2),
    totalMinor: 15_000,
    issuedOn: plusDays(today, -40),
    dueOn: plusDays(today, -33),
  });
  expect(await refreshSubscription(agency.companyId)).toMatchObject({ access: 'read_only' });
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

describe('BE-17 PB-11 read-only through the real sign-in chain', () => {
  it('builds a read-only actor from the directory, and refuses a change with the past-due words', async () => {
    const [view] = await new MembershipDirectory(ctx.database).forPerson(agency.manager.personId);
    expect(view).toMatchObject({ companyId: agency.companyId, companyAccess: 'read_only' });
    expect(view).not.toHaveProperty('companyEnded');
    const actor = await signedIn(agency.manager.personId, agency.companyId);
    expect(actor).toMatchObject({
      kind: 'staff',
      role: 'property_manager',
      subscriptionAccess: 'read_only',
    });
    expect(actor).not.toHaveProperty('subscriptionEnded');
    expect(
      await refusalOf(
        s.tenants.create(actor, { kind: 'individual', displayName: 'Refused Tenant' }),
      ),
    ).toEqual({
      status: 403,
      code: 'subscription_read_only',
      message: SUBSCRIPTION_READ_ONLY_MESSAGE,
    });
  });
});

describe('BE-24 DA-01 refreshing the dashboard while read-only (decision 11)', () => {
  it('stays open to those who may start it, and is refused to the rest as before', async () => {
    const manager = await signedIn(agency.manager.personId, agency.companyId);
    await expect(r.dashboard.refresh(manager)).resolves.toEqual({ queued: true });
    const accountant = await signedIn(agency.accountant.personId, agency.companyId);
    expect(accountant).toMatchObject({ subscriptionAccess: 'read_only' });
    expect(await refusalOf(r.dashboard.refresh(accountant))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    // Changing a lease, the action that decides who may refresh, is still paused.
    expect(
      (
        await refusalOf(
          s.leases.recordPaper(manager, {
            unitId: randomUUID(),
            tenantId: randomUUID(),
            startDate: today,
            endDate: plusDays(today, 30),
            monthlyRentMinor: 1,
            cycle: 'monthly',
            noticeDays: 30,
            parties: [],
            scanUploadId: randomUUID(),
            signedOn: today,
          }),
        )
      ).code,
    ).toBe('subscription_read_only');
  });
});

describe('BE-18 AD-03 removing a member while read-only', () => {
  it('lets an admin remove someone, whose sessions lose the company at once; inviting stays paused', async () => {
    const admin = await signedIn(agency.admin.personId, agency.companyId);
    expect(admin).toMatchObject({ role: 'agency_admin', subscriptionAccess: 'read_only' });
    expect(await signedIn(leaver.personId, agency.companyId)).toMatchObject({
      membershipId: leaver.membershipId,
    });
    expect(
      await refusalOf(
        memberships.invite(admin, {
          name: 'New Hire',
          email: 'new.hire@review.invalid',
          role: 'accountant',
        }),
      ),
    ).toMatchObject({ status: 403, code: 'subscription_read_only' });
    expect(
      await refusalOf(memberships.update(admin, leaver.membershipId, { nominatedApprover: true })),
    ).toMatchObject({ status: 403, code: 'subscription_read_only' });
    // A manager may not remove anyone, read-only or not.
    const manager = await signedIn(agency.manager.personId, agency.companyId);
    expect(await refusalOf(memberships.revoke(manager, leaver.membershipId))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });

    const removed = await memberships.revoke(admin, leaver.membershipId);
    expect(removed).toMatchObject({ membershipId: leaver.membershipId, status: 'revoked' });
    expect(await new MembershipDirectory(ctx.database).forPerson(leaver.personId)).toEqual([]);
    // The removed person's next request has no actor in the company.
    expect(await signedIn(leaver.personId, agency.companyId)).toBeNull();
  });
});

describe('BE-17 PB-11 paying restores full access to the next request', () => {
  it('a read-only admin pays; the same person’s next request is a full-access actor', async () => {
    const admin = await signedIn(agency.admin.personId, agency.companyId);
    const started = await sp.payments.pay(admin, { purpose: 'invoices', channel: 'card' });
    const webhook = await p.primary.completeCharge(started.reference, { status: 'success' });
    expect((await deliverWebhook(ctx, p, 'paystack', webhook!)).outcome).toBe('posted');
    const manager = await signedIn(agency.manager.personId, agency.companyId);
    expect(manager).toMatchObject({ kind: 'staff', role: 'property_manager' });
    expect(manager).not.toHaveProperty('subscriptionAccess');
    await expect(
      s.tenants.create(manager, { kind: 'individual', displayName: 'Allowed Again' }),
    ).resolves.toMatchObject({ tenant: { id: expect.any(String) } });
  });
});

describe('BE-27 PB-10 a cancelled company’s staff are told it has ended (decision 12)', () => {
  it('gives the ended words, same code, through the real directory', async () => {
    const landlord = await moneyCompany(ctx, s, 'landlord', 'Ended Landlord');
    await subscribe(ctx, sp, landlord.companyId);
    // Cancelled at the end of last month: the engine derives cancelled and read-only (90 days).
    await asSuperuser(
      ctx,
      "update subscription set status = 'cancel_scheduled', cancels_on = $2::date, cancel_reason = 'Sold the house' where subscriber_company_id = $1",
      [landlord.companyId, plusDays(`${monthOf(today)}-01`, -1)],
    );
    expect(await refreshSubscription(landlord.companyId)).toMatchObject({
      status: 'cancelled',
      access: 'read_only',
    });
    const [view] = await new MembershipDirectory(ctx.database).forPerson(landlord.admin.personId);
    expect(view).toMatchObject({ companyAccess: 'read_only', companyEnded: true });
    const owner = await signedIn(landlord.admin.personId, landlord.companyId);
    expect(owner).toMatchObject({ subscriptionAccess: 'read_only', subscriptionEnded: true });
    const refused = await refusalOf(
      s.owners.create(owner, { kind: 'individual', displayName: 'Refused' }),
    );
    expect(refused).toEqual({
      status: 403,
      code: 'subscription_read_only',
      message: SUBSCRIPTION_ENDED_MESSAGE,
    });
    expect(refused.message!.toLowerCase()).not.toContain('past due');
    // Reading still works.
    await expect(s.owners.list(owner)).resolves.toEqual(expect.any(Array));
  });
});

describe('BE-19 LN-01 notices already issued after a downgrade (decision 11)', () => {
  it('stay readable and servable; drafts and composing stay with the plan', async () => {
    await asSuperuser(ctx, "update company set plan = 'starter' where id = $1", [agency.companyId]);
    try {
      const manager = agency.manager;
      const listed = await n.notices.list(manager, {});
      expect(listed.map((row) => row.id)).toEqual([issuedNoticeId]);
      await expect(n.notices.summary(manager)).resolves.toMatchObject({ drafts: 0 });
      await expect(n.notices.get(manager, issuedNoticeId)).resolves.toMatchObject({
        id: issuedNoticeId,
      });
      expect(await refusalOf(n.notices.get(manager, draftNoticeId))).toMatchObject({
        status: 403,
        code: 'not_on_plan',
      });
      await expect(
        n.notices.recordService(manager, issuedNoticeId, {
          method: 'handed_to_tenant',
          servedAt: ctx.clock.now().toISOString(),
          servedByName: 'Kojo Caretaker',
        }),
      ).resolves.toMatchObject({ id: issuedNoticeId });
      await expect(
        n.notices.createUpload(manager, {
          purpose: 'service_photo',
          contentType: 'image/jpeg',
          sizeBytes: 1_000,
        }),
      ).resolves.toMatchObject({ uploadId: expect.any(String) });
      // Composing, drafts and issuing stay with the plan.
      expect(
        await refusalOf(
          n.notices.create(manager, {
            type: 'breach',
            subtype: 'noise',
            leaseId: randomUUID(),
            fields: { particulars: 'Again', remedyBy: plusDays(today, 10) },
          }),
        ),
      ).toMatchObject({ status: 403, code: 'not_on_plan' });
      expect(await refusalOf(n.notices.issue(manager, draftNoticeId))).toMatchObject({
        code: 'not_on_plan',
      });
      expect(await refusalOf(n.notices.preview(manager, draftNoticeId))).toMatchObject({
        code: 'not_on_plan',
      });
      await expect(n.notices.types(manager)).resolves.toMatchObject({ onPlan: false });
    } finally {
      await asSuperuser(ctx, "update company set plan = 'growth' where id = $1", [
        agency.companyId,
      ]);
    }
  });

  it('keeps notices from a Starter company that never issued one, as before', async () => {
    const starter = await moneyCompany(ctx, s, 'landlord', 'Never Notices Landlord');
    await asSuperuser(ctx, "update company set plan = 'starter' where id = $1", [
      starter.companyId,
    ]);
    expect(await refusalOf(n.notices.list(starter.admin, {}))).toMatchObject({
      status: 403,
      code: 'not_on_plan',
    });
    expect(await refusalOf(n.notices.summary(starter.admin))).toMatchObject({
      code: 'not_on_plan',
    });
  });
});

describe('BE-27 the directory reads only company ids for a person', () => {
  it('lists ended companies only among the person’s own memberships', async () => {
    const rows = await withSystem(ctx.database, { personId: agency.admin.personId }, (tx) =>
      tx.execute<{ company_id: string }>(
        sql`select company_id from app.company_ended_for_person(${agency.admin.personId}::uuid)`,
      ),
    );
    expect(rows.rows).toEqual([]);
  });
});
