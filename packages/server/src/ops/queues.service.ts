import { Inject, Injectable } from '@nestjs/common';
import { sql, withSystem, type Database } from '@rent/db';
import {
  isPaymentsQueue,
  QUEUE_AGE_THRESHOLDS,
  queueLevel,
  type QueueLevel,
} from '@rent/domain/ops';
import type { Actor } from '@rent/domain/policy';
import type { AlertPort } from '@rent/integrations';
import { platformAdminFor } from '../admin/platform-admin';
import type { Clock } from '../core/clock';
import { consumeAlertWindow } from '../core/rate-limit';
import { ALERT_PORT, CLOCK, DATABASE } from '../core/tokens';
import { PolicyService } from '../policy/policy.service';
import { QUEUE_ALERT_WINDOW_MINUTES } from './constants';

/** A queue as the console shows it (the contract's `opsQueueSchema`). */
export interface OpsQueueView {
  readonly name: string;
  readonly queued: number;
  readonly active: number;
  /** How long the oldest job ready to run has waited; null when none waits. */
  readonly oldestAgeSeconds: number | null;
  readonly warnAfterSeconds: number;
  readonly criticalAfterSeconds: number;
  readonly level: QueueLevel;
}

/** A queue's thresholds: payments queues 5 and 15 minutes, the rest 30 and 120 (decision 9). */
export const thresholdsOf = (name: string) =>
  isPaymentsQueue(name) ? QUEUE_AGE_THRESHOLDS.payments : QUEUE_AGE_THRESHOLDS.other;

/**
 * Queue depth and age (M11 decision 9; plan 4.7). Each pg-boss queue's waiting and running jobs,
 * and how long its oldest job ready to run has waited (a job scheduled for later, or a retry
 * waiting out its backoff, is not waiting yet). `ops.queue-age` alerts every minute on each queue
 * past its warning or critical threshold, at most once a window per queue and level.
 */
@Injectable()
export class QueueMonitorService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The console (`health.read`). */
  async queues(actor: Actor | null): Promise<OpsQueueView[]> {
    platformAdminFor(this.policy, actor, 'health.read');
    return this.stats();
  }

  /** Every queue's depth and oldest waiting job, by name. Empty until pg-boss is installed. */
  async stats(): Promise<OpsQueueView[]> {
    return withSystem(this.database, {}, async (tx) => {
      const installed = await tx.execute<{ ok: boolean }>(
        sql`select to_regclass('pgboss.job') is not null and to_regclass('pgboss.queue') is not null as ok`,
      );
      if (installed.rows[0]?.ok !== true) return [];
      const rows = await tx.execute<{
        name: string;
        queued: number;
        active: number;
        oldest: number | null;
      }>(
        sql`select q.name::text as name,
              count(j.id) filter (where j.state::text in ('created', 'retry'))::int as queued,
              count(j.id) filter (where j.state::text = 'active')::int as active,
              floor(extract(epoch from now() - min(j.start_after)
                filter (where j.state::text in ('created', 'retry') and j.start_after <= now())))::int
                as oldest
            from pgboss.queue q
            left join pgboss.job j on j.name = q.name and j.state::text in ('created', 'retry', 'active')
            group by q.name
            order by q.name`,
      );
      return rows.rows.map((r) => {
        const thresholds = thresholdsOf(r.name);
        const age = r.oldest === null ? null : Math.max(0, Number(r.oldest));
        return {
          name: r.name,
          queued: Number(r.queued),
          active: Number(r.active),
          oldestAgeSeconds: age,
          warnAfterSeconds: thresholds.warnAfterSeconds,
          criticalAfterSeconds: thresholds.criticalAfterSeconds,
          level: queueLevel(age, thresholds),
        };
      });
    });
  }

  /**
   * `ops.queue-age` (every minute): one alert per queue past a threshold, warning or critical, at
   * most once a window per queue and level (consumeAlertWindow; the next one says how many were
   * held back). Payments queues by isPaymentsQueue. Ids and counts only.
   */
  async alertAges(): Promise<{ checked: number; alerted: { queue: string; level: QueueLevel }[] }> {
    const queues = await this.stats();
    const alerted: { queue: string; level: QueueLevel }[] = [];
    const nowMs = this.clock.now().getTime();
    for (const q of queues) {
      if (q.level === 'ok') continue;
      const level = q.level;
      const window = await consumeAlertWindow(
        this.database,
        `ops:queue-age:${level}:${q.name}`,
        { count: 1, windowMinutes: QUEUE_ALERT_WINDOW_MINUTES[level] },
        nowMs,
      );
      if (!window.raise) continue;
      const minutes = Math.floor((q.oldestAgeSeconds ?? 0) / 60);
      const limit = level === 'critical' ? q.criticalAfterSeconds : q.warnAfterSeconds;
      await this.alerts.raise({
        severity: level,
        code: `ops.queue_age_${level}`,
        message: `Queue ${q.name}: its oldest waiting job is ${minutes} minutes old (${level} after ${limit / 60}). ${q.queued} waiting, ${q.active} running.${
          window.suppressedBefore > 0
            ? ` ${window.suppressedBefore} more were not alerted in the last window.`
            : ''
        }`,
        context: {
          queue: q.name,
          level,
          oldestAgeSeconds: q.oldestAgeSeconds,
          warnAfterSeconds: q.warnAfterSeconds,
          criticalAfterSeconds: q.criticalAfterSeconds,
          queued: q.queued,
          active: q.active,
          suppressedBefore: window.suppressedBefore,
        },
      });
      alerted.push({ queue: q.name, level });
    }
    return { checked: queues.length, alerted };
  }
}
