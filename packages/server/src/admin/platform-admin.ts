import type { Actor, PolicyAction } from '@rent/domain/policy';
import { forbidden } from '../core/errors';
import type { PolicyService } from '../policy/policy.service';

/** A platform admin (AD-10): a person with an active platform-admin membership. */
export type PlatformAdmin = Extract<Actor, { kind: 'platform_admin' }>;

/**
 * The actor as a platform admin allowed `action` (M10 plan 4.9), through PolicyService; anyone
 * else is refused with 403. Every console route starts here.
 */
export function platformAdminFor(
  policy: PolicyService,
  actor: Actor | null,
  action: PolicyAction,
): PlatformAdmin {
  if (!actor) throw forbidden();
  policy.assert(actor, action);
  switch (actor.kind) {
    case 'platform_admin':
      return actor;
    default:
      throw forbidden();
  }
}

/** A platform admin's own context outside any company, for the narrow functions (ADR-002). */
export const platformSystemContext = (admin: PlatformAdmin, requestId?: string | null) => ({
  personId: admin.personId,
  requestId: requestId ?? null,
  actorKind: 'platform_admin' as const,
});
