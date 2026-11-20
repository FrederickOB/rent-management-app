import { runSql } from '@rent/db/testing';
import { CallbackAlert, InMemoryEmail, InMemorySms, type Alert } from '@rent/integrations';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bootstrapPlatform } from '../src/admin/bootstrap';
import { ApprovalsService } from '../src/approvals/approvals.service';
import { MembershipsService } from '../src/companies/memberships.service';
import { OwnersService } from '../src/companies/owners.service';
import { createLogger } from '../src/core/logging/logger';
import { createAuth } from '../src/identity/auth';
import { MembershipDirectory } from '../src/identity/memberships';
import { PersonAccounts } from '../src/identity/person-accounts';
import { StepUpVerifier } from '../src/identity/step-up';
import { base32 } from '../src/identity/totp';
import { PolicyService } from '../src/policy/policy.service';
import {
  asSuperuser,
  company,
  member,
  person,
  staff,
  startServerTest,
  type ServerTestContext,
} from './support';

/**
 * M11 security review, identity (docs/plans/M11.md section 9, Identity): reviewer 2 F1 to F3,
 * reviewer 1 F3 and F4, and founder decisions D1 and D2 (2026-11-10), below the API.
 */

const TOTP_SECRET = 'identity-test-totp-secret-value';
const MONEY_ROLES = ['owner', 'agency_admin', 'property_manager', 'accountant'] as const;

let ctx: ServerTestContext;
let policy: PolicyService;
let approvals: ApprovalsService;
let memberships: MembershipsService;
let accounts: PersonAccounts;
let owners: OwnersService;
const alerts: Alert[] = [];
const email = new InMemoryEmail();
let tags = 0;
const tag = () => `${Date.now().toString(36)}${(tags += 1)}`;

/** A two-person action like the money approvals: managers and accountants approve it too. */
const moneyLike = {
  actionType: 'test.money_like',
  eligibleRoles: MONEY_ROLES,
  schema: z.object({ note: z.string() }),
  currentPayload: async (_tx: unknown, request: { payload: unknown }) =>
    request.payload as { note: string },
  execute: async () => undefined,
};

beforeAll(async () => {
  ctx = await startServerTest();
  policy = new PolicyService();
  const alertPort = new CallbackAlert((alert) => {
    alerts.push(alert);
  });
  const stepUp = new StepUpVerifier(ctx.database, ctx.config, ctx.audit, alertPort, ctx.clock);
  approvals = new ApprovalsService(ctx.database, policy, ctx.audit, stepUp, ctx.clock);
  approvals.register(moneyLike);
  const auth = createAuth({
    database: ctx.database,
    config: ctx.config,
    sms: new InMemorySms(),
    email,
    clock: ctx.clock,
    logger: createLogger({ level: 'silent' }),
    memberships: new MembershipDirectory(ctx.database),
    alerts: alertPort,
  });
  accounts = new PersonAccounts(auth);
  memberships = new MembershipsService(
    ctx.database,
    policy,
    accounts,
    ctx.audit,
    auth,
    ctx.config,
    approvals,
  );
  owners = new OwnersService(ctx.database, policy);
});

afterAll(async () => {
  await ctx?.close();
});

type Staff = ReturnType<typeof staff>;

async function agency(name: string) {
  const companyId = await company(ctx, 'agency', `${name} ${tag()}`);
  const admin = async (label: string, extra: { totpSecret?: string } = {}) => {
    const personId = await person(ctx, label, extra);
    return staff(
      companyId,
      'agency',
      personId,
      await member(ctx, companyId, personId, 'agency_admin'),
      'agency_admin',
    );
  };
  return { companyId, admin };
}

const superuser = (statement: string, values: unknown[] = []) =>
  runSql(ctx.db.superuserUrl, statement, values);

/** Staff messages queued in the outbox for a company (the messaging job sends them). */
async function staffNoticesTo(companyId: string): Promise<string[]> {
  const rows = await superuser(
    `select payload from outbox_event where company_id = $1 and type = 'messaging.send'`,
    [companyId],
  );
  return rows
    .map((r) => (r.payload as { recipient: { type: string; personId?: string } }).recipient)
    .filter((r) => r.type === 'staff')
    .map((r) => r.personId!);
}

describe('AD-05 founder D1 (M11 review R2 F2): widening the approver set needs a second person', () => {
  it('refuses an approval handler naming a role outside the approver set', () => {
    expect(() =>
      approvals.register({
        ...moneyLike,
        actionType: 'test.caretakers',
        eligibleRoles: ['caretaker'],
      }),
    ).toThrow(/outside TWO_PERSON_APPROVER_ROLES/);
  });

  it('sends an approver invite, a promotion and a nomination to approval; a second admin decides', async () => {
    const { companyId, admin } = await agency('Widen');
    const first = await admin('First Admin');
    const second = await admin('Second Admin');

    const invited = await memberships.invite(first, {
      name: 'New Manager',
      email: `manager.${tag()}@identity.invalid`,
      role: 'property_manager',
    });
    expect(invited).toMatchObject({ status: 'invited', approvalRequestId: expect.any(String) });
    expect((await approvals.get(second, invited.approvalRequestId!)).request).toMatchObject({
      actionType: 'membership.approver_change',
      mode: 'two_person',
      eligibleApprovers: [second.personId],
    });
    await approvals.decide(second, invited.approvalRequestId!, { decision: 'approve' });
    expect(
      (await memberships.list(first)).find((m) => m.membershipId === invited.membershipId)?.status,
    ).toBe('active');

    const adviserId = await person(ctx, 'Adviser');
    const adviserMembership = await member(ctx, companyId, adviserId, 'adviser');
    const promoted = await memberships.update(first, adviserMembership, { role: 'accountant' });
    expect(promoted).toMatchObject({ role: 'adviser', approvalRequestId: expect.any(String) });
    await approvals.decide(second, promoted.approvalRequestId!, { decision: 'approve' });
    expect(
      (await memberships.list(first)).find((m) => m.membershipId === adviserMembership)?.role,
    ).toBe('accountant');

    const caretakerId = await person(ctx, 'Caretaker');
    const caretakerMembership = await member(ctx, companyId, caretakerId, 'caretaker');
    const nominated = await memberships.update(first, caretakerMembership, {
      nominatedApprover: true,
    });
    expect(nominated).toMatchObject({
      nominatedApprover: false,
      approvalRequestId: expect.any(String),
    });
  });

  it('records who could decide a request when it was made; someone added later cannot decide it', async () => {
    const { companyId, admin } = await agency('Recorded');
    const first = await admin('Initiator');
    const second = await admin('Approver');
    const { request } = await approvals.create(first, {
      actionType: moneyLike.actionType,
      subjectType: 'company',
      subjectId: companyId,
      payload: { note: 'pay out' },
    });
    expect(request.eligibleApprovers).toEqual([second.personId]);
    const alias = await admin('Alias added after the request');
    const view = await approvals.get(alias, request.id);
    expect(view.mayDecide).toBe(false);
    await expect(
      approvals.decide(alias, request.id, { decision: 'approve' }),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(
      (await approvals.decide(second, request.id, { decision: 'approve' })).request.status,
    ).toBe('approved');
  });

  it('removes an approver at once, and tells the other admins and the person removed', async () => {
    const { companyId, admin } = await agency('Narrow');
    const first = await admin('Remover');
    const second = await admin('Other Admin');
    const managerId = await person(ctx, 'Leaving Manager');
    const managerMembership = await member(ctx, companyId, managerId, 'property_manager');
    const removed = await memberships.revoke(first, managerMembership);
    expect(removed.status).toBe('revoked');
    const audit = await superuser(
      `select record_id from audit_event where company_id = $1 and action = 'membership.approver_removed'`,
      [companyId],
    );
    expect(audit.map((a) => a.record_id)).toEqual([managerId]);
    const told = await staffNoticesTo(companyId);
    expect(told).toEqual(expect.arrayContaining([second.personId, managerId]));
    expect(told).not.toContain(first.personId);
  });

  it('tells approvers removed in the last 30 days about every single-user request', async () => {
    const { companyId, admin } = await agency('Alone');
    const remaining = await admin('Last Admin');
    const otherId = await person(ctx, 'Removed Admin');
    const otherMembership = await member(ctx, companyId, otherId, 'agency_admin');
    await memberships.revoke(remaining, otherMembership);
    const before = (await staffNoticesTo(companyId)).length;
    const { request } = await approvals.create(remaining, {
      actionType: moneyLike.actionType,
      subjectType: 'company',
      subjectId: companyId,
      payload: { note: 'alone now' },
    });
    expect(request.mode).toBe('single_user');
    const after = await staffNoticesTo(companyId);
    expect(after.slice(before)).toEqual([otherId]);
  });
});

describe('AD-02 M11 review R2 F1: a scoped admin gives no one more than they have', () => {
  let companyId: string;
  let full: Staff;
  let scoped: Staff;
  let ownerA: string;
  let ownerB: string;

  beforeAll(async () => {
    const a = await agency('Scoped');
    companyId = a.companyId;
    full = await a.admin('Whole-company Admin');
    ownerA = (await owners.create(full, { kind: 'individual', displayName: 'Owner A' })).id;
    ownerB = (await owners.create(full, { kind: 'individual', displayName: 'Owner B' })).id;
    const scopedId = await person(ctx, 'Scoped Admin');
    const membershipId = await member(ctx, companyId, scopedId, 'agency_admin');
    await asSuperuser(ctx, `update membership set scope = $2 where id = $1`, [
      membershipId,
      { owners: [ownerA] },
    ]);
    scoped = {
      ...staff(companyId, 'agency', scopedId, membershipId, 'agency_admin'),
      scope: { owners: [ownerA] },
    };
  });

  it('never changes their own scope or nominated-approver flag', async () => {
    await expect(
      memberships.update(scoped, scoped.membershipId, { scope: {} }),
    ).rejects.toMatchObject({
      code: 'own_membership',
    });
    await expect(
      memberships.update(scoped, scoped.membershipId, { nominatedApprover: true }),
    ).rejects.toMatchObject({ code: 'own_membership' });
  });

  it('invites people within their own owners, never the whole company', async () => {
    const invited = await memberships.invite(scoped, {
      name: 'Scoped Invitee',
      phone: '+233207300001',
      role: 'caretaker',
    });
    expect(invited.scope).toEqual({});
    const adviser = await memberships.invite(scoped, {
      name: 'Scoped Adviser',
      email: `adviser.${tag()}@identity.invalid`,
      role: 'adviser',
    });
    expect(adviser.scope).toEqual({ owners: [ownerA] });
  });

  it('cannot change or remove someone outside their part, nor widen anyone beyond it', async () => {
    await expect(
      memberships.update(scoped, full.membershipId, { role: 'accountant' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(memberships.revoke(scoped, full.membershipId)).rejects.toMatchObject({
      status: 403,
    });
    const adviserId = await person(ctx, 'Inside Adviser');
    const inside = await member(ctx, companyId, adviserId, 'adviser');
    await asSuperuser(ctx, `update membership set scope = $2 where id = $1`, [
      inside,
      { owners: [ownerA] },
    ]);
    await expect(
      memberships.update(scoped, inside, { scope: { owners: [ownerA, ownerB] } }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await memberships.update(scoped, inside, { scope: { owners: [ownerA] } })).scope,
    ).toEqual({ owners: [ownerA] });
  });
});

describe('AD-03 TL-12 founder D2 (M11 review R1 F3, R2 F3): invitations of people who already exist', () => {
  it('keeps an existing person invited until they accept, from a session proving the invited identifier', async () => {
    const { companyId: firstCompany, admin } = await agency('Existing A');
    const firstAdmin = await admin('A Admin');
    const address = `shared.${tag()}@identity.invalid`;
    const created = await memberships.invite(firstAdmin, {
      name: 'Abena as A typed',
      email: address,
      role: 'adviser',
    });
    expect(created.status).toBe('active'); // a new person, and not an approver
    expect(firstCompany).toBeTruthy();

    const b = await agency('Existing B');
    const bAdmin = await b.admin('B Admin');
    const bSecond = await b.admin('B Second');
    const invited = await memberships.invite(bAdmin, {
      name: 'Mrs Mensah as B typed',
      email: address,
      role: 'accountant',
    });
    expect(invited).toMatchObject({
      personId: created.personId,
      status: 'invited',
      name: 'Mrs Mensah as B typed',
    });
    const listed = (await memberships.list(bAdmin)).find(
      (m) => m.membershipId === invited.membershipId,
    )!;
    expect(listed.name).toBe('Mrs Mensah as B typed');
    expect(listed.phoneMasked).toBeNull();

    const pending = await memberships.invitations(created.personId);
    expect(pending.map((p) => p.membershipId)).toEqual([invited.membershipId]);
    // A phone session never accepts a password role; the second admin's approval comes first.
    await expect(
      memberships.acceptInvitation(
        { personId: created.personId, authMethod: 'phone_otp' },
        invited.membershipId,
      ),
    ).rejects.toMatchObject({ code: 'sign_in_method' });
    await expect(
      memberships.acceptInvitation(
        { personId: created.personId, authMethod: 'password_totp' },
        invited.membershipId,
      ),
    ).rejects.toMatchObject({ code: 'invitation_awaiting_approval' });
    await approvals.decide(bSecond, invited.approvalRequestId!, { decision: 'approve' });
    expect(
      (await memberships.list(bAdmin)).find((m) => m.membershipId === invited.membershipId)?.status,
    ).toBe('invited');
    await memberships.acceptInvitation(
      { personId: created.personId, authMethod: 'password_totp' },
      invited.membershipId,
    );
    const directory = await new MembershipDirectory(ctx.database).forPerson(created.personId);
    expect(directory.find((m) => m.membershipId === invited.membershipId)?.status).toBe('active');
  });

  it('never stores an email for a caretaker, and a caretaker invitation is accepted only by phone code', async () => {
    const { admin } = await agency('Caretakers');
    const theAdmin = await admin('C Admin');
    const fresh = await memberships.invite(theAdmin, {
      name: 'New Caretaker',
      email: `attacker.${tag()}@identity.invalid`,
      phone: '+233207300101',
      role: 'caretaker',
    });
    expect(fresh.email).toBeNull();
    const [row] = await superuser('select email from person where id = $1', [fresh.personId]);
    expect(String(row!.email)).toMatch(/@users\.invalid$/);

    // A person already on record for the phone (a tenant elsewhere): invited until they accept.
    const tenant = await accounts.create({ name: 'Tenant Elsewhere', phone: '+233207300102' });
    const invited = await memberships.invite(theAdmin, {
      name: 'Gatekeeper',
      phone: '+233207300102',
      role: 'caretaker',
    });
    expect(invited).toMatchObject({
      personId: tenant.personId,
      status: 'invited',
      name: 'Gatekeeper',
      email: null,
    });
    await expect(
      memberships.acceptInvitation(
        { personId: tenant.personId, authMethod: 'password_totp' },
        invited.membershipId,
      ),
    ).rejects.toMatchObject({ code: 'sign_in_method' });
    await memberships.acceptInvitation(
      { personId: tenant.personId, authMethod: 'phone_otp' },
      invited.membershipId,
    );
    expect(
      (await memberships.list(theAdmin)).find((m) => m.membershipId === invited.membershipId)
        ?.status,
    ).toBe('active');
  });

  it('lets the invited person decline', async () => {
    const { admin } = await agency('Decline');
    const theAdmin = await admin('D Admin');
    const tenant = await accounts.create({ name: 'Declining Tenant', phone: '+233207300201' });
    const invited = await memberships.invite(theAdmin, {
      name: 'Maybe',
      phone: '+233207300201',
      role: 'caretaker',
    });
    await memberships.declineInvitation({ personId: tenant.personId }, invited.membershipId);
    expect(
      (await memberships.list(theAdmin)).find((m) => m.membershipId === invited.membershipId)
        ?.status,
    ).toBe('revoked');
    expect(await memberships.invitations(tenant.personId)).toEqual([]);
  });
});

describe('AD-05 OQ-29 M11 review R1 F4: the single-user step-up locks, is audited, and refuses replay', () => {
  it('locks after five wrong codes, alerts, audits each failure, and accepts a code only once', async () => {
    const landlordId = await company(ctx, 'landlord', `Solo ${tag()}`);
    const ownerId = await person(ctx, 'Solo Owner', { totpSecret: TOTP_SECRET });
    const solo = staff(
      landlordId,
      'landlord',
      ownerId,
      await member(ctx, landlordId, ownerId, 'owner'),
      'owner',
    );
    const ask = async (note: string) =>
      (
        await approvals.create(solo, {
          actionType: moneyLike.actionType,
          subjectType: 'company',
          subjectId: `${landlordId}:${note}`,
          payload: { note },
        })
      ).request;
    const first = await ask('first');
    const second = await ask('second');
    await asSuperuser(
      ctx,
      "update approval_request set cooling_off_until = now() - interval '1 minute' where company_id = $1",
      [landlordId],
    );
    ctx.clock.advance(24 * 3_600_000 + 60_000);
    try {
      for (let i = 0; i < 5; i += 1)
        await expect(
          approvals.decide(solo, first.id, { decision: 'self_confirm', code: '000000' }),
        ).rejects.toMatchObject({ code: 'step_up_failed' });
      const code = await generate({ secret: base32(TOTP_SECRET) });
      await expect(
        approvals.decide(solo, first.id, { decision: 'self_confirm', code }),
      ).rejects.toMatchObject({ status: 429, code: 'step_up_locked' });
      expect(alerts.filter((a) => a.code === 'auth.step_up_locked')).toHaveLength(1);
      const failures = await superuser(
        `select data from audit_event where company_id = $1 and action = 'approval.step_up_failed'`,
        [landlordId],
      );
      expect(failures).toHaveLength(6);
      expect(JSON.stringify(failures)).not.toContain(code);

      // The lock lasts 15 minutes; then a current code works once, and never again.
      ctx.clock.advance(16 * 60_000);
      const done = await approvals.decide(solo, first.id, { decision: 'self_confirm', code });
      expect(done.request.status).toBe('approved');
      await expect(
        approvals.decide(solo, second.id, { decision: 'self_confirm', code }),
      ).rejects.toMatchObject({ code: 'step_up_failed' });
      const reused = await superuser(
        `select data from audit_event where company_id = $1 and action = 'approval.step_up_failed' order by seq desc limit 1`,
        [landlordId],
      );
      expect(reused[0]!.data).toMatchObject({ reason: 'code_reused' });
    } finally {
      ctx.clock.advance(-(24 * 3_600_000 + 60_000 + 16 * 60_000));
    }
  });
});

describe('NFR-SEC M11 decision 6: breached passwords are refused; an unreachable check is alerted', () => {
  it('refuses a password found in a breach, and accepts one when the check cannot be made', async () => {
    const breachAlerts: Alert[] = [];
    const auth = createAuth({
      database: ctx.database,
      config: ctx.config,
      sms: new InMemorySms(),
      email,
      clock: ctx.clock,
      logger: createLogger({ level: 'silent' }),
      memberships: new MembershipDirectory(ctx.database),
      alerts: new CallbackAlert((alert) => {
        breachAlerts.push(alert);
      }),
      breachedPassword: async (password) => {
        if (password.includes('unreachable')) throw new Error('network down');
        return password === 'Password1234!';
      },
    });
    const { admin } = await agency('Breach');
    const theAdmin = await admin('Breach Admin');
    const address = `breach.${tag()}@identity.invalid`;
    await memberships.invite(theAdmin, { name: 'Breach Adviser', email: address, role: 'adviser' });
    const token = /reset-password\/([A-Za-z0-9_-]+)/.exec(
      email.sent.filter((m) => m.to === address).at(-1)!.text!,
    )![1]!;
    await expect(
      auth.api.resetPassword({ body: { token, newPassword: 'Password1234!' } }),
    ).rejects.toMatchObject({ body: { code: 'PASSWORD_COMPROMISED' } });
    expect(breachAlerts).toEqual([]);
    await auth.api.resetPassword({ body: { token, newPassword: 'unreachable but long enough' } });
    expect(breachAlerts.map((a) => a.code)).toEqual(['auth.breach_check_unavailable']);
    expect(JSON.stringify(breachAlerts)).not.toContain('unreachable but');
  });
});

describe('AD-10 founder D2: platform:bootstrap adds an existing person as pending', () => {
  it('keeps an existing person’s platform-admin membership invited until they accept with password and TOTP', async () => {
    const address = `existing.platform.${tag()}@identity.invalid`;
    const existing = await accounts.create({ name: 'Already Here', email: address });
    const invited: string[] = [];
    const result = await bootstrapPlatform(
      ctx.database,
      { accounts, audit: ctx.audit, invite: async (to) => void invited.push(to) },
      { name: 'Rent Platform', legalName: 'Rent Platform Ltd', email: address, addAdmin: true },
    );
    expect(result).toMatchObject({ personCreated: false, membershipCreated: true });
    const [pending] = await memberships.invitations(existing.personId);
    expect(pending).toMatchObject({ companyId: result.platformCompanyId, role: 'platform_admin' });
    expect(
      (await new MembershipDirectory(ctx.database).forPerson(existing.personId)).map(
        (m) => m.status,
      ),
    ).toEqual(['invited']);
    await expect(
      memberships.acceptInvitation(
        { personId: existing.personId, authMethod: 'phone_otp' },
        pending!.membershipId,
      ),
    ).rejects.toMatchObject({ code: 'sign_in_method' });
    await memberships.acceptInvitation(
      { personId: existing.personId, authMethod: 'password_totp' },
      pending!.membershipId,
    );
    expect(
      (await new MembershipDirectory(ctx.database).forPerson(existing.personId)).map(
        (m) => m.status,
      ),
    ).toEqual(['active']);
  });
});
