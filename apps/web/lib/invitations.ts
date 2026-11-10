import { errorCode } from './errors';

/**
 * Invitations waiting for the signed-in person (M11 founder D2): a company's invitation to someone
 * already on the platform waits until they accept it. These are the refusals, in plain words.
 */
export const INVITATION_MESSAGES: Record<string, string> = {
  SIGN_IN_METHOD:
    'This invitation is for a role that signs in a different way. A caretaker’s invitation is accepted signed in by phone; staff accept with their password and authenticator.',
  INVITATION_AWAITING_APPROVAL:
    'This invitation is waiting for a second person in the company to approve it. You can accept it once they have.',
  INVITATION_REFUSED: 'The company turned this invitation down, so it can no longer be accepted.',
  NOT_FOUND: 'This invitation is no longer waiting for you.',
};

export const invitationMessage = (error: unknown): string | null =>
  INVITATION_MESSAGES[errorCode(error)] ?? null;
