import { Alert } from '@/components/ui/alert';
import { warningTitle, type NoticeWarning } from '@/lib/notices';

/**
 * Every warning on a notice, each in its own box (plan 4.10; CLAUDE.md section 7): an unverified
 * rule names its key, so staff know which legal value is still to be confirmed by counsel.
 */
export function NoticeWarnings({ warnings }: { readonly warnings: readonly NoticeWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="notice-warnings">
      {warnings.map((warning, index) => (
        <Alert key={`${warning.code}-${index}`} tone="warning" title={warningTitle(warning)}>
          <span data-testid="notice-warning" data-code={warning.code}>
            {warning.message}
            {warning.ruleKey ? (
              <>
                {' '}
                Rule: <code className="font-mono text-xs">{warning.ruleKey}</code>.
              </>
            ) : null}
          </span>
        </Alert>
      ))}
    </div>
  );
}
