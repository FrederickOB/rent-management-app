import { Injectable } from '@nestjs/common';
import type { CompanyContext } from '@rent/db';
import {
  actsForOwner,
  can,
  scopeOf,
  type Actor,
  type Decision,
  type PolicyAction,
  type PolicyResource,
  type ScopeIds,
} from '@rent/domain/policy';
import { AppError, forbidden } from '../core/errors';

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
  can(actor: Actor, action: PolicyAction, resource?: PolicyResource): Decision {
    return can(actor, action, resource);
  }

  /** Whether a person is a user for an owner (M5 decision 3: who confirms a certificate). */
  actsForOwner(actor: Actor, ownerId: string): boolean {
    return actsForOwner(actor, ownerId);
  }

  /** Refuses with the policy's message for people when it gives one, else the plain refusal. */
  assert(actor: Actor, action: PolicyAction, resource?: PolicyResource): void {
    const decision = can(actor, action, resource);
    if (!decision.allowed) {
      // M10 decision 11: 403 SUBSCRIPTION_READ_ONLY, so screens can say what it means.
      if (decision.code) throw new AppError(403, decision.code, decision.message ?? 'Forbidden');
      throw forbidden(decision.message);
    }
  }

  /** The owners and properties an actor sees; null means the whole company (AD-02). */
  scopeFor(actor: Actor): ScopeIds | null {
    return scopeOf(actor);
  }
}
