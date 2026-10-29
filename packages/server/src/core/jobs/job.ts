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
    options?: { singletonKey?: string },
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
  handle(payload: T, ctx: JobContext): Promise<void>;
  /**
   * Runs once the job has failed its last retry (or expired), after the dead-letter alert, so
   * the work it was doing can be marked failed instead of looking busy for ever. Idempotent.
   */
  onDeadLetter?(payload: T, ctx: { readonly logger: AppLogger }): Promise<void>;
}

export const defineJob = <T>(definition: JobDefinition<T>): JobDefinition<T> => definition;

export const DEAD_LETTER_QUEUE = 'jobs.dead-letter';
export const SCHEDULE_TIME_ZONE = 'Africa/Accra';
