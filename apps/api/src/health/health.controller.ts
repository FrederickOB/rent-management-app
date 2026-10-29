import { Controller, Get, Inject } from '@nestjs/common';
import { sql, withSystem, type Database } from '@rent/db';
import { DATABASE } from '@rent/server/core';
import { Public } from '../http/guards';

@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

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
}
