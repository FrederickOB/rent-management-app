import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { parseBusinessDate, businessDateOf, instantFrom } from '@rent/domain/dates';
import { ApprovalsService, type ApprovalView } from '@rent/server/approvals';
import { AuditService } from '@rent/server/audit';
import { forbidden } from '@rent/server/core';
import { PolicyService } from '@rent/server/policy';
import { RulesService } from '@rent/server/rules';
import { Ctx, type RequestContext } from '../http/request-context';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const AUDIT_NEEDS_WHOLE_COMPANY =
  'The audit log covers the whole company, so it is not open to people limited to some owners or properties';

function toApproval({ request, decisions }: ApprovalView) {
  return {
    id: request.id,
    actionType: request.actionType,
    subjectType: request.subjectType,
    subjectId: request.subjectId,
    payload: request.payload,
    initiatedBy: request.initiatedBy,
    mode: request.mode as 'two_person' | 'single_user',
    status: request.status as
      'pending' | 'cooling_off' | 'approved' | 'rejected' | 'cancelled' | 'expired',
    coolingOffUntil: iso(request.coolingOffUntil),
    expiresAt: request.expiresAt.toISOString(),
    closeReason: request.closeReason,
    createdAt: request.createdAt.toISOString(),
    decisions: decisions.map((d) => ({
      decidedBy: d.decidedBy,
      kind: d.kind as 'approve' | 'reject' | 'self_confirm',
      reason: d.reason,
      decidedAt: d.decidedAt.toISOString(),
    })),
  };
}

/** Audit search (AD-07), approvals (AD-05) and the rules table (TX-08). */
@Controller()
export class GovernanceController {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  @Implement(contract.audit.search)
  auditSearch(@Ctx() ctx: RequestContext) {
    return implement(contract.audit.search).handler(async ({ input }) => {
      const actor = ctx.actor;
      if (!actor || actor.kind !== 'staff') throw forbidden();
      this.policy.assert(actor, 'audit.search');
      // Audit events carry whole rows from every register table, before and after, so the log
      // cannot be cut down to some owners or properties: a scoped session does not search it.
      if (this.policy.scopeFor(actor) !== null) throw forbidden(AUDIT_NEEDS_WHOLE_COMPANY);
      const result = await this.audit.search(actor.companyId, actor.personId, {
        ...input,
        from: input.from ? new Date(input.from) : undefined,
        to: input.to ? new Date(input.to) : undefined,
      });
      return {
        events: result.events.map((e) => ({
          ...e,
          occurredAt: e.occurredAt.toISOString(),
          actorName: e.actorName ?? null,
        })),
        nextBefore: result.nextBefore,
      };
    });
  }

  @Implement(contract.approvals)
  approvalsRouter(@Ctx() ctx: RequestContext) {
    return {
      list: implement(contract.approvals.list).handler(async ({ input }) =>
        (await this.approvals.list(ctx.actor, input.status)).map(toApproval),
      ),
      get: implement(contract.approvals.get).handler(async ({ input }) =>
        toApproval(await this.approvals.get(ctx.actor, input.id)),
      ),
      decide: implement(contract.approvals.decide).handler(async ({ input }) =>
        toApproval(
          await this.approvals.decide(ctx.actor, input.id, {
            decision: input.decision,
            reason: input.reason,
            code: input.code,
          }),
        ),
      ),
      cancel: implement(contract.approvals.cancel).handler(async ({ input }) =>
        toApproval(await this.approvals.cancel(ctx.actor, input.id)),
      ),
    };
  }

  @Implement(contract.rules.list)
  rulesList(@Ctx() ctx: RequestContext) {
    return implement(contract.rules.list).handler(async ({ input }) => {
      if (!ctx.actor) throw forbidden();
      this.policy.assert(ctx.actor, 'rules.view');
      const asOf = input.asOf
        ? parseBusinessDate(input.asOf)
        : businessDateOf(instantFrom(new Date()));
      const rules = await this.rules.inForce(input.country, asOf);
      return rules.map((r) => ({
        id: r.ruleId,
        country: input.country,
        key: r.key,
        value: r.value,
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo,
        source: r.source,
        verificationStatus: r.verificationStatus,
        warning: r.warning,
      }));
    });
  }
}
