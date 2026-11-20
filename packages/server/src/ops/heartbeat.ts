import { hostname } from 'node:os';
import { Inject, Injectable } from '@nestjs/common';
import { sql, withSystem, type Database } from '@rent/db';
import { HEARTBEAT_STALE_SECONDS } from '@rent/domain/ops';
import type { Actor } from '@rent/domain/policy';
import { platformAdminFor } from '../admin/platform-admin';
import type { Clock } from '../core/clock';
import type { AppLogger } from '../core/logging/logger';
import { CLOCK, DATABASE } from '../core/tokens';
import { PolicyService } from '../policy/policy.service';
import { HEARTBEAT_INTERVAL_SECONDS } from './constants';

/** The worker's heartbeat as the console and `/health/worker` show it: no instance names. */
export interface HeartbeatView {
  readonly lastBeatAt: Date | null;
  readonly ageSeconds: number | null;
  readonly healthy: boolean;
}

/**
 * The worker's heartbeat (M11 decision 9): a timer in the worker process writes its row in
 * `worker_heartbeat` every 30 seconds, once its job queues and relays are running, and stops when
 * the worker stops. A beat needs the process alive, its event loop free and the database
 * reachable, so a crashed, hung or cut-off worker goes stale. One row per process (host and pid);
 * a beat that fails is logged, and the next one tries again.
 */
export class WorkerHeartbeat {
  readonly instance: string;
  private readonly startedAt: Date;
  private timer: NodeJS.Timeout | null = null;
  private beating: Promise<void> | null = null;

  constructor(
    private readonly database: Database,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly options: { readonly intervalMs?: number; readonly instance?: string } = {},
  ) {
    this.instance = (options.instance ?? `${hostname()}:${process.pid}`).slice(0, 200);
    this.startedAt = clock.now();
  }

  async start(): Promise<void> {
    await this.beat();
    this.timer = setInterval(
      () => {
        if (this.beating) return;
        this.beating = this.beat()
          .catch((error: unknown) => this.logger.warn({ err: error }, 'worker heartbeat failed'))
          .finally(() => {
            this.beating = null;
          });
      },
      this.options.intervalMs ?? HEARTBEAT_INTERVAL_SECONDS * 1000,
    );
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.beating;
  }

  /** One beat: the row's time and count, made on the first. */
  async beat(): Promise<void> {
    const now = this.clock.now();
    await withSystem(this.database, {}, (tx) =>
      tx.execute(sql`
        insert into worker_heartbeat (instance, started_at, beat_at, beats)
        values (${this.instance}, ${this.startedAt.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz, 1)
        on conflict (instance) do update set
          started_at = excluded.started_at,
          beat_at = excluded.beat_at,
          beats = worker_heartbeat.beats + 1`),
    );
  }
}

/**
 * Reads the heartbeat (decision 9): healthy while the newest beat of any worker is younger than
 * HEARTBEAT_STALE_SECONDS. For the console (`health.read`) and the api's public `/health/worker`.
 */
@Injectable()
export class WorkerHeartbeatService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async heartbeat(actor: Actor | null): Promise<HeartbeatView> {
    platformAdminFor(this.policy, actor, 'health.read');
    return this.status();
  }

  async status(): Promise<HeartbeatView> {
    const result = await withSystem(this.database, {}, (tx) =>
      tx.execute<{ last: Date | string | null }>(
        sql`select max(beat_at) as last from worker_heartbeat`,
      ),
    );
    const last = result.rows[0]?.last ?? null;
    if (last === null) return { lastBeatAt: null, ageSeconds: null, healthy: false };
    const lastBeatAt = new Date(last);
    const ageSeconds = Math.max(
      0,
      Math.floor((this.clock.now().getTime() - lastBeatAt.getTime()) / 1000),
    );
    return { lastBeatAt, ageSeconds, healthy: ageSeconds < HEARTBEAT_STALE_SECONDS };
  }
}
