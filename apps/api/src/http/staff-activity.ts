import type { Actor } from '@rent/domain/policy';

/** What the hook needs from `StaffActivityService` (packages/server/src/reporting). */
export interface StaffActivityRecorder {
  record(actor: Extract<Actor, { kind: 'staff' }>): Promise<unknown>;
}

/**
 * M11 decision 4 (Gate 1: weekly active managers): notes a staff member's request as activity for
 * the day, in the background. It never delays or fails the request: the write runs after the
 * guard has answered, and any error is dropped (a missed day only lowers a metric). Tenants,
 * platform admins (support access included) and anonymous requests are not staff, and are skipped.
 */
export function noteStaffActivity(
  recorder: StaffActivityRecorder | null | undefined,
  actor: Actor | null | undefined,
): void {
  if (!recorder || !actor) return;
  switch (actor.kind) {
    case 'staff':
      break;
    default:
      return;
  }
  try {
    void recorder.record(actor).catch(() => undefined);
  } catch {
    // A recorder that throws at once is ignored the same way.
  }
}
