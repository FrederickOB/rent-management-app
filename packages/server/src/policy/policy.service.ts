import { Injectable } from '@nestjs/common';
import {
  can,
  type Actor,
  type ApprovalResource,
  type Decision,
  type PolicyAction,
} from '@rent/domain/policy';
import { forbidden } from '../core/errors';

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
}
