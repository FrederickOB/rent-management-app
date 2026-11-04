import { needsWarning } from '@rent/domain/rules';

// The warning on every tax screen and report (CLAUDE.md section 7; M5 decision 1). Rates, bases,
// due days, alert days and the advance rent limit come from the rules table; a figure worked out
// with a rule nobody has verified says so wherever it is shown. The API names the rules each
// figure used; this file only says it, and never calls a value verified that is not.

export type VerificationStatus = 'verified' | 'from_prd' | 'unverified';

/** A rule a figure was worked out with, as the API sends it (`ruleUsedSchema` and its kin). */
export interface RuleUsed {
  readonly key: string;
  readonly verificationStatus: VerificationStatus;
  /** The API's own flag (`ruleSchema.warning`); a rule not yet verified always warns as well. */
  readonly warning?: boolean;
  /** The day the rule version took effect, when the API sends it. */
  readonly effectiveFrom?: string;
}

/** Who confirms a rule: a tax adviser for tax, counsel for the law (CLAUDE.md section 7). */
export type Confirmer = 'tax adviser' | 'counsel';

const COUNSEL_KEYS =
  /^(advance_rent|notice_to_quit|rent_control|data_retention|stamp_duty|lease)\./;

export const confirmerOf = (key: string): Confirmer =>
  COUNSEL_KEYS.test(key) ? 'counsel' : 'tax adviser';

/** What a rule decides, in words, for the warning; the key stays beside it for tracing. */
const RULE_NAMES: readonly (readonly [RegExp, string])[] = [
  [/^rent_tax\.rate\.residential$/, 'the residential rent tax rate'],
  [/^rent_tax\.rate\.commercial$/, 'the commercial rent tax rate'],
  [/^rent_tax\.due_days_after_receipt$/, 'when rent tax is due'],
  [/^rent_tax\.alert_days$/, 'when rent tax alerts are raised'],
  [/^rent_tax\.base$/, 'what rent tax is charged on'],
  [/^rent_tax\.rounding$/, 'how rent tax is rounded'],
  [/^rent_tax\.includes_service_charge$/, 'whether service charge is taxed as rent'],
  [/^withholding_tax\.rate\./, 'the withholding tax rate'],
  [/^vat\.commercial_rent$/, 'the VAT, NHIL and GETFund rates'],
  [/^vat\.applies_to_service_charge$/, 'whether VAT applies to service charge'],
  [/^advance_rent\.max_months\./, 'the advance rent limit'],
];

export function ruleName(key: string): string {
  return RULE_NAMES.find(([pattern]) => pattern.test(key))?.[1] ?? key;
}

/** Whether staff must be warned about this rule: the API says so, or it is not verified. */
export const warns = (rule: RuleUsed): boolean => rule.warning === true || needsWarning(rule);

/** A rule's status in words, for a report's rule column. Never "compliant" or "approved". */
export function verificationLabel(rule: RuleUsed): string {
  switch (rule.verificationStatus) {
    case 'verified':
      return 'Verified';
    case 'from_prd':
      return `Taken from the PRD, not yet confirmed by ${a(confirmerOf(rule.key))}`;
    default:
      return `Unverified: ${a(confirmerOf(rule.key))} to confirm`;
  }
}

const a = (who: Confirmer): string => (who === 'counsel' ? 'counsel' : 'a tax adviser');

export interface RulesWarning {
  readonly title: string;
  readonly text: string;
  /** The rule keys the warning is about, sorted, for tracing a figure to its rule. */
  readonly keys: readonly string[];
}

/**
 * The warning a screen shows for the rules its figures used, or null when every one is verified.
 * The API's own warning words, when it sends them, are shown as they are; otherwise the warning
 * names each rule, says who must confirm it, and asks staff to check before relying on it.
 */
export function rulesWarning(
  rules: readonly RuleUsed[],
  apiWarnings: readonly string[] = [],
): RulesWarning | null {
  const flagged = new Map<string, RuleUsed>();
  for (const rule of rules) if (warns(rule)) flagged.set(rule.key, rule);
  const keys = [...flagged.keys()].sort();
  const own = apiWarnings.map((w) => w.trim()).filter(Boolean);
  if (keys.length === 0 && own.length === 0) return null;
  const title = 'Worked out with rules not yet verified';
  if (own.length) return { title, text: own.join(' '), keys };
  const confirmers = [...new Set(keys.map(confirmerOf))].sort();
  const named = keys.map((key) => `${ruleName(key)} (${key})`);
  const who = confirmers.map(a).join(' and ');
  return {
    title,
    text: `These figures use ${list(named)}, which ${who} ${confirmers.length > 1 ? 'have' : 'has'} not yet verified. Check them before relying on them; a confirmed value is added as a new rule and never changes figures already worked out.`,
    keys,
  };
}

/** `a, b and c`. */
export function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
