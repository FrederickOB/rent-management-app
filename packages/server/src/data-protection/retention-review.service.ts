import { Inject, Injectable } from '@nestjs/common';
import { sql, withCompany, withSystem, type Database } from '@rent/db';
import { RETENTION_CATEGORIES, type RetentionCategory } from '@rent/domain/data-protection';
import {
  addMonths,
  businessDateOf,
  DEFAULT_TIME_ZONE,
  instantFrom,
  instantToDate,
  parseBusinessDate,
  startOfDay,
  toIsoDate,
} from '@rent/domain/dates';
import type { Actor } from '@rent/domain/policy';
import { companyRecord } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import { forbidden } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { PolicyService } from '../policy/policy.service';
import { RulesService } from '../rules/rules.service';
import {
  decide,
  RETENTION_RULE_KEYS,
  retentionRulesIn,
  tenantRetentionFactsIn,
  type RetentionRule,
} from './retention';

/** The nightly job (plan 4.14; keyed by the day). */
export const RETENTION_REVIEW_JOB = 'retention.review';

/** The country whose rules the console shows (the only market so far, CLAUDE.md section 11). */
const HOME_COUNTRY = 'GH';

export interface RetentionCategoryReview {
  readonly category: RetentionCategory;
  readonly ruleKey: string;
  /** Verified in every country the platform's companies are in. */
  readonly verified: boolean;
  readonly years: number | null;
  /** Records past a verified period; 0 while unverified (nothing is counted, or deleted). */
  readonly pastRetention: number;
}

export interface RetentionReviewView {
  readonly checkedAt: Date | null;
  readonly categories: readonly RetentionCategoryReview[];
}

/**
 * The nightly retention review (M11 decision 5; NFR-DP): per category, the records past each
 * verified retention period, across companies, stored once per day in `retention_review` for the
 * console. It counts only; nothing is deleted or anonymised on a timer. Companies are read one at a
 * time in their own context (ADR-002 fan-out); provider webhook bodies, a system table, through
 * the system path. Records of a tenant are counted as an erasure would see them (`decide`): the
 * category's rule must be verified and its period over.
 */
@Injectable()
export class RetentionReviewService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private today(): string {
    return toIsoDate(businessDateOf(instantFrom(this.clock.now()), DEFAULT_TIME_ZONE));
  }

  /** Works the review out for today and stores it, once a day: a second run keeps the first. */
  async run(): Promise<{
    checkedOn: string;
    stored: boolean;
    categories: RetentionCategoryReview[];
  }> {
    const checkedOn = this.today();
    const companies = await withSystem(this.database, {}, (tx) =>
      tx.execute<{ id: string }>(sql`select id from app.company_ids() as id`),
    );
    const counts = new Map<RetentionCategory, number>(RETENTION_CATEGORIES.map((c) => [c, 0]));
    const byCountry = new Map<string, Record<RetentionCategory, RetentionRule>>();
    for (const { id } of companies.rows) {
      await withCompany(
        this.database,
        { companyId: id, actorKind: 'system' },
        async (tx) => {
          const company = await companyRecord(tx, id);
          if (!company) return;
          const today = toIsoDate(businessDateOf(instantFrom(this.clock.now()), company.timeZone));
          const rules = await retentionRulesIn(tx, this.rules, company.countryCode, today);
          if (!byCountry.has(company.countryCode)) byCountry.set(company.countryCode, rules);
          // Nothing verified: nothing to count, and no reason to read the company's tenants.
          if (!RETENTION_CATEGORIES.some((c) => c !== 'webhook_bodies' && rules[c].verified))
            return;
          for (const facts of await tenantRetentionFactsIn(tx, company.timeZone)) {
            for (const category of RETENTION_CATEGORIES) {
              if (category === 'webhook_bodies') continue;
              const decision = decide(
                rules[category],
                facts.records[category],
                facts.from[category],
                today,
                facts.live,
              );
              if (decision.kind === 'anonymise')
                counts.set(category, counts.get(category)! + decision.records);
            }
          }
        },
        { accessMode: 'read only' },
      );
    }
    // Provider webhook bodies: one system table for every company, under the home country's rule.
    const home =
      byCountry.get(HOME_COUNTRY) ??
      (await withSystem(this.database, {}, (tx) =>
        retentionRulesIn(tx, this.rules, HOME_COUNTRY, checkedOn),
      ));
    if (!byCountry.has(HOME_COUNTRY)) byCountry.set(HOME_COUNTRY, home);
    const webhook = home.webhook_bodies;
    if (webhook.verified && webhook.years !== null) {
      const cutoff = instantToDate(
        startOfDay(addMonths(parseBusinessDate(checkedOn), -12 * webhook.years), DEFAULT_TIME_ZONE),
      );
      const rows = await withSystem(this.database, {}, (tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from webhook_inbox
              where raw_body is not null and received_at < ${cutoff}`,
        ),
      );
      counts.set('webhook_bodies', Number(rows.rows[0]?.n ?? 0));
    }
    const categories = RETENTION_CATEGORIES.map((category): RetentionCategoryReview => {
      const all = [...byCountry.values()].map((r) => r[category]);
      const years = all.every((r) => r.years === home[category].years)
        ? home[category].years
        : null;
      return {
        category,
        ruleKey: RETENTION_RULE_KEYS[category],
        verified: all.every((r) => r.verified),
        years,
        pastRetention: counts.get(category)!,
      };
    });
    const inserted = await withSystem(this.database, {}, (tx) =>
      tx.execute<{ id: string }>(
        sql`insert into retention_review (checked_on, categories)
            values (${checkedOn}::date, ${JSON.stringify(categories)}::jsonb)
            on conflict (checked_on) do nothing returning id`,
      ),
    );
    return { checkedOn, stored: inserted.rows.length > 0, categories };
  }

  /**
   * The latest review, for platform admins (`health.read`: the console's health page). Before the
   * first run: today's rules, nothing counted, and no time checked.
   */
  async latest(actor: Actor | null): Promise<RetentionReviewView> {
    if (!actor) throw forbidden();
    this.policy.assert(actor, 'health.read');
    switch (actor.kind) {
      case 'platform_admin':
        break;
      default:
        throw forbidden();
    }
    return withSystem(
      this.database,
      { personId: actor.personId, actorKind: 'platform_admin' },
      async (tx) => {
        const [row] = (
          await tx.execute<{ checked_at: Date | string; categories: RetentionCategoryReview[] }>(
            sql`select checked_at, categories from retention_review order by checked_on desc limit 1`,
          )
        ).rows;
        if (row)
          return {
            checkedAt: row.checked_at instanceof Date ? row.checked_at : new Date(row.checked_at),
            categories: row.categories,
          };
        const rules = await retentionRulesIn(tx, this.rules, HOME_COUNTRY, this.today());
        return {
          checkedAt: null,
          categories: RETENTION_CATEGORIES.map((category) => ({
            category,
            ruleKey: RETENTION_RULE_KEYS[category],
            verified: rules[category].verified,
            years: rules[category].years,
            pastRetention: 0,
          })),
        };
      },
    );
  }
}
