import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, type Database } from '@rent/db';
import { businessDateOf, DEFAULT_TIME_ZONE, instantFrom, toIsoDate } from '@rent/domain/dates';
import type { Actor } from '@rent/domain/policy';
import type { Clock } from '../core/clock';
import { CLOCK, DATABASE } from '../core/tokens';

type StaffActor = Extract<Actor, { kind: 'staff' }>;

/** Days remembered per process before the cache starts again (a day's staff fit easily). */
const MAX_REMEMBERED = 50_000;

/**
 * The days each staff member used the app (M11 decision 4: weekly active managers), recorded in
 * `staff_active_day` at most once per person, company and day: on their first request, and then
 * remembered in memory, so later requests that day touch no database. The day is the company's
 * business date. Several API processes may each write the same day once; the table keeps one.
 * Everyone on a company's staff is recorded; the Gate 1 rollup counts only its managers.
 */
@Injectable()
export class StaffActivityService {
  private readonly seen = new Set<string>();
  private readonly zones = new Map<string, string>();

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Records today for a staff member; true when this call wrote the day. */
  async record(actor: StaffActor): Promise<boolean> {
    const now = instantFrom(this.clock.now());
    const known = this.zones.get(actor.companyId);
    if (known) {
      const key = `${actor.companyId}:${actor.personId}:${toIsoDate(businessDateOf(now, known))}`;
      if (this.seen.has(key)) return false;
    }
    const ctx = {
      companyId: actor.companyId,
      personId: actor.personId,
      actorKind: 'staff' as const,
    };
    const { day, written } = await withCompany(this.database, ctx, async (tx) => {
      let zone = known;
      if (!zone) {
        const rows = await tx.execute<{ time_zone: string }>(
          sql`select time_zone from company where id = ${actor.companyId}::uuid`,
        );
        zone = rows.rows[0]?.time_zone ?? DEFAULT_TIME_ZONE;
        this.zones.set(actor.companyId, zone);
      }
      const day = toIsoDate(businessDateOf(now, zone));
      const inserted = await tx.execute<{ day: string }>(
        sql`insert into staff_active_day (company_id, person_id, day)
            values (${actor.companyId}::uuid, ${actor.personId}::uuid, ${day}::date)
            on conflict do nothing returning day::text as day`,
      );
      return { day, written: inserted.rows.length > 0 };
    });
    if (this.seen.size >= MAX_REMEMBERED) this.seen.clear();
    this.seen.add(`${actor.companyId}:${actor.personId}:${day}`);
    return written;
  }
}
