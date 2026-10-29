import { Inject, Injectable } from '@nestjs/common';
import { and, eq, schema, withCompany, withSystem, type Database } from '@rent/db';
import { parseBusinessDate, toIsoDate, type BusinessDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import {
  needsWarning,
  parseRuleValue,
  resolveAsOf,
  RULE_KEY_PATTERN,
  type RuleRow,
  type VerificationStatus,
} from '@rent/domain/rules';
import { DATABASE } from '../core/tokens';

export interface ResolvedRule {
  /** Record this with whatever was calculated, so the result never changes (CLAUDE.md section 7). */
  readonly ruleId: string;
  readonly key: string;
  readonly value: unknown;
  readonly verificationStatus: VerificationStatus;
  readonly source: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  /** Staff see a warning where an unverified value affects a legal outcome. */
  readonly warning: boolean;
}

export interface NewRule {
  readonly country: string;
  readonly key: string;
  readonly value: unknown;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
  readonly source: string;
  readonly verificationStatus: VerificationStatus;
  readonly verifiedBy?: string | null;
  readonly notes?: string | null;
  readonly createdBy: string;
}

type Row = typeof schema.rule.$inferSelect;

const toRuleRow = (r: Row): RuleRow => ({
  id: r.id,
  country: r.country,
  key: r.key,
  value: r.value,
  effectiveFrom: parseBusinessDate(r.effectiveFrom),
  effectiveTo: r.effectiveTo ? parseBusinessDate(r.effectiveTo) : null,
  source: r.source,
  verificationStatus: r.verificationStatus as VerificationStatus,
  createdAt: r.createdAt,
});

const toResolved = (r: Row): ResolvedRule => ({
  ruleId: r.id,
  key: r.key,
  value: r.value,
  verificationStatus: r.verificationStatus as VerificationStatus,
  source: r.source,
  effectiveFrom: r.effectiveFrom,
  effectiveTo: r.effectiveTo,
  warning: needsWarning({ verificationStatus: r.verificationStatus as VerificationStatus }),
});

/** Legal, tax and regulatory values by country and date (TX-08). Rows are never edited. */
@Injectable()
export class RulesService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /** The value in force on `asOf`. A missing rule is an error, never a silent default. */
  async resolve(country: string, key: string, asOf: BusinessDate): Promise<ResolvedRule> {
    const rows = await withSystem(this.database, {}, (tx) =>
      tx
        .select()
        .from(schema.rule)
        .where(and(eq(schema.rule.country, country), eq(schema.rule.key, key))),
    );
    const chosen = resolveAsOf(rows.map(toRuleRow), asOf);
    if (!chosen)
      throw new DomainError('rule.missing', `No rule ${key} for ${country} on ${toIsoDate(asOf)}`);
    return toResolved(rows.find((r) => r.id === chosen.id)!);
  }

  /** Every rule in force on `asOf` for a country, one per key. */
  async inForce(country: string, asOf: BusinessDate): Promise<ResolvedRule[]> {
    const rows = await withSystem(this.database, {}, (tx) =>
      tx.select().from(schema.rule).where(eq(schema.rule.country, country)),
    );
    const byKey = new Map<string, Row[]>();
    for (const row of rows) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);
    const resolved: ResolvedRule[] = [];
    for (const [, group] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
      const chosen = resolveAsOf(group.map(toRuleRow), asOf);
      if (chosen) resolved.push(toResolved(group.find((r) => r.id === chosen.id)!));
    }
    return resolved;
  }

  /**
   * Adds a rule row (a new value, a verification or a correction). Written in the platform
   * company's context, so the audit trigger records it in the platform chain.
   */
  async add(rule: NewRule, platformCompanyId: string): Promise<string> {
    if (!RULE_KEY_PATTERN.test(rule.key))
      throw new DomainError('rule.bad_key', `Invalid rule key ${rule.key}`);
    const value = parseRuleValue(rule.key, rule.value);
    parseBusinessDate(rule.effectiveFrom);
    if (rule.effectiveTo) parseBusinessDate(rule.effectiveTo);
    if (rule.verificationStatus === 'verified' && !rule.verifiedBy) {
      throw new DomainError(
        'rule.verifier_required',
        'A verified rule needs the name of whoever verified it',
      );
    }
    return withCompany(
      this.database,
      { companyId: platformCompanyId, actorKind: 'system' },
      async (tx) => {
        const [row] = await tx
          .insert(schema.rule)
          .values({
            country: rule.country,
            key: rule.key,
            value: value as never,
            effectiveFrom: rule.effectiveFrom,
            effectiveTo: rule.effectiveTo ?? null,
            source: rule.source,
            verificationStatus: rule.verificationStatus,
            verifiedBy: rule.verifiedBy ?? null,
            verifiedAt: rule.verificationStatus === 'verified' ? new Date() : null,
            notes: rule.notes ?? null,
            createdBy: rule.createdBy,
          })
          .returning({ id: schema.rule.id });
        return row!.id;
      },
    );
  }
}
