import { Injectable } from '@nestjs/common';
import type { CompanyContext } from '@rent/db';
import {
  can,
  scopeOf,
  type Actor,
  type ApprovalResource,
  type Decision,
  type PolicyAction,
  type ScopeIds,
} from '@rent/domain/policy';
import { forbidden } from '../core/errors';

type StaffActor = Extract<Actor, { kind: 'staff' }>;

/**
 * The transaction context for a staff actor, scope included (AD-02). Register and tenancy
 * services use it, so a scoped person's queries are limited by the database as well.
 */
export function staffContext(actor: StaffActor, requestId?: string | null): CompanyContext {
  return {
    companyId: actor.companyId,
    personId: actor.personId,
    actorKind: 'staff',
    requestId: requestId ?? null,
    scope: scopeOf(actor),
  };
}

/**
 * The single authorization path (CLAUDE.md section 5). Route guards and resource checks both
 * call it; the permission map itself is pure code in packages/domain/policy.
 */
@Injectable()
export class PolicyService {
  can(actor: Actor, action: PolicyAction, resource?: ApprovalResource): Decision {
    return can(actor, action, resource);
  }

  assert(actor: Actor, action: PolicyAction, resource?: ApprovalResource): void {
    const decision = can(actor, action, resource);
    if (!decision.allowed) throw forbidden();
  }

  /** The owners and properties an actor sees; null means the whole company (AD-02). */
  scopeFor(actor: Actor): ScopeIds | null {
    return scopeOf(actor);
  }
}
