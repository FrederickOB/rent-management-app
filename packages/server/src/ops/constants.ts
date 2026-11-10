/** Operations for platform admins (M11 decision 9; plan 4.7 and 4.14): job names and limits. */

/** `ops.queue-age` (every minute): a queue whose oldest waiting job passes its threshold alerts. */
export const QUEUE_AGE_JOB = 'ops.queue-age';
/** `ops.retry-job` (from the outbox): a platform admin's retry of a dead-lettered job, once. */
export const OPS_RETRY_JOB = 'ops.retry-job';
/** `ops.prune` (daily): rate-limit rows past their longest window, rejected webhooks past 30 days. */
export const PRUNE_JOB = 'ops.prune';

/** The worker beats every 30 seconds; the api calls it stale after HEARTBEAT_STALE_SECONDS. */
export const HEARTBEAT_INTERVAL_SECONDS = 30;

/**
 * A queue's age alert goes at most once per window per queue and level, so a backlog that lasts
 * an hour raises one warning and two critical alerts, not sixty (consumeAlertWindow).
 */
export const QUEUE_ALERT_WINDOW_MINUTES = { warning: 60, critical: 30 } as const;

/**
 * Rate-limit rows are kept for 24 hours after their window began or their last hit: the longest
 * window in use is a day (the per-phone code caps, unknown senders' media).
 */
export const RATE_LIMIT_KEEP_MS = 24 * 60 * 60 * 1000;

/** Rejected webhooks (bad signature or too large: no body) are kept 30 days (review R3 F1). */
export const REJECTED_WEBHOOK_KEEP_DAYS = 30;

/** The console's lists show the newest this many. */
export const OPS_LIST_LIMIT = 200;

/** The incident commands select at most this many rows a run. */
export const OPS_CLI_MAX = 5_000;
