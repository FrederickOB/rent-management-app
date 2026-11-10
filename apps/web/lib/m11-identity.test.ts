import { CONSENT_SOURCES } from '@rent/domain/messaging';
import { describe, expect, it } from 'vitest';
import {
  recoveryMessage,
  recoveryReasonProblem,
  recoveryResultText,
  RECOVERY_REASON_MAX,
} from './account-recovery';
import { authProblem, passwordSignInProblem, SIGN_IN_LOCKED_TEXT, stepUpMessage } from './errors';
import { invitationMessage, INVITATION_MESSAGES } from './invitations';
import { AWAITING_APPROVAL_TEXT, membershipSavedText } from './membership-approval';
import { CONSENT_SOURCE_LABELS } from './messaging-consent';
import { LINK_LIFETIMES_TEXT, newPasswordProblem } from './passwords';

// M11 security review (identity): passwords, step-up codes, invitations, approver changes and
// account recovery, in words.

describe('NFR-SEC passwords: breached ones refused, limits checked, sign-in lock-out worded', () => {
  it('says a breached password must be changed', () => {
    expect(authProblem({ status: 400, code: 'PASSWORD_COMPROMISED', message: 'x' }).message).toBe(
      'This password has appeared in a data breach; choose another.',
    );
  });

  it('checks a new password before it is sent', () => {
    const ok = 'a long enough passphrase';
    expect(newPasswordProblem({ current: 'old one', next: ok, confirm: ok })).toBeNull();
    expect(newPasswordProblem({ current: '', next: ok, confirm: ok })).toBe(
      'Enter your current password.',
    );
    expect(newPasswordProblem({ next: 'short', confirm: 'short' })).toBe(
      'Use at least 12 characters.',
    );
    expect(newPasswordProblem({ next: 'x'.repeat(129), confirm: 'x'.repeat(129) })).toBe(
      'Use at most 128 characters.',
    );
    expect(newPasswordProblem({ next: ok, confirm: `${ok}!` })).toBe(
      'The two passwords are not the same.',
    );
    expect(newPasswordProblem({ current: ok, next: ok, confirm: ok })).toMatch(/different/);
    expect(LINK_LIFETIMES_TEXT).toBe(
      'An invitation link lasts 3 days, and a password reset link 1 hour.',
    );
  });

  it('words the 15-minute lock-out on password sign-in, and leaves phone codes as they were', () => {
    expect(
      passwordSignInProblem({ status: 429, code: 'TOO_MANY_ATTEMPTS', message: 'x' }).message,
    ).toBe(SIGN_IN_LOCKED_TEXT);
    expect(SIGN_IN_LOCKED_TEXT).toBe('Too many attempts; try again in 15 minutes.');
    expect(authProblem({ status: 429, code: 'TOO_MANY_ATTEMPTS', message: 'x' }).message).toBe(
      'Too many wrong codes. Ask for a new code.',
    );
    expect(passwordSignInProblem({ status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' }).message).toBe(
      'That email address and password do not match.',
    );
  });

  it('asks for the authenticator code with the password, and says when to wait', () => {
    expect(authProblem({ status: 400, code: 'TOTP_REQUIRED' }).message).toMatch(/6-digit code/);
    expect(authProblem({ status: 429, code: 'STEP_UP_LOCKED' }).message).toMatch(
      /Wait for the next code/,
    );
    expect(stepUpMessage({ status: 429, data: { body: { code: 'step_up_locked' } } })).toMatch(
      /Too many tries/,
    );
    expect(stepUpMessage({ status: 400, data: { body: { code: 'step_up_failed' } } })).toMatch(
      /not right/,
    );
    expect(stepUpMessage({ status: 400, code: 'OTHER' })).toBeNull();
  });
});

describe('AD-03 invitations wait for the person, and approver changes for a second person', () => {
  it('words every invitation refusal', () => {
    for (const code of [
      'sign_in_method',
      'invitation_awaiting_approval',
      'invitation_refused',
      'not_found',
    ])
      expect(invitationMessage({ status: 409, data: { body: { code } } }), code).toBe(
        INVITATION_MESSAGES[code.toUpperCase()],
      );
    expect(INVITATION_MESSAGES.SIGN_IN_METHOD).toMatch(/signed in by phone/);
  });

  it('says an invite or a change waits for a second person, and links Approvals', () => {
    expect(
      membershipSavedText({ name: 'Kofi', approvalRequestId: 'r', kind: 'invite_email' }),
    ).toEqual({
      text: 'Kofi’s invitation waits for a second person’s approval; it is sent once approved.',
      approvals: true,
    });
    expect(membershipSavedText({ name: 'Kofi', approvalRequestId: 'r', kind: 'change' }).text).toBe(
      'Kofi’s change waits for a second person’s approval before it takes effect.',
    );
    expect(membershipSavedText({ name: 'Kofi', kind: 'change' })).toEqual({
      text: 'Saved the changes for Kofi.',
      approvals: false,
    });
    expect(membershipSavedText({ name: 'Kofi', kind: 'invite_phone' }).text).toBe(
      'Kofi is added and signs in with a code sent to their phone.',
    );
    expect(AWAITING_APPROVAL_TEXT).toBe('Waiting for a second person’s approval');
  });
});

describe('NFR-SEC account recovery needs a reason with the identity check', () => {
  it('takes 10 to 500 characters', () => {
    expect(recoveryReasonProblem('too short')).toMatch(/at least 10/);
    expect(recoveryReasonProblem('Checked by video call against her Ghana Card name')).toBeNull();
    expect(recoveryReasonProblem('x'.repeat(RECOVERY_REASON_MAX + 1))).toMatch(/under 500/);
  });

  it('says what was done', () => {
    expect(recoveryResultText('Ama', { sessionsRevoked: 2, twoFactorReset: true })).toBe(
      'Ama’s two-factor is reset and 2 sessions ended. They set up a new authenticator the next time they sign in.',
    );
    expect(recoveryResultText('Ama', { sessionsRevoked: 1, twoFactorReset: false })).toBe(
      'Ama is signed out everywhere: 1 session ended.',
    );
    expect(recoveryMessage({ status: 400, code: 'reason_required' })).toMatch(/identity check/);
  });
});

describe('CM-09 every consent source has words', () => {
  it('labels each source the domain lists', () => {
    for (const source of CONSENT_SOURCES)
      expect(CONSENT_SOURCE_LABELS[source], source).toBeTruthy();
    expect(CONSENT_SOURCE_LABELS.data_protection).toBe('stopped for a data protection request');
  });
});
