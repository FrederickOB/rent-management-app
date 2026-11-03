import { ruleName, verificationLabel, warns, type RuleUsed } from '@/lib/tax-rules';

/**
 * The rules a tax figure was worked out with, each with its verification status as the API sends
 * it (CLAUDE.md section 7): `the residential rent tax rate (rent_tax.rate.residential): Taken
 * from the PRD, not yet confirmed by a tax adviser`. A rule that warns is marked.
 */
export function RuleList({
  rules,
  label = 'Rules used',
}: {
  readonly rules: readonly RuleUsed[];
  readonly label?: string;
}) {
  const seen = new Map<string, RuleUsed>();
  for (const rule of rules) if (!seen.has(rule.key)) seen.set(rule.key, rule);
  const list = [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
  if (list.length === 0) return null;
  return (
    <div className="space-y-1 text-xs text-slate-700" data-testid="rule-list">
      <p className="font-medium text-slate-800">{label}</p>
      <ul className="space-y-0.5">
        {list.map((rule) => (
          <li key={rule.key} data-testid="rule-used" data-rule-key={rule.key}>
            {ruleName(rule.key) === rule.key ? rule.key : `${ruleName(rule.key)} (${rule.key})`}:{' '}
            <span className={warns(rule) ? 'font-medium text-amber-900' : undefined}>
              {verificationLabel(rule)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
