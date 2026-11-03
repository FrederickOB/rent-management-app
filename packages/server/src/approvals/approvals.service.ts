import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  lte,
  schema,
  sql,
  withCompany,
  type Database,
  type Tx,
} from '@rent/db';
import {
  chooseMode,
  initialStatus,
  nextStatus,
  type ApprovalMode,
  type ApprovalStatus,
  type DecisionKind,
} from '@rent/domain/approvals';
import { can, scopeOf, type Actor, type StaffRole } from '@rent/domain/policy';
import { parseCompanySettings } from '@rent/domain/settings';
import type { z } from 'zod';
import type { Clock } from '../core/clock';
import { AppError, conflict, forbidden, invalid, notFound } from '../core/errors';
import { enqueueOutbox } from '../core/outbox';
import { CLOCK, DATABASE } from '../core/tokens';
import { AuditService } from '../audit/audit.service';
import { StepUpVerifier } from '../identity/step-up';
import { PolicyService, staffContext } from '../policy/policy.service';

type RequestRow = typeof schema.approvalRequest.$inferSelect;

/**
 * One action type that needs two people (AD-05): notices to quit, refunds, write-offs, cash
 * receipts and settlement accounts register handlers in their milestones.
 */
export interface ApprovalActionHandler<P = unknown> {
  readonly actionType: string;
  /** Roles that may approve. A nominated approver may approve any action type. */
  readonly eligibleRoles: readonly StaffRole[];
  readonly schema: z.ZodType<P>;
  /** At most one open request per subject: another is refused while one waits for a decision. */
  readonly onePerSubject?: boolean;
  /**
   * Runs before a decision is recorded, in the deciding transaction: handlers that will write money
   * take their locks here, before anything in the transaction is audited, so every path locks in
   * the same order (M4a plan 8).
   */
  prepare?(tx: Tx, request: RequestRow): Promise<void>;
  /** The fields that matter, re-read from the subject at decision time to detect changes. */
  currentPayload(tx: Tx, request: RequestRow): Promise<P>;
  /** Runs in the same transaction as the final approval; if it throws, nothing is recorded. */
  execute(tx: Tx, request: RequestRow, payload: P): Promise<void>;
}

type DecisionRow = typeof schema.approvalDecision.$inferSelect;

export interface ApprovalView {
  readonly request: RequestRow;
  readonly decisions: DecisionRow[];
  /**
   * Whether the person reading may approve or reject it now, as `decide` would judge it, so the
   * screens offer Approve and Reject only to them (M3 web review). `decide` checks it all again.
   */
  readonly mayDecide: boolean;
}

/** Canonical JSON (sorted keys) so the same payload always hashes the same. */
export function payloadHash(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

type Staff = Extract<Actor, { kind: 'staff' }>;
const asStaff = (actor: Actor | null): Staff => {
  if (!actor || actor.kind !== 'staff') throw forbidden();
  return actor;
};
/** The person's own context, with their scope: RLS shows a scoped person only their requests. */
const ctxOf = (actor: Staff) => staffContext(actor);

/** The deciding session's resolved property scope, or null when it sees the whole company. */
async function scopeProperties(tx: Tx): Promise<string[] | null> {
  const result = await tx.execute<{ scope: string[] | null }>(
    sql`select app.property_scope()::text[] as scope`,
  );
  return result.rows[0]?.scope ?? null;
}

/**
 * Drops the scope for the rest of the transaction, once the request has been found and allowed:
 * the action then writes for the whole company, as every posting does.
 */
async function unscope(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select set_config('app.property_scope', '', true), set_config('app.owner_scope', '', true)`,
  );
}

@Injectable()
export class ApprovalsService {
  private readonly handlers = new Map<string, ApprovalActionHandler>();

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StepUpVerifier) private readonly stepUp: StepUpVerifier,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  register<P>(handler: ApprovalActionHandler<P>): void {
    if (this.handlers.has(handler.actionType))
      throw new Error(`Approval handler ${handler.actionType} is already registered`);
    this.handlers.set(handler.actionType, handler as ApprovalActionHandler);
  }

  private handler(actionType: string): ApprovalActionHandler {
    const handler = this.handlers.get(actionType);
    if (!handler) throw invalid('unknown_action', `No approval handler for ${actionType}`);
    return handler;
  }

  /** Starts a request. Single-user mode applies when nobody else could approve (OQ-29). */
  async create(
    actor: Actor | null,
    input: {
      actionType: string;
      subjectType: string;
      subjectId: string;
      payload: unknown;
      propertyId?: string | null;
    },
  ): Promise<ApprovalView> {
    const staff = asStaff(actor);
    const id = await withCompany(this.database, ctxOf(staff), (tx) =>
      this.createInTx(tx, staff, input),
    );
    return this.get(staff, id);
  }

  /**
   * Starts a request in the caller's transaction, so the record it asks about and the request
   * commit together (M4a: a cash record and its approval). Returns the request's id.
   */
  async createInTx(
    tx: Tx,
    actor: Actor | null,
    input: {
      actionType: string;
      subjectType: string;
      subjectId: string;
      payload: unknown;
      /** The subject's property (AD-02), or null for a company-level request. */
      propertyId?: string | null;
    },
  ): Promise<string> {
    const staff = asStaff(actor);
    const handler = this.handler(input.actionType);
    const payload = handler.schema.parse(input.payload);
    if (handler.onePerSubject) await this.refuseSecondOpen(tx, staff, input);
    const others = await tx
      .select({
        personId: schema.membership.personId,
        role: schema.membership.role,
        nominatedApprover: schema.membership.nominatedApprover,
        scope: schema.membership.scope,
      })
      .from(schema.membership)
      .where(
        and(
          eq(schema.membership.companyId, staff.companyId),
          eq(schema.membership.status, 'active'),
        ),
      );
    const eligible = [];
    for (const m of others) {
      if (m.personId === staff.personId) continue;
      const candidate = {
        ...staff,
        personId: m.personId,
        role: m.role as StaffRole,
        nominatedApprover: m.nominatedApprover,
        scope: (m.scope ?? {}) as { owners?: string[]; properties?: string[] },
      };
      // Who could decide it: in scope for the request's property, as decide() will judge it.
      const scope = scopeOf(candidate);
      const covered = scope
        ? ((
            await tx.execute<{ scope: string[] | null }>(
              sql`select app.resolve_property_scope(${`{${scope.ownerIds.join(',')}}`}::uuid[],
                    ${`{${scope.propertyIds.join(',')}}`}::uuid[])::text[] as scope`,
            )
          ).rows[0]?.scope ?? [])
        : null;
      if (
        can(candidate, 'approval.decide', {
          initiatorPersonId: staff.personId,
          eligibleRoles: handler.eligibleRoles,
          propertyId: input.propertyId ?? null,
          scopeProperties: covered,
        }).allowed
      )
        eligible.push(m);
    }
    const mode: ApprovalMode = chooseMode(eligible.length);
    const [company] = await tx
      .select({ settings: schema.company.settings })
      .from(schema.company)
      .where(eq(schema.company.id, staff.companyId));
    const settings = parseCompanySettings(company?.settings);
    const now = this.clock.now();
    const [row] = await tx
      .insert(schema.approvalRequest)
      .values({
        companyId: staff.companyId,
        actionType: input.actionType,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        propertyId: input.propertyId ?? null,
        payload: payload as Record<string, unknown>,
        payloadHash: payloadHash(payload),
        initiatedBy: staff.personId,
        initiatorMembershipId: staff.membershipId,
        mode,
        status: initialStatus(mode),
        coolingOffUntil:
          mode === 'single_user'
            ? new Date(now.getTime() + settings.approvalCoolingOffHours * 3_600_000)
            : null,
        expiresAt: new Date(now.getTime() + settings.approvalExpiryDays * 86_400_000),
      })
      .returning({ id: schema.approvalRequest.id });
    await enqueueOutbox(tx, {
      companyId: staff.companyId,
      type: 'approval.requested',
      payload: { requestId: row!.id, actionType: input.actionType, mode },
      idempotencyKey: `approval.requested:${row!.id}`,
    });
    return row!.id;
  }

  /**
   * Records a decision. When it completes the approval, the subject is re-read and hashed; if it
   * changed, the request is cancelled. Otherwise the action runs in the same transaction.
   */
  async decide(
    actor: Actor | null,
    requestId: string,
    input: { decision: DecisionKind; reason?: string; code?: string },
  ): Promise<ApprovalView> {
    const staff = asStaff(actor);
    let stepUpVerified = false;
    if (input.decision === 'self_confirm') {
      if (!input.code || !(await this.stepUp.verifyTotp(staff.personId, input.code))) {
        throw new AppError(
          403,
          'step_up_failed',
          'Enter a current code from your authenticator app',
        );
      }
      stepUpVerified = true;
    }
    await withCompany(this.database, ctxOf(staff), async (tx) => {
      const [request] = await tx
        .select()
        .from(schema.approvalRequest)
        .where(eq(schema.approvalRequest.id, requestId))
        .for('update');
      if (!request) throw notFound('Approval request');
      const handler = this.handler(request.actionType);
      const action =
        input.decision === 'self_confirm' ? 'approval.self_confirm' : 'approval.decide';
      this.policy.assert(staff, action, {
        initiatorPersonId: request.initiatedBy,
        eligibleRoles: handler.eligibleRoles,
        propertyId: request.propertyId,
        scopeProperties: await scopeProperties(tx),
      });
      await unscope(tx);
      if (handler.prepare) await handler.prepare(tx, request);

      const [{ approvals } = { approvals: 0 }] = await tx
        .select({ approvals: sql<number>`count(*)::int` })
        .from(schema.approvalDecision)
        .where(
          and(
            eq(schema.approvalDecision.requestId, requestId),
            eq(schema.approvalDecision.kind, 'approve'),
          ),
        );
      const status = nextStatus(
        {
          status: request.status as ApprovalStatus,
          mode: request.mode as ApprovalMode,
          coolingOffUntil: request.coolingOffUntil,
          expiresAt: request.expiresAt,
        },
        {
          type: 'decision',
          kind: input.decision,
          approvalsAfter: approvals + (input.decision === 'approve' ? 1 : 0),
          required: request.requiredApprovals,
        },
        this.clock.now(),
      );
      await tx.insert(schema.approvalDecision).values({
        companyId: staff.companyId,
        requestId,
        decidedBy: staff.personId,
        decidedByMembershipId: staff.membershipId,
        kind: input.decision,
        reason: input.reason ?? null,
        payloadHash: request.payloadHash,
        stepUpVerified,
      });
      if (status === 'pending' || status === 'cooling_off') return;
      if (status === 'rejected') {
        await this.close(tx, request, 'rejected', input.reason ?? 'rejected');
        return;
      }
      const current = handler.schema.parse(await handler.currentPayload(tx, request));
      if (payloadHash(current) !== request.payloadHash) {
        await this.close(tx, request, 'cancelled', 'subject_changed');
        return;
      }
      await handler.execute(tx, request, current);
      await this.close(
        tx,
        request,
        'approved',
        input.decision === 'self_confirm' ? 'self_confirmed_after_cooling_off' : 'approved',
      );
    });
    return this.get(staff, requestId);
  }

  /** The initiator withdraws a request. */
  async cancel(actor: Actor | null, requestId: string): Promise<ApprovalView> {
    const staff = asStaff(actor);
    await withCompany(this.database, ctxOf(staff), async (tx) => {
      const [request] = await tx
        .select()
        .from(schema.approvalRequest)
        .where(eq(schema.approvalRequest.id, requestId))
        .for('update');
      if (!request) throw notFound('Approval request');
      this.policy.assert(staff, 'approval.cancel', {
        initiatorPersonId: request.initiatedBy,
        eligibleRoles: [],
      });
      nextStatus(
        {
          status: request.status as ApprovalStatus,
          mode: request.mode as ApprovalMode,
          coolingOffUntil: request.coolingOffUntil,
          expiresAt: request.expiresAt,
        },
        { type: 'cancel', reason: 'withdrawn' },
        this.clock.now(),
      );
      await this.close(tx, request, 'cancelled', 'withdrawn');
    });
    return this.get(staff, requestId);
  }

  /**
   * Refuses a request while another for the same action and subject is open. People asking at
   * the same moment take turns on a transaction lock, so only one of them opens a request.
   */
  private async refuseSecondOpen(
    tx: Tx,
    staff: Staff,
    input: { actionType: string; subjectType: string; subjectId: string },
  ): Promise<void> {
    const key = `approval:${staff.companyId}:${input.actionType}:${input.subjectType}:${input.subjectId}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const [open] = await tx
      .select({ id: schema.approvalRequest.id })
      .from(schema.approvalRequest)
      .where(
        and(
          eq(schema.approvalRequest.actionType, input.actionType),
          eq(schema.approvalRequest.subjectType, input.subjectType),
          eq(schema.approvalRequest.subjectId, input.subjectId),
          inArray(schema.approvalRequest.status, ['pending', 'cooling_off']),
          gt(schema.approvalRequest.expiresAt, this.clock.now()),
        ),
      )
      .limit(1);
    if (open)
      throw conflict(
        'approval_open',
        'A request for this is already waiting for a decision. Withdraw it or wait for it to be decided.',
        { requestId: open.id },
      );
  }

  /** Closes requests past their expiry (hourly job, per company). Returns how many closed. */
  async expireDue(tx: Tx): Promise<number> {
    const rows = await tx
      .update(schema.approvalRequest)
      .set({ status: 'expired', closeReason: 'expired' })
      .where(
        and(
          inArray(schema.approvalRequest.status, ['pending', 'cooling_off']),
          lte(schema.approvalRequest.expiresAt, this.clock.now()),
        ),
      )
      .returning({ id: schema.approvalRequest.id });
    return rows.length;
  }

  /**
   * Requests by id, in the caller's transaction, for modules that show a record's approval state
   * (M4a review 16: they read approvals through this service, never its table).
   */
  async requestsIn(
    tx: Tx,
    ids: readonly string[],
  ): Promise<Map<string, Pick<RequestRow, 'id' | 'status' | 'initiatedBy' | 'propertyId'>>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({
        id: schema.approvalRequest.id,
        status: schema.approvalRequest.status,
        initiatedBy: schema.approvalRequest.initiatedBy,
        propertyId: schema.approvalRequest.propertyId,
      })
      .from(schema.approvalRequest)
      .where(inArray(schema.approvalRequest.id, [...new Set(ids)]));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Requests still waiting for a decision about these subjects, by subject id. */
  async openFor(
    tx: Tx,
    subjectIds: readonly string[],
    actionType?: string,
  ): Promise<Map<string, string>> {
    if (subjectIds.length === 0) return new Map();
    const rows = await tx
      .select({ id: schema.approvalRequest.id, subjectId: schema.approvalRequest.subjectId })
      .from(schema.approvalRequest)
      .where(
        and(
          inArray(schema.approvalRequest.subjectId, [...subjectIds]),
          inArray(schema.approvalRequest.status, ['pending', 'cooling_off']),
          actionType ? eq(schema.approvalRequest.actionType, actionType) : undefined,
        ),
      );
    return new Map(rows.map((r) => [r.subjectId, r.id]));
  }

  async list(actor: Actor | null, which: 'open' | 'closed'): Promise<ApprovalView[]> {
    const staff = asStaff(actor);
    this.policy.assert(staff, 'approval.view');
    return withCompany(this.database, ctxOf(staff), async (tx) => {
      const statuses =
        which === 'open'
          ? ['pending', 'cooling_off']
          : ['approved', 'rejected', 'cancelled', 'expired'];
      const requests = await tx
        .select()
        .from(schema.approvalRequest)
        .where(inArray(schema.approvalRequest.status, statuses))
        .orderBy(desc(schema.approvalRequest.createdAt))
        .limit(200);
      const scope = await scopeProperties(tx);
      return Promise.all(
        requests.map(async (request) =>
          this.view(staff, request, await this.decisions(tx, request.id), scope),
        ),
      );
    });
  }

  async get(actor: Actor | null, requestId: string): Promise<ApprovalView> {
    const staff = asStaff(actor);
    return withCompany(this.database, ctxOf(staff), async (tx) => {
      const [request] = await tx
        .select()
        .from(schema.approvalRequest)
        .where(eq(schema.approvalRequest.id, requestId));
      if (!request) throw notFound('Approval request');
      const isParty = request.initiatedBy === staff.personId;
      if (!isParty) this.policy.assert(staff, 'approval.view');
      return this.view(
        staff,
        request,
        await this.decisions(tx, requestId),
        await scopeProperties(tx),
      );
    });
  }

  private view(
    staff: Staff,
    request: RequestRow,
    decisions: DecisionRow[],
    scope: readonly string[] | null,
  ): ApprovalView {
    return { request, decisions, mayDecide: this.mayDecide(staff, request, decisions, scope) };
  }

  /**
   * A second person's decision, open to this person now: the request waits for one and has not
   * expired, they have not decided it, and the policy lets them decide this kind of request (not
   * its initiator, and in a role the action type accepts). A request whose action type has no
   * handler here can be decided by nobody.
   */
  private mayDecide(
    staff: Staff,
    request: RequestRow,
    decisions: readonly DecisionRow[],
    scope: readonly string[] | null,
  ): boolean {
    const handler = this.handlers.get(request.actionType);
    if (!handler || request.mode !== 'two_person' || request.status !== 'pending') return false;
    if (request.expiresAt.getTime() <= this.clock.now().getTime()) return false;
    if (decisions.some((d) => d.decidedBy === staff.personId)) return false;
    return this.policy.can(staff, 'approval.decide', {
      initiatorPersonId: request.initiatedBy,
      eligibleRoles: handler.eligibleRoles,
      propertyId: request.propertyId,
      scopeProperties: scope,
    }).allowed;
  }

  private decisions(tx: Tx, requestId: string): Promise<DecisionRow[]> {
    return tx
      .select()
      .from(schema.approvalDecision)
      .where(eq(schema.approvalDecision.requestId, requestId))
      .orderBy(schema.approvalDecision.decidedAt);
  }

  private async close(
    tx: Tx,
    request: RequestRow,
    status: 'approved' | 'rejected' | 'cancelled',
    reason: string,
  ): Promise<void> {
    await tx
      .update(schema.approvalRequest)
      .set({ status, closeReason: reason })
      .where(eq(schema.approvalRequest.id, request.id));
    await this.audit.append(tx, {
      companyId: request.companyId,
      action: `approval.${status}`,
      recordType: 'approval_request',
      recordId: request.id,
      data: { actionType: request.actionType, reason },
    });
    await enqueueOutbox(tx, {
      companyId: request.companyId,
      type: `approval.${status}`,
      payload: { requestId: request.id, actionType: request.actionType },
      idempotencyKey: `approval.${status}:${request.id}`,
    });
  }
}
