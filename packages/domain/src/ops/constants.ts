/** Operations (M11 decision 9; plan 4.7): replay, retry, queue alerts and the worker heartbeat. */

/** A queue's oldest-job thresholds, in seconds: payments queues are tighter. */
export const QUEUE_AGE_THRESHOLDS = {
  payments: { warnAfterSeconds: 5 * 60, criticalAfterSeconds: 15 * 60 },
  other: { warnAfterSeconds: 30 * 60, criticalAfterSeconds: 120 * 60 },
} as const;

export const QUEUE_LEVELS = ['ok', 'warning', 'critical'] as const;
export type QueueLevel = (typeof QUEUE_LEVELS)[number];

/** The level of a queue whose oldest waiting job is `ageSeconds` old. */
export function queueLevel(
  ageSeconds: number | null,
  thresholds: { readonly warnAfterSeconds: number; readonly criticalAfterSeconds: number },
): QueueLevel {
  if (ageSeconds === null) return 'ok';
  if (ageSeconds >= thresholds.criticalAfterSeconds) return 'critical';
  if (ageSeconds >= thresholds.warnAfterSeconds) return 'warning';
  return 'ok';
}

/** Whether a queue name is a payments queue (its thresholds are tighter). */
export const isPaymentsQueue = (name: string): boolean =>
  name.startsWith('payments.') || name.startsWith('subscription.verify');

/** The worker's heartbeat is healthy while its last beat is younger than this. */
export const HEARTBEAT_STALE_SECONDS = 120;

/** What a webhook replay or a job retry needs from the platform admin (decision 9). */
export const OPS_REASON_MIN = 5;
export const OPS_REASON_MAX = 500;
