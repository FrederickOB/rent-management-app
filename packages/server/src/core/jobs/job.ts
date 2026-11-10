import type { Tx } from '@rent/db';
import type { z } from 'zod';
import type { AppLogger } from '../logging/logger';

export interface RetryPolicy {
  readonly limit: number;
  readonly delaySeconds: number;
  readonly backoff: boolean;
  readonly maxDelaySeconds?: number;
}

export interface JobContext {
  readonly jobId: string;
  readonly logger: AppLogger;
  /** Set for company jobs: every query runs under this company's RLS context (ADR-002). */
  readonly companyId: string | null;
  withCompany<R>(fn: (tx: Tx) => Promise<R>): Promise<R>;
  /** Runs `fn` once per key, recording the key in the same transaction (processed_job). */
  once(key: string, fn: (tx: Tx) => Promise<void>): Promise<boolean>;
  enqueue(
    name: string,
    payload: Record<string, unknown>,
    options?: { singletonKey?: string; startAfter?: Date },
  ): Promise<void>;
}

/**
 * A job type (architecture section 10). Company jobs must carry `companyId`; system jobs are
 * schedulers that fan out one company job per company through app.company_ids().
 */
export interface JobDefinition<T = unknown> {
  readonly name: string;
  readonly scope: 'company' | 'system';
  readonly schema: z.ZodType<T>;
  readonly retry: RetryPolicy;
  /** Cron expression in Africa/Accra time, for scheduled system jobs. */
  readonly cron?: string;
  /**
   * For a high-volume queue (`messaging.send`): while jobs are waiting, fetch the next one as soon
   * as the last one ends, instead of pausing the polling interval after every job. Jobs still run
   * one at a time, each fetched alone in queue order (priority, then creation), and each settles
   * and retries on its own. A fetch that finds nothing waits the interval as usual.
   */
  readonly drain?: boolean;
  handle(payload: T, ctx: JobContext): Promise<void>;
  /**
   * Runs once the job has failed its last retry (or expired), after the dead-letter alert, so
   * the work it was doing can be marked failed instead of looking busy for ever. Idempotent.
   * M11 decision 9: `error` is why the last try failed, as a code and a short message
   * (jobErrorSummary); null or absent when pg-boss kept no output.
   */
  onDeadLetter?(
    payload: T,
    ctx: { readonly logger: AppLogger; readonly error?: string | null },
  ): Promise<void>;
}

export const defineJob = <T>(definition: JobDefinition<T>): JobDefinition<T> => definition;

export const DEAD_LETTER_QUEUE = 'jobs.dead-letter';
export const SCHEDULE_TIME_ZONE = 'Africa/Accra';
