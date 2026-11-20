import { OPS_REASON_MAX, OPS_REASON_MIN, type QueueLevel } from '@rent/domain/ops';

// Operations in the console (M11 decision 9; plan 4.7): queue ages, the worker's heartbeat, and
// webhooks and jobs to replay or retry. Errors are shown as the API's codes and short messages.

export const QUEUE_LEVEL_LABELS: Record<QueueLevel, string> = {
  ok: 'OK',
  warning: 'Warning',
  critical: 'Critical',
};

export const QUEUE_LEVEL_TONES: Record<QueueLevel, 'green' | 'amber' | 'red'> = {
  ok: 'green',
  warning: 'amber',
  critical: 'red',
};

export const WEBHOOK_STATUS_LABELS = {
  failed: 'Failed',
  dead_lettered: 'Dead-lettered',
  processed: 'Processed',
  pending: 'Waiting',
} as const;

/** "45 s", "12 min", "3 h 5 min", or "None waiting". */
export function ageText(seconds: number | null): string {
  if (seconds === null) return 'None waiting';
  if (!Number.isSafeInteger(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}

/** A queue's thresholds in words: "warning after 5 min, critical after 15 min". */
export const thresholdsText = (warn: number, critical: number): string =>
  `warning after ${ageText(warn)}, critical after ${ageText(critical)}`;

/** The worker's heartbeat in words (the API's `healthy` decides). */
export function heartbeatText(beat: {
  readonly healthy: boolean;
  readonly ageSeconds: number | null;
}): string {
  if (beat.ageSeconds === null) return 'The worker has never reported in.';
  return beat.healthy
    ? `The worker is running: last heard from ${ageText(beat.ageSeconds)} ago.`
    : `The worker has not reported in for ${ageText(beat.ageSeconds)}. Jobs are not being run.`;
}

/** A replay or retry's reason (decision 9): 5 to 500 characters, kept in the audit chain. */
/** "Run again" is offered once per dead letter: the API refuses a second retry (M11 review). */
export const mayRunAgain = (job: { readonly retriedAt: string | null }): boolean =>
  job.retriedAt === null;

export function opsReasonProblem(
  reason: string,
  min = OPS_REASON_MIN,
  max = OPS_REASON_MAX,
): string | null {
  const length = reason.trim().length;
  if (length < min)
    return `Give a reason of at least ${min} characters; it is kept in the audit log.`;
  if (length > max) return `Keep the reason under ${max} characters.`;
  return null;
}

/**
 * An alert's stored context (M11 runbook review), already scrubbed by StoredAlert: shown as text,
 * key by key, never as HTML. Nested values are written as JSON; an empty context gives nothing.
 */
export function alertContextRows(data: unknown): { key: string; value: string }[] {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return [];
  return Object.entries(data as Record<string, unknown>).map(([key, value]) => ({
    key,
    value:
      value === null || value === undefined
        ? '—'
        : typeof value === 'string'
          ? value
          : JSON.stringify(value),
  }));
}

/** The context an alert row carries, while the health contract may not list it yet. */
export const alertDataOf = (alert: object): unknown =>
  'data' in alert ? (alert as { readonly data?: unknown }).data : undefined;

/** A retention category's rule in words (decision 5): verified with its period, or not. */
export function retentionStatusText(row: {
  readonly verified: boolean;
  readonly years: number | null;
}): string {
  if (!row.verified)
    return row.years === null
      ? 'No value yet: counsel must supply it. Everything is kept.'
      : `${row.years} years, not yet verified by counsel: nothing is counted, everything is kept.`;
  return row.years === null
    ? 'Verified, with no period.'
    : `Kept ${row.years} ${row.years === 1 ? 'year' : 'years'}.`;
}
