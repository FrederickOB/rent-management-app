import { z } from 'zod';
import { DomainError } from '../errors';

/**
 * Value schemas for rules-table keys (TX-08, CLAUDE.md section 7). The registry holds shapes
 * only, never values: values live in the `rule` table with their source and verification status.
 */
const bps = z.object({ bps: z.number().int().min(0).max(100_000) }).strict();
const days = z.object({ days: z.number().int().min(0) }).strict();
const dayList = z.object({ days: z.array(z.number().int().min(0)).min(1) }).strict();
const months = z.object({ months: z.number().int().min(0) }).strict();
const years = z.object({ years: z.number().int().min(0) }).strict();

type Entry = { readonly pattern: RegExp; readonly schema: z.ZodType; readonly nullable: boolean };

const entry = (pattern: RegExp, schema: z.ZodType, nullable = false): Entry => ({
  pattern,
  schema,
  nullable,
});

const REGISTRY: readonly Entry[] = [
  entry(/^rent_tax\.rate\.(residential|commercial)$/, bps),
  entry(/^rent_tax\.due_days_after_receipt$/, days),
  entry(/^rent_tax\.alert_days$/, dayList),
  entry(/^rent_tax\.base$/, z.enum(['rent_received_including_advances', 'rent_earned'])),
  entry(/^rent_tax\.rounding$/, z.enum(['half_up_per_receipt'])),
  entry(/^rent_tax\.includes_service_charge$/, z.boolean()),
  entry(/^withholding_tax\.rate\.[a-z_]+$/, bps),
  entry(
    /^vat\.commercial_rent$/,
    z
      .object({
        vatBps: z.number().int().min(0),
        nhilBps: z.number().int().min(0),
        getfundBps: z.number().int().min(0),
      })
      .strict(),
  ),
  // M4a decision 4: VAT and levies on service charge as well as rent (unverified; OQ-20).
  entry(/^vat\.applies_to_service_charge$/, z.boolean()),
  // M9 (P33): days after the end of the month the VAT was charged in that its return is due to
  // GRA. No value until the tax adviser supplies one (OQ-61).
  entry(/^vat\.return_due_days$/, days, true),
  entry(/^advance_rent\.max_months\.[a-z_]+$/, months),
  entry(/^rent_control\.registration_days$/, days),
  // M3 trackers (plan 4.11): stamping within months of signing (OQ-45), and the term above which
  // a lease takes the formal path (OQ-44).
  entry(/^stamp_duty\.deadline_months$/, months),
  entry(/^lease\.writing_exemption_max_years$/, years),
  entry(/^notice_to_quit\.statutory_min_days\.[a-z_]+$/, days, true),
  // M7 decision 3: no notice to quit within this many months of a Rent Officer assessment
  // (Act 220 s.23; the row is `unverified` until counsel confirms).
  entry(/^notice_to_quit\.assessment_bar_months$/, months),
  entry(/^data_retention\.financial_and_notices$/, years, true),
  entry(/^data_retention\.other\.[a-z_]+$/, years, true),
];

export const RULE_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

function find(key: string): Entry {
  const match = REGISTRY.find((e) => e.pattern.test(key));
  if (!match)
    throw new DomainError('rule.unknown_key', `No schema is registered for rule key ${key}`);
  return match;
}

export const isKnownRuleKey = (key: string): boolean => REGISTRY.some((e) => e.pattern.test(key));

/** Validates a rule value against its key's schema. `null` means "not yet known" where allowed. */
export function parseRuleValue(key: string, value: unknown): unknown {
  const { schema, nullable } = find(key);
  if (value === null) {
    if (nullable) return null;
    throw new DomainError('rule.null_value', `Rule ${key} needs a value`);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DomainError(
      'rule.bad_value',
      `Invalid value for rule ${key}: ${result.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return result.data;
}
