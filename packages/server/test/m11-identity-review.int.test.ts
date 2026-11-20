import { runSql } from '@rent/db/testing';
import { CallbackAlert, InMemoryEmail, InMemorySms } from '@rent/integrations';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApprovalsService } from '../src/approvals/approvals.service';
import { MembershipsService } from '../src/companies/memberships.service';
import { createLogger } from '../src/core/logging/logger';
import { AccountRecoveryService } from '../src/identity/account-recovery';
import { createAuth } from '../src/identity/auth';
import { MembershipDirectory } from '../src/identity/memberships';
import { PersonAccounts } from '../src/identity/person-accounts';
import { StepUpVerifier } from '../src/identity/step-up';
import { base32 } from '../src/identity/totp';
import { PolicyService } from '../src/policy/policy.service';
import { company, member, person, staff, startServerTest, type ServerTestContext } from './support';

/**
 * M11 independent review, reviewer B, identity findings (docs/plans/M11.md section 9, Identity,
 * Review round), below the API. Its own database: it starts with no platform company (B3).
 */

const TOTP_SECRET = 'identity-review-totp-secret-value';

let ctx: ServerTestContext;
let policy: PolicyService;
let stepUp: StepUpVerifier;
let approvals: ApprovalsService;
let memberships: MembershipsService;
let recovery: AccountRecoveryService;
const email = new InMemoryEmail();

const superuser = (statement: string, values: unknown[] = []) =>
  runSql(ctx.db.superuserUrl, statement, values);

beforeAll(async () => {
  ctx = await startServerTest();
  policy = new PolicyService();
  stepUp = new StepUpVerifier(
    ctx.database,
    ctx.config,
    ctx.audit,
    new CallbackAlert(() => undefined),
    ctx.clock,
  );
  approvals = new ApprovalsService(ctx.database, policy, ctx.audit, stepUp, ctx.clock);
  approvals.register({
    actionType: 'test.money_like',
    eligibleRoles: ['owner', 'agency_admin', 'property_manager', 'accountant'],
    schema: z.object({ note: z.string() }),
    currentPayload: async (_tx, request) => request.payload as { note: string },
    execute: async () => undefined,
  });
  const auth = createAuth({
    database: ctx.database,
    config: ctx.config,
    sms: new InMemorySms(),
    email,
    clock: ctx.clock,
    logger: createLogger({ level: 'silent' }),
    memberships: new MembershipDirectory(ctx.database),
  });
  memberships = new MembershipsService(
    ctx.database,
    policy,
    new PersonAccounts(auth),
    ctx.audit,
    auth,
    ctx.config,
    approvals,
  );
  recovery = new AccountRecoveryService(ctx.database, ctx.audit, ctx.clock, stepUp);
});

afterAll(async () => {
  await ctx?.close();
});

describe('AD-05 review: a nominated approver never approves their own promotion', () => {
  it('leaves the person a change is about out of the people who may decide it', async () => {
    const agencyId = await company(ctx, 'agency', 'Self Promotion Agency');
    const adminId = await person(ctx, 'Admin');
    const admin = staff(
      agencyId,
      'agency',
      adminId,
      await member(ctx, agencyId, adminId, 'agency_admin'),
      'agency_admin',
    );
    const nominatedId = await person(ctx, 'Nominated Accountant');
    const nominatedMembership = await member(ctx, agencyId, nominatedId, 'accountant', {
      nominatedApprover: true,
    });
    const nominated = staff(
      agencyId,
      'agency',
      nominatedId,
      nominatedMembership,
      'accountant',
      true,
    );
    const asked = await memberships.update(admin, nominatedMembership, { role: 'agency_admin' });
    const view = await approvals.get(admin, asked.approvalRequestId!);
    expect(view.request.eligibleApprovers).not.toContain(nominatedId);
    // Nobody else could decide it, so it is a single user's request, with the cooling-off.
    expect(view.request.mode).toBe('single_user');
    await expect(
      approvals.decide(nominated, asked.approvalRequestId!, { decision: 'approve' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('AD-05 OQ-29 review: parallel step-up guesses are counted one by one', () => {
  it('compares at most five of ten codes tried at once, then is locked', async () => {
    const landlordId = await company(ctx, 'landlord', 'Parallel Step-up');
    const ownerId = await person(ctx, 'Parallel Owner', { totpSecret: TOTP_SECRET });
    await member(ctx, landlordId, ownerId, 'owner');
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => stepUp.check(ownerId, '000000', landlordId)),
    );
    expect(outcomes.filter((o) => o === 'wrong_code').length).toBeLessThanOrEqual(5);
    expect(outcomes.filter((o) => o === 'locked').length).toBeGreaterThanOrEqual(5);
    const audited = await superuser(
      `select data->>'reason' as reason from audit_event where company_id = $1 and action = 'approval.step_up_failed'`,
      [landlordId],
    );
    expect(audited.filter((a) => a.reason === 'wrong_code').length).toBeLessThanOrEqual(5);
    // The right code now: still locked.
    expect(
      await stepUp.check(ownerId, await generate({ secret: base32(TOTP_SECRET) }), landlordId),
    ).toBe('locked');
  });
});

describe('AD-06 AD-07 review B3 and B4: account recovery is atomic and proves its operator', () => {
  let platformAdminEmail: string;
  let targetId: string;
  let agencyId: string;

  beforeAll(async () => {
    agencyId = await company(ctx, 'agency', 'Recovery Agency');
    targetId = await person(ctx, 'Lost Phone', { totpSecret: 'someone-elses-secret-0001' });
    await member(ctx, agencyId, targetId, 'agency_admin');
  });

  it('refuses when there is no platform company, and changes nothing', async () => {
    await expect(
      recovery.revokeAllSessions(
        {
          kind: 'cli',
          operatorEmail: 'nobody@identity-review.invalid',
          operatorCode: '000000',
          origin: { osUser: 'ops', host: 'ops-laptop' },
        },
        targetId,
        'Lost phone; identity checked by video call',
      ),
    ).rejects.toThrow();
    const platformAdmin = staff(agencyId, 'agency', targetId, 'x', 'agency_admin');
    await expect(
      recovery.resetTwoFactor(
        {
          kind: 'console',
          actor: {
            kind: 'platform_admin',
            personId: platformAdmin.personId,
            companyId: agencyId,
            membershipId: 'x',
            authMethod: 'password_totp',
          },
        },
        targetId,
        'Lost phone; identity checked by video call',
      ),
    ).rejects.toMatchObject({ code: 'platform_company_missing' });
    expect(
      await superuser('select id from two_factor where user_id = $1', [targetId]),
    ).toHaveLength(1);
  });

  it('requires the operator’s current TOTP code, once, and records where it ran', async () => {
    const platformId = await company(ctx, 'platform', 'Platform');
    const operatorId = await person(ctx, 'Operator', { totpSecret: TOTP_SECRET });
    await member(ctx, platformId, operatorId, 'platform_admin');
    const [row] = await superuser('select email from person where id = $1', [operatorId]);
    platformAdminEmail = String(row!.email);
    const by = (operatorCode: string) => ({
      kind: 'cli' as const,
      operatorEmail: platformAdminEmail,
      operatorCode,
      origin: { osUser: 'kofi', host: 'ops-laptop-1' },
    });
    const reason = 'Lost phone; identity checked by video call, ticket 1001';
    await expect(recovery.revokeAllSessions(by('000000'), targetId, reason)).rejects.toMatchObject({
      status: 403,
      code: 'operator_code',
    });
    const code = await generate({ secret: base32(TOTP_SECRET) });
    const done = await recovery.resetTwoFactor(by(code), targetId, reason);
    expect(done.twoFactorReset).toBe(true);
    await expect(recovery.revokeAllSessions(by(code), targetId, reason)).rejects.toMatchObject({
      code: 'operator_code',
    });
    const events = await superuser(
      `select company_id, actor_person_id, data from audit_event where action = 'auth.two_factor_reset' and record_id = $1`,
      [targetId],
    );
    expect(events.map((e) => e.company_id).sort()).toEqual([agencyId, platformId].sort());
    const platformEvent = events.find((e) => e.company_id === platformId)!;
    expect(platformEvent.actor_person_id).toBe(operatorId);
    expect(platformEvent.data).toMatchObject({ via: 'cli', osUser: 'kofi', host: 'ops-laptop-1' });
  });
});

describe('NFR-SEC review B2: a failed sign-in is answered before its audit is written', () => {
  it('does not wait for the audit outside tests', async () => {
    const address = 'slow.audit@identity-review.invalid';
    const accounts = new PersonAccounts(
      createAuth({
        database: ctx.database,
        config: ctx.config,
        sms: new InMemorySms(),
        email,
        clock: ctx.clock,
        logger: createLogger({ level: 'silent' }),
        memberships: new MembershipDirectory(ctx.database),
      }),
    );
    await accounts.create({
      name: 'Slow Audit',
      email: address,
      password: 'a long enough password',
    });
    let audited = false;
    const auth = createAuth({
      database: ctx.database,
      config: { ...ctx.config, NODE_ENV: 'development' },
      sms: new InMemorySms(),
      email,
      clock: ctx.clock,
      logger: createLogger({ level: 'silent' }),
      memberships: new MembershipDirectory(ctx.database),
      onAuthEvent: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        audited = true;
      },
    });
    const started = Date.now();
    const response = await auth.handler(
      new Request(`${ctx.config.API_BASE_URL}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: address, password: 'not the right password at all' }),
      }),
    );
    expect(response.status).toBe(401);
    expect(Date.now() - started).toBeLessThan(1_200);
    expect(audited).toBe(false);
  });
});
