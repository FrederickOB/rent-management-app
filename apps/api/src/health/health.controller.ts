import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import { sql, withSystem, type Database } from '@rent/db';
import { DATABASE } from '@rent/server/core';
import { WorkerHeartbeatService } from '@rent/server/ops';
import type { FastifyReply } from 'fastify';
import { Public } from '../http/guards';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(WorkerHeartbeatService) private readonly heartbeat: WorkerHeartbeatService,
  ) {}

  @Public()
  @Get('live')
  live() {
    return { ok: true };
  }

  @Public()
  @Get('ready')
  async ready() {
    await withSystem(this.database, {}, (tx) => tx.execute(sql`select 1`));
    return { ok: true };
  }

  /**
   * The worker's heartbeat (M11 decision 9), for the uptime monitor (M12): 200 while the newest
   * beat is under two minutes old, 503 when it is older or there is none. Public, like `live`;
   * it says only when the worker last beat, never which machine or anything about the data.
   */
  @Public()
  @Get('worker')
  @Header('cache-control', 'no-store')
  async worker(@Res({ passthrough: true }) reply: FastifyReply) {
    const beat = await this.heartbeat.status();
    if (!beat.healthy) void reply.status(503);
    return {
      ok: beat.healthy,
      status: beat.healthy ? 'ok' : beat.lastBeatAt ? 'stale' : 'missing',
      lastBeatAt: beat.lastBeatAt?.toISOString() ?? null,
      ageSeconds: beat.ageSeconds,
    };
  }
}
