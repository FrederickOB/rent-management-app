/**
 * Founder D1 (M11 security review): adding someone to the people who can approve two-person
 * actions (an invite into an approver role, a promotion, a nomination) waits for a second person.
 * The API answers with `approvalRequestId`; the membership is unchanged, or `invited`, until then.
 * With nobody else to approve, OQ-29's cooling-off applies instead.
 */
export const AWAITING_APPROVAL_TEXT = 'Waiting for a second person’s approval';

/** What to say after an invite, a change, or either one waiting for approval. */
export function membershipSavedText(input: {
  readonly name: string;
  readonly approvalRequestId?: string;
  readonly kind: 'invite_email' | 'invite_phone' | 'change';
}): { readonly text: string; readonly approvals: boolean } {
  if (input.approvalRequestId)
    return {
      text:
        input.kind === 'change'
          ? `${input.name}’s change waits for a second person’s approval before it takes effect.`
          : `${input.name}’s invitation waits for a second person’s approval; it is sent once approved.`,
      approvals: true,
    };
  if (input.kind === 'invite_email')
    return {
      text: `Invitation sent. ${input.name} will get an email with a link to set a password, then sets up two-step sign-in.`,
      approvals: false,
    };
  if (input.kind === 'invite_phone')
    return {
      text: `${input.name} is added and signs in with a code sent to their phone.`,
      approvals: false,
    };
  return { text: `Saved the changes for ${input.name}.`, approvals: false };
}
