import { eq, schema, withCompany, type Tx } from '@rent/db';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApprovalsService, type ApprovalActionHandler } from '../src/approvals/approvals.service';
import { StepUpVerifier } from '../src/identity/step-up';
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

const TOTP_SECRET = 'approvals-test-totp-secret-value';
const base32 = (text: string) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of Buffer.from(text)) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
};

let ctx: ServerTestContext;
let approvals: ApprovalsService;
let failNext = false;

/** A test action: rename the company. The display name is the subject the approval protects. */
const rename: ApprovalActionHandler<{ from: string; to: string }> = {
  actionType: 'test.rename_company',
  eligibleRoles: ['agency_admin', 'property_manager'],
  schema: z.object({ from: z.string(), to: z.string() }),
  async currentPayload(tx: Tx, request) {
    const [row] = await tx
      .select({ name: schema.company.displayName })
      .from(schema.company)
      .where(eq(schema.company.id, request.companyId));
    return { from: row!.name, to: (request.payload as { to: string }).to };
  },
  async execute(tx: Tx, request, payload) {
    if (failNext) throw new Error('the action failed');
    await tx
      .update(schema.company)
      .set({ displayName: payload.to })
      .where(eq(schema.company.id, request.companyId));
  },
};

async function agency(name: string) {
  const companyId = await company(ctx, 'agency', name);
  const adminId = await person(ctx, `${name} admin`);
  const managerId = await person(ctx, `${name} manager`);
  const accountantId = await person(ctx, `${name} accountant`);
  const admin = staff(
    companyId,
    'agency',
    adminId,
    await member(ctx, companyId, adminId, 'agency_admin'),
    'agency_admin',
  );
  const manager = staff(
    companyId,
    'agency',
    managerId,
    await member(ctx, companyId, managerId, 'property_manager'),
    'property_manager',
  );
  const accountant = staff(
    companyId,
    'agency',
    accountantId,
    await member(ctx, companyId, accountantId, 'accountant'),
    'accountant',
  );
  return { companyId, admin, manager, accountant, name };
}

const displayName = async (companyId: string) =>
  (
    await withCompany(ctx.database, { companyId, actorKind: 'system' }, (tx) =>
      tx.select({ name: schema.company.displayName }).from(schema.company),
    )
  )[0]!.name;

beforeAll(async () => {
  ctx = await startServerTest();
  approvals = new ApprovalsService(
    ctx.database,
    new PolicyService(),
    ctx.audit,
    new StepUpVerifier(ctx.database, ctx.config),
    ctx.clock,
  );
  approvals.register(rename);
});

afterAll(async () => {
  await ctx?.close();
});

describe('AD-05 approvals: the initiator can never approve', () => {
  it('refuses the initiator in the service, whatever their role', async () => {
    const a = await agency('Initiator Co');
    const { request } = await approvals.create(a.admin, {
      actionType: rename.actionType,
      subjectType: 'company',
      subjectId: a.companyId,
      payload: { from: a.name, to: 'Renamed' },
    });
    await expect(approvals.decide(a.admin, request.id, { decision: 'approve' })).rejects.toThrow();
    expect(await displayName(a.companyId)).toBe(a.name);
  });
});

describe('AD-05 approvals engine', () => {
  it('runs the action once an eligible second person approves, in the same transaction', async () => {
    const a = await agency('Approve Co');
    const { request } = await approvals.create(a.admin, {
      actionType: rename.actionType,
      subjectType: 'company',
      subjectId: a.companyId,
      payload: { from: a.name, to: 'Approve Co Renamed' },
    });
    expect(request.mode).toBe('two_person');
    const done = await approvals.decide(a.manager, request.id, { decision: 'approve' });
    expect(done.request.status).toBe('approved');
    expect(await displayName(a.companyId)).toBe('Approve Co Renamed');
  });

  it('does not let a role outside the action type approve', async () => {
    const a = await agency('Ineligible Co');
    const { request } = await approvals.create(a.admin, {
      actionType: rename.actionType,
      subjectType: 'company',
      subjectId: a.companyId,
      payload: { from: a.name, to: 'X' },
    });
    await expect(
      approvals.decide(a.accountant, request.id, { decision: 'approve' }),
    ).rejects.toThrow();
  });

  it('rejects without running the action', async () => {
    const a = await agency('Reject Co');
    const { request } = await approvals.create(a.admin, {
      actionType: rename.actionType,
      subjectType: 'company',
      subjectId: a.companyId,
      payload: { from: a.name, to: 'Never' },
    });
    const done = await approvals.decide(a.manager, request.id, {
      decision: 'reject',
      reason: 'not needed',
    });
    expect(done.request.status).toBe('rejected');
    expect(await displayName(a.companyId)).toBe(a.name);
  });

  it('lets only the initiator withdraw', async () => {
    const a = await agency('Cancel Co');
    const { request } = await approvals.create(a.admin, {
      actionType: rename.actionType,
      subjectType: 'company',
      subjectId: a.companyId,
      payload: { from: a.name, to: 'Y' },
    });
    await expect(approvals.cancel(a.manager, request.id)).rejects.toThrow();
    expect((await approvals.cancel(a.admin, request.id)).request.status).toBe('cancelled');
  });

  it('cancels the request when the subject changed after it was raised', async () => {
    const a = await agency('Changed Co');
    const { request } = await approvals.create(a.admin, {
      actionType: rename.actionType,
      subjectType: 'company',
      subjectId: a.companyId,
      payload: { from: a.name, to: 'Z' },
    });
    await withCompany(ctx.database, { companyId: a.companyId, actorKind: 'system' }, (tx) =>
      tx
        .update(schema.company)
        .set({ displayName: 'Changed meanwhile' })
        .where(eq(schema.company.id, a.companyId)),
    );
    const done = await approvals.decide(a.manager, request.id, { decision: 'approve' });
    expect(done.request).toMatchObject({ status: 'cancelled', closeReason: 'subject_changed' });
    expect(await displayName(a.companyId)).toBe('Changed meanwhile');
  });

  it('records nothing when the action fails', async () => {
    const a = await agency('Failing Co');
    const { request } = await approvals.create(a.admin, {
      actionType: rename.actionType,
      subjectType: 'company',
      subjectId: a.companyId,
      payload: { from: a.name, to: 'F' },
    });
    failNext = true;
    await expect(approvals.decide(a.manager, request.id, { decision: 'approve' })).rejects.toThrow(
      'the action failed',
    );
    failNext = false;
    const after = await approvals.get(a.admin, request.id);
    expect(after.request.status).toBe('pending');
    expect(after.decisions).toHaveLength(0);
  });

  it('runs the action once when two approvers act at the same moment', async () => {
    const a = await agency('Race Co');
    const secondId = await person(ctx, 'Second manager');
    const second = staff(
      a.companyId,
      'agency',
      secondId,
      await member(ctx, a.companyId, secondId, 'property_manager'),
      'property_manager',
    );
    const { request } = await approvals.create(a.admin, {
      actionType: rename.actionType,
      subjectType: 'company',
      subjectId: a.companyId,
      payload: { from: a.name, to: 'Race Co Renamed' },
    });
    const results = await Promise.allSettled([
      approvals.decide(a.manager, request.id, { decision: 'approve' }),
      approvals.decide(second, request.id, { decision: 'approve' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const after = await approvals.get(a.admin, request.id);
    expect(after.request.status).toBe('approved');
    expect(after.decisions.filter((d) => d.kind === 'approve')).toHaveLength(1);
  });

  it('lets a nominated approver approve, and expires requests nobody decides', async () => {
    const landlordId = await company(ctx, 'landlord', 'Nominee Landlord');
    const ownerId = await person(ctx, 'Owner');
    const owner = staff(
      landlordId,
      'landlord',
      ownerId,
      await member(ctx, landlordId, ownerId, 'owner'),
      'owner',
    );
    const nomineeId = await person(ctx, 'Family approver');
    const nominee = staff(
      landlordId,
      'landlord',
      nomineeId,
      await member(ctx, landlordId, nomineeId, 'adviser', { nominatedApprover: true }),
      'adviser',
      true,
    );
    const first = await approvals.create(owner, {
      actionType: rename.actionType,
      subjectType: 'company',
      subjectId: landlordId,
      payload: { from: 'Nominee Landlord', to: 'Nominee Renamed' },
    });
    expect(first.request.mode).toBe('two_person');
    expect(
      (await approvals.decide(nominee, first.request.id, { decision: 'approve' })).request.status,
    ).toBe('approved');

    const second = await approvals.create(owner, {
      actionType: rename.actionType,
      subjectType: 'company',
      subjectId: landlordId,
      payload: { from: 'Nominee Renamed', to: 'Late' },
    });
    await asSuperuser(
      ctx,
      "update approval_request set expires_at = now() - interval '1 minute' where id = $1",
      [second.request.id],
    );
    const closed = await withCompany(
      ctx.database,
      { companyId: landlordId, actorKind: 'system' },
      (tx) => approvals.expireDue(tx),
    );
    expect(closed).toBe(1);
    expect((await approvals.get(owner, second.request.id)).request.status).toBe('expired');
  });
});

describe('AD-05 single-user cooling-off', () => {
  it('waits 24 hours, then accepts the initiator confirming with a current TOTP code', async () => {
    const landlordId = await company(ctx, 'landlord', 'Solo Landlord');
    const ownerId = await person(ctx, 'Solo owner', { totpSecret: TOTP_SECRET });
    const owner = staff(
      landlordId,
      'landlord',
      ownerId,
      await member(ctx, landlordId, ownerId, 'owner'),
      'owner',
    );
    const { request } = await approvals.create(owner, {
      actionType: rename.actionType,
      subjectType: 'company',
      subjectId: landlordId,
      payload: { from: 'Solo Landlord', to: 'Solo Renamed' },
    });
    expect(request).toMatchObject({ mode: 'single_user', status: 'cooling_off' });
    expect(request.coolingOffUntil!.getTime() - request.createdAt.getTime()).toBeGreaterThanOrEqual(
      24 * 3_600_000 - 5_000,
    );

    const code = await generate({ secret: base32(TOTP_SECRET) });
    await expect(
      approvals.decide(owner, request.id, { decision: 'self_confirm', code }),
    ).rejects.toThrow(/cooling-off/);

    // A day later (moved in the database and in the service clock).
    await asSuperuser(
      ctx,
      "update approval_request set cooling_off_until = now() - interval '1 minute' where id = $1",
      [request.id],
    );
    ctx.clock.advance(24 * 3_600_000 + 60_000);
    await expect(
      approvals.decide(owner, request.id, { decision: 'self_confirm', code: '000000' }),
    ).rejects.toThrow(/authenticator/);
    const done = await approvals.decide(owner, request.id, {
      decision: 'self_confirm',
      code: await generate({ secret: base32(TOTP_SECRET) }),
    });
    expect(done.request).toMatchObject({
      status: 'approved',
      closeReason: 'self_confirmed_after_cooling_off',
    });
    expect(done.decisions[0]).toMatchObject({ kind: 'self_confirm', stepUpVerified: true });
    expect(await displayName(landlordId)).toBe('Solo Renamed');
  });
});
