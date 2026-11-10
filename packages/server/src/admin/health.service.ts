import { Inject, Injectable } from '@nestjs/common';
import { sql, type Database } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import type { Clock } from '../core/clock';
import { DEAD_LETTER_QUEUE } from '../core/jobs/job';
import { CLOCK, DATABASE } from '../core/tokens';
import { PolicyService } from '../policy/policy.service';
import { withPlatform } from '../subscription/platform';
import { platformAdminFor } from './platform-admin';

export type AlertSeverity = 'info' | 'warning' | 'critical';

/** System health (AD-10; M10 decision 15), as the contract's `healthSchema` carries it. */
export interface HealthView {
  readonly checkedAt: Date;
  readonly queues: readonly {
    readonly name: string;
    readonly queued: number;
    readonly active: number;
    readonly failed24h: number;
  }[];
  readonly deadLettered24h: number;
  readonly failedWebhooks: number;
  readonly scheduledJobs: readonly {
    readonly name: string;
    readonly lastRunAt: Date | null;
    readonly lastState: string | null;
  }[];
  /** The nightly chain verification (AD-07): when it last ran, and chains it found broken. */
  readonly auditChains: { readonly checkedAt: Date | null; readonly broken: number };
  readonly recentAlerts: readonly {
    readonly at: Date;
    readonly severity: AlertSeverity;
    readonly code: string;
    readonly message: string;
    readonly companyId: string | null;
  }[];
}

const RECENT_ALERTS = 50;
const WEBHOOK_HOURS = 24;

const severityOf = (value: string): AlertSeverity =>
  value === 'critical' || value === 'warning' ? value : 'info';

/**
 * The console's system health (decision 15): the job queues (pg-boss), jobs dead-lettered in the
 * last day, provider webhooks whose processing failed in the last day, the last run of each
 * scheduled job, the nightly audit chain verification and recent stored alerts. Read through
 * narrow functions and the platform company's own chain, where `audit.verify-chain` records each
 * company's result (`audit.chain_verified`).
 */
@Injectable()
export class SystemHealthService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async health(actor: Actor | null): Promise<HealthView> {
    const admin = platformAdminFor(this.policy, actor, 'health.read');
    return withPlatform(
      this.database,
      { personId: admin.personId, actorKind: 'platform_admin' },
      async (tx, platformId) => {
        const queues = await tx.execute<{
          name: string;
          queued: number;
          active: number;
          failed_24h: number;
          created_24h: number;
        }>(
          sql`select name, queued, active, failed_24h, created_24h from app.platform_job_queues()`,
        );
        const scheduled = await tx.execute<{
          name: string;
          last_run_at: Date | string | null;
          last_state: string | null;
        }>(sql`select name, last_run_at, last_state from app.platform_scheduled_jobs()`);
        const webhooks = await tx.execute<{ failed: number }>(
          sql`select app.platform_failed_webhooks(${WEBHOOK_HOURS}::int) as failed`,
        );
        const checked = await tx.execute<{ checked_at: Date | string | null }>(
          sql`select max(occurred_at) as checked_at from audit_event
              where company_id = ${platformId}::uuid and action = 'audit.chain_verified'`,
        );
        const checkedAt = checked.rows[0]?.checked_at ?? null;
        // Each company's latest result from around the last run (the job runs nightly).
        const broken =
          checkedAt === null
            ? 0
            : Number(
                (
                  await tx.execute<{ broken: number }>(
                    sql`select count(*)::int as broken from (
                          select distinct on (record_id) record_id, (data ->> 'ok')::boolean as ok
                          from audit_event
                          where company_id = ${platformId}::uuid and action = 'audit.chain_verified'
                            and occurred_at >= ${new Date(checkedAt).toISOString()}::timestamptz - interval '2 days'
                          order by record_id, seq desc) latest
                        where not latest.ok`,
                  )
                ).rows[0]?.broken ?? 0,
              );
        const alerts = await tx.execute<{
          occurred_at: Date | string;
          severity: string;
          code: string;
          message: string;
          subject_company_id: string | null;
        }>(
          sql`select occurred_at, severity, code, message, subject_company_id
              from app.recent_alerts(${RECENT_ALERTS}::int)`,
        );
        const dead = queues.rows.find((q) => q.name === DEAD_LETTER_QUEUE);
        return {
          checkedAt: this.clock.now(),
          queues: queues.rows
            .filter((q) => q.name !== DEAD_LETTER_QUEUE)
            .map((q) => ({
              name: q.name,
              queued: Number(q.queued),
              active: Number(q.active),
              failed24h: Number(q.failed_24h),
            })),
          deadLettered24h: dead ? Number(dead.created_24h) : 0,
          failedWebhooks: Number(webhooks.rows[0]?.failed ?? 0),
          scheduledJobs: scheduled.rows.map((s) => ({
            name: s.name,
            lastRunAt: s.last_run_at === null ? null : new Date(s.last_run_at),
            lastState: s.last_state,
          })),
          auditChains: { checkedAt: checkedAt === null ? null : new Date(checkedAt), broken },
          recentAlerts: alerts.rows.map((a) => ({
            at: new Date(a.occurred_at),
            severity: severityOf(a.severity),
            code: a.code,
            message: a.message,
            companyId: a.subject_company_id,
          })),
        };
      },
    );
  }
}
