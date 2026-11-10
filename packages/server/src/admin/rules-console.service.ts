import { Inject, Injectable } from '@nestjs/common';
import { and, eq, schema, sql, withCompany, withSystem, type Database } from '@rent/db';
import {
  businessDateOf,
  compareDates,
  DEFAULT_TIME_ZONE,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import type { Actor } from '@rent/domain/policy';
import { needsWarning, resolveAsOf, type VerificationStatus } from '@rent/domain/rules';
import { AuditService } from '../audit/audit.service';
import type { Clock } from '../core/clock';
import { AppError, invalid } from '../core/errors';
import { CLOCK, DATABASE } from '../core/tokens';
import { PolicyService } from '../policy/policy.service';
import { RulesService } from '../rules/rules.service';
import { platformCompanyId } from '../subscription/platform';
import { platformAdminFor, platformSystemContext } from './platform-admin';

/** A rules row as the console shows it (the contract's `ruleRowSchema`). */
export interface RuleRowView {
  readonly id: string;
  readonly country: string;
  readonly key: string;
  readonly value: unknown;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly source: string;
  readonly verificationStatus: VerificationStatus;
  readonly warning: boolean;
  readonly verifiedBy: string | null;
  readonly notes: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly state: 'in_force' | 'superseded' | 'future';
}

export interface NewRuleInput {
  readonly country: string;
  readonly key: string;
  readonly value: unknown;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
  readonly source: string;
  readonly verificationStatus: VerificationStatus;
  readonly verifiedBy?: string | null;
  readonly notes?: string | null;
}

type Row = typeof schema.rule.$inferSelect;

function dateOf(value: string, what: string): string {
  try {
    return toIsoDate(parseBusinessDate(value));
  } catch {
    throw invalid('bad_date', `${what} is not a date such as 2027-01-01`);
  }
}

/** The rules service's refusals as the console's 400s (`rule_value`, `rule_key`, ...). */
function ruleError(error: DomainError): AppError {
  switch (error.code) {
    case 'rule.bad_key':
    case 'rule.unknown_key':
      return invalid('rule_key', error.message);
    case 'rule.verifier_required':
      return invalid('rule_verifier_required', error.message);
    default:
      return invalid('rule_value', error.message);
  }
}

/**
 * The console's rules screen (M10 decision 16; TX-08): every row with whether it is in force
 * today, superseded or from a future date, and a new row added as `pnpm rules:add` adds it
 * (RulesService.add: append-only, the value checked against its key's schema). Rows are never
 * edited. The addition is in the platform company's chain twice: the row trigger, and
 * `rule.added` with the platform admin as its actor.
 */
@Injectable()
export class RulesConsoleService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private today(): string {
    return toIsoDate(businessDateOf(instantFrom(this.clock.now()), DEFAULT_TIME_ZONE));
  }

  /** Every row for a country (one key, if given): by key, then newest first. */
  async history(
    actor: Actor | null,
    input: { readonly country: string; readonly key?: string | null },
  ): Promise<RuleRowView[]> {
    const admin = platformAdminFor(this.policy, actor, 'rules.view');
    const rows = await withSystem(this.database, platformSystemContext(admin), (tx) =>
      tx
        .select()
        .from(schema.rule)
        .where(
          and(
            eq(schema.rule.country, input.country),
            input.key ? eq(schema.rule.key, input.key) : undefined,
          ),
        ),
    );
    return this.views(rows);
  }

  async add(actor: Actor | null, input: NewRuleInput): Promise<RuleRowView> {
    const admin = platformAdminFor(this.policy, actor, 'rules.add');
    const from = dateOf(input.effectiveFrom, 'The start date');
    const to = input.effectiveTo ? dateOf(input.effectiveTo, 'The end date') : null;
    if (to && compareDates(parseBusinessDate(to), parseBusinessDate(from)) < 0)
      throw invalid('bad_date', 'The end date comes on or after the start date');
    const platformId = await platformCompanyId(this.database);
    const name = await withSystem(this.database, platformSystemContext(admin), async (tx) => {
      const found = await tx.execute<{ name: string }>(
        sql`select name from person where id = ${admin.personId}::uuid`,
      );
      return found.rows[0]?.name ?? 'Platform admin';
    });
    let id: string;
    try {
      id = await this.rules.add(
        {
          country: input.country,
          key: input.key,
          value: input.value,
          effectiveFrom: from,
          effectiveTo: to,
          source: input.source,
          verificationStatus: input.verificationStatus,
          verifiedBy: input.verifiedBy ?? null,
          notes: input.notes ?? null,
          createdBy: name,
        },
        platformId,
      );
    } catch (error) {
      if (error instanceof DomainError) throw ruleError(error);
      throw error;
    }
    await withCompany(
      this.database,
      { companyId: platformId, personId: admin.personId, actorKind: 'platform_admin' },
      (tx) =>
        this.audit.append(tx, {
          companyId: platformId,
          action: 'rule.added',
          recordType: 'rule',
          recordId: id,
          data: {
            country: input.country,
            key: input.key,
            effectiveFrom: from,
            verificationStatus: input.verificationStatus,
          },
        }),
    );
    const rows = await withSystem(this.database, platformSystemContext(admin), (tx) =>
      tx
        .select()
        .from(schema.rule)
        .where(and(eq(schema.rule.country, input.country), eq(schema.rule.key, input.key))),
    );
    return this.views(rows).find((r) => r.id === id)!;
  }

  private views(rows: readonly Row[]): RuleRowView[] {
    const today = parseBusinessDate(this.today());
    const byKey = new Map<string, Row[]>();
    for (const row of rows) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);
    const out: RuleRowView[] = [];
    for (const key of [...byKey.keys()].sort()) {
      const group = byKey.get(key)!;
      const inForce = resolveAsOf(
        group.map((r) => ({
          id: r.id,
          country: r.country,
          key: r.key,
          value: r.value,
          effectiveFrom: parseBusinessDate(r.effectiveFrom),
          effectiveTo: r.effectiveTo ? parseBusinessDate(r.effectiveTo) : null,
          source: r.source,
          verificationStatus: r.verificationStatus as VerificationStatus,
          createdAt: r.createdAt,
        })),
        today,
      );
      const newest = [...group].sort(
        (a, b) =>
          b.effectiveFrom.localeCompare(a.effectiveFrom) ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
      for (const r of newest) {
        const status = r.verificationStatus as VerificationStatus;
        out.push({
          id: r.id,
          country: r.country,
          key: r.key,
          value: r.value,
          effectiveFrom: r.effectiveFrom,
          effectiveTo: r.effectiveTo,
          source: r.source,
          verificationStatus: status,
          warning: needsWarning({ verificationStatus: status }),
          verifiedBy: r.verifiedBy,
          notes: r.notes,
          createdBy: r.createdBy,
          createdAt: r.createdAt,
          state:
            r.id === inForce?.id
              ? 'in_force'
              : compareDates(parseBusinessDate(r.effectiveFrom), today) > 0
                ? 'future'
                : 'superseded',
        });
      }
    }
    return out;
  }
}
