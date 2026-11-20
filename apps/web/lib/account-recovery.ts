import { errorCode } from './errors';

/** Account recovery in the console (M11 founder D4): the reason's bounds and the words. */
export const RECOVERY_REASON_MIN = 10;
export const RECOVERY_REASON_MAX = 500;

export const RUNBOOK_PATH = 'docs/runbooks/lost-authenticator.md';

/** The reason goes into the audit chain by value, so it carries no personal data (M11 review). */
export const RECOVERY_REASON_HINT =
  'Say how you checked who they are, with no ID numbers or personal details. It is kept in the audit log.';

export function recoveryReasonProblem(reason: string): string | null {
  const length = reason.trim().length;
  if (length < RECOVERY_REASON_MIN)
    return `Give a reason of at least ${RECOVERY_REASON_MIN} characters, with the identity check you made. It is kept in the audit log.`;
  if (length > RECOVERY_REASON_MAX)
    return `Keep the reason under ${RECOVERY_REASON_MAX} characters.`;
  return null;
}

/** What a recovery did, in words. */
export function recoveryResultText(
  name: string,
  result: { readonly sessionsRevoked: number; readonly twoFactorReset: boolean },
): string {
  const sessions = `${result.sessionsRevoked} ${result.sessionsRevoked === 1 ? 'session' : 'sessions'} ended`;
  return result.twoFactorReset
    ? `${name}’s two-factor is reset and ${sessions}. They set up a new authenticator the next time they sign in.`
    : `${name} is signed out everywhere: ${sessions}.`;
}

export const RECOVERY_MESSAGES: Record<string, string> = {
  REASON_REQUIRED: 'Give a reason, with the identity check you made.',
  NOT_FOUND: 'There is no one with that email address.',
};

export const recoveryMessage = (error: unknown): string | null =>
  RECOVERY_MESSAGES[errorCode(error)] ?? null;
