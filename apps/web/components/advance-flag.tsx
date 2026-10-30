import type { LeaseDetailView } from '@rent/contracts';
import { Alert } from './ui/alert';

type AdvanceFlag = NonNullable<LeaseDetailView['advanceFlag']>;

/**
 * The advance rent flag (AR-05; plan 4.12), which the API sets only under `advance_rent_policy`
 * `warn`. An unverified rule says so, and an advance is never called compliant. In the draft
 * editor (`saved`), it describes the terms as last saved, since saving checks them again.
 */
export function AdvanceFlagAlert({
  flag,
  saved = false,
}: {
  readonly flag: AdvanceFlag;
  readonly saved?: boolean;
}) {
  const unverified = flag.rule?.warning || flag.rule?.verificationStatus !== 'verified';
  return (
    <Alert tone="warning" title="Advance rent over the limit">
      {saved ? 'The saved terms ask' : 'These terms ask'} for {flag.monthsDemanded} months&rsquo;
      rent in advance; the limit for a lease of this length is {flag.limitMonths} months (Act 220
      s.25(5)). {unverified ? 'This rule is not yet verified by counsel. ' : ''}Your company records
      it and flags it here.
      {saved ? ' Saving the draft checks the terms again.' : ''}
    </Alert>
  );
}
