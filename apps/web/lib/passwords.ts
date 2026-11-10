/** Better Auth's password limits on the API (M1 plan 4.5): 12 to 128 characters. */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** Why a new password can't be used yet, before it is sent; the API checks again. */
export function newPasswordProblem(input: {
  readonly current?: string;
  readonly next: string;
  readonly confirm: string;
}): string | null {
  if (input.current !== undefined && input.current.length === 0)
    return 'Enter your current password.';
  if (input.next.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (input.next.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (input.next !== input.confirm) return 'The two passwords are not the same.';
  if (input.current !== undefined && input.next === input.current)
    return 'Choose a password different from the current one.';
  return null;
}

/** How long each emailed link lasts (M11 security review): an invitation 3 days, a reset 1 hour. */
export const LINK_LIFETIMES_TEXT =
  'An invitation link lasts 3 days, and a password reset link 1 hour.';
