import type { ApiClient } from '@rent/contracts/client';
import { formatTime } from './format';

// What happens after a money request is made (M4a decisions 3 and 7). Every money action waits
// for a second person; in a company where nobody else can approve, the person who asked confirms
// it themselves once the cooling-off has passed (OQ-29), with a code from their authenticator.

type Approval = Awaited<ReturnType<ApiClient['payments']['recordTransfer']>>['approval'];

/** The sentence after "Recorded" or "Asked": who must act, and from when. */
export function waitingNote(
  approval: Pick<Approval, 'mode' | 'coolingOffUntil'>,
  timeZone: string,
): string {
  // Said without naming the approvals screen: a caretaker who records cash cannot open it.
  if (approval.mode !== 'single_user')
    return 'A second person must approve it before it takes effect.';
  const after = approval.coolingOffUntil
    ? ` after ${formatTime(approval.coolingOffUntil, timeZone)}`
    : ' once the waiting time has passed';
  return `Nobody else in your company can approve it, so it waits: confirm it yourself in Approvals${after}, with a code from your authenticator app. A nominated second approver removes the wait.`;
}
