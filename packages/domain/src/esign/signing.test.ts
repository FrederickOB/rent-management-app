import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { defaultCompanySettings, signingReminderHoursOf } from '../settings';
import { reminderToSend } from '../tenancy';
import {
  checkSignature,
  CURRENT_CONSENT,
  DEFAULT_SIGNING_REMINDER_HOURS,
  dueSigningReminders,
  maskEmail,
  SIGNING_CONSENT,
  SIGNING_LIMITS,
  signingComplete,
  verificationLabel,
} from './signing';

const HOUR = 3_600_000;

describe('TL-07 signing rules', () => {
  it('completes only when every required signer has signed and nobody declined', () => {
    expect(signingComplete([{ required: true, status: 'signed' }])).toBe(true);
    expect(
      signingComplete([
        { required: true, status: 'signed' },
        { required: false, status: 'pending' },
      ]),
    ).toBe(true);
    expect(
      signingComplete([
        { required: true, status: 'signed' },
        { required: true, status: 'pending' },
      ]),
    ).toBe(false);
    expect(
      signingComplete([
        { required: true, status: 'signed' },
        { required: false, status: 'declined' },
      ]),
    ).toBe(false);
    expect(signingComplete([{ required: false, status: 'signed' }])).toBe(false);
    expect(signingComplete([])).toBe(false);
  });

  it('completes exactly when the last required signer signs, in any order (property-based)', () => {
    const signersAndOrder = fc
      .array(fc.boolean(), { minLength: 1, maxLength: 8 })
      .chain((required) =>
        fc.tuple(
          fc.constant(required),
          fc.shuffledSubarray(
            required.map((_, i) => i),
            { minLength: required.length, maxLength: required.length },
          ),
        ),
      );
    fc.assert(
      fc.property(signersAndOrder, ([required, order]) => {
        const state = required.map((r) => ({
          required: r,
          status: 'pending' as 'pending' | 'signed',
        }));
        for (const i of order) {
          state[i]!.status = 'signed';
          const allRequiredSigned = state.every((s) => !s.required || s.status === 'signed');
          if (signingComplete(state) !== (required.some(Boolean) && allRequiredSigned))
            return false;
        }
        return true;
      }),
    );
  });

  it('needs a typed name or a drawing', () => {
    expect(checkSignature({ method: 'typed', typedName: '  Ama Mensah ' })).toEqual({
      method: 'typed',
      typedName: 'Ama Mensah',
    });
    expect(() => checkSignature({ method: 'typed', typedName: 'A' })).toThrow(/full name/);
    expect(() => checkSignature({ method: 'drawn', hasDrawing: false })).toThrow(/Draw/);
    expect(checkSignature({ method: 'drawn', hasDrawing: true })).toEqual({
      method: 'drawn',
      typedName: null,
    });
  });

  it('keeps the consent text by version', () => {
    expect(SIGNING_CONSENT[CURRENT_CONSENT]).toMatch(/agree to sign it electronically/);
  });

  it('limits code sends to 3 per link in 15 minutes, and wider per phone and address', () => {
    expect(SIGNING_LIMITS.codeSendsPerLink).toEqual({ count: 3, windowMinutes: 15 });
    expect(SIGNING_LIMITS.codeSendsPerDestination.count).toBeGreaterThan(3);
    expect(SIGNING_LIMITS.codeSendsPerIp.count).toBeGreaterThan(
      SIGNING_LIMITS.codeSendsPerDestination.count,
    );
  });

  it('names how a signer was verified without the full destination', () => {
    expect(verificationLabel('sms', '+233 ** *** 0021')).toBe(
      'One-time code sent by SMS to +233 ** *** 0021',
    );
    expect(maskEmail('kofi.manager@example.org')).toBe('k***@example.org');
    expect(maskEmail('nobody')).toBe('***');
  });
});

describe('TL-07 signing reminders', () => {
  it('reminds 24 hours, 3 days and 7 days after the links went out by default', () => {
    expect(signingReminderHoursOf(defaultCompanySettings())).toEqual([24, 72, 168]);
    expect(DEFAULT_SIGNING_REMINDER_HOURS).toEqual([24, 72, 168]);
    expect(dueSigningReminders(23 * HOUR, [24, 72, 168])).toEqual([]);
    expect(dueSigningReminders(24 * HOUR, [24, 72, 168]).map((s) => s.key)).toEqual(['after-24h']);
    expect(dueSigningReminders(100 * HOUR, [168, 24, 72]).map((s) => s.key)).toEqual([
      'after-24h',
      'after-72h',
    ]);
  });

  it('sends one reminder after a gap, never a burst', () => {
    const due = dueSigningReminders(200 * HOUR, [24, 72, 168]);
    const { send, skip } = reminderToSend(due, new Set());
    expect(send?.key).toBe('after-168h');
    expect(skip.map((s) => s.key)).toEqual(['after-24h', 'after-72h']);
    expect(reminderToSend(due, new Set(due.map((s) => s.key))).send).toBeNull();
  });
});
