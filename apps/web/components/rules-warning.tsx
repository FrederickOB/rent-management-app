import { rulesWarning, type RuleUsed } from '@/lib/tax-rules';
import { Alert } from './ui/alert';

/**
 * The warning on every tax screen and report (CLAUDE.md section 7; M5 decision 1): the figures
 * were worked out with rules a tax adviser or counsel has not verified yet. Shown wherever such a
 * figure is, with the API's own words when it sends them; nothing when every rule is verified.
 */
export function RulesWarning({
  rules,
  apiWarnings,
  live = true,
}: {
  readonly rules: readonly RuleUsed[];
  readonly apiWarnings?: readonly string[];
  readonly live?: boolean;
}) {
  const warning = rulesWarning(rules, apiWarnings);
  if (!warning) return null;
  return (
    <Alert tone="warning" title={warning.title} live={live}>
      <span data-testid="rules-warning" data-rule-keys={warning.keys.join(' ')}>
        {warning.text}
      </span>
    </Alert>
  );
}
