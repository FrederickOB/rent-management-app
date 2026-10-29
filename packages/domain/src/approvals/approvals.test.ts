import { describe, expect, it } from 'vitest';
import { chooseMode, initialStatus, nextStatus, type ApprovalState } from './approvals';

const t0 = new Date('2026-10-28T10:00:00Z');
const hours = (h: number) => new Date(t0.getTime() + h * 3_600_000);

const twoPerson: ApprovalState = {
  status: 'pending',
  mode: 'two_person',
  coolingOffUntil: null,
  expiresAt: hours(24 * 7),
};
const singleUser: ApprovalState = {
  status: 'cooling_off',
  mode: 'single_user',
  coolingOffUntil: hours(24),
  expiresAt: hours(24 * 7),
};

describe('AD-05 approvals engine (state machine)', () => {
  it('uses single-user mode only when nobody else can approve', () => {
    expect(chooseMode(0)).toBe('single_user');
    expect(chooseMode(1)).toBe('two_person');
    expect(initialStatus('single_user')).toBe('cooling_off');
    expect(initialStatus('two_person')).toBe('pending');
  });

  it('approves once the required approvals are reached', () => {
    expect(
      nextStatus(
        twoPerson,
        { type: 'decision', kind: 'approve', approvalsAfter: 1, required: 1 },
        hours(1),
      ),
    ).toBe('approved');
    expect(
      nextStatus(
        twoPerson,
        { type: 'decision', kind: 'approve', approvalsAfter: 1, required: 2 },
        hours(1),
      ),
    ).toBe('pending');
    expect(
      nextStatus(
        twoPerson,
        { type: 'decision', kind: 'reject', approvalsAfter: 0, required: 1 },
        hours(1),
      ),
    ).toBe('rejected');
  });

  it('refuses decisions on closed or expired requests', () => {
    expect(() =>
      nextStatus(
        { ...twoPerson, status: 'approved' },
        { type: 'cancel', reason: 'withdrawn' },
        hours(1),
      ),
    ).toThrow('already approved');
    expect(() =>
      nextStatus(
        twoPerson,
        { type: 'decision', kind: 'approve', approvalsAfter: 1, required: 1 },
        hours(24 * 7),
      ),
    ).toThrow('expired');
    expect(nextStatus(twoPerson, { type: 'expire' }, hours(24 * 7))).toBe('expired');
    expect(() => nextStatus(twoPerson, { type: 'expire' }, hours(1))).toThrow();
  });

  it('cancels when the subject changed or the initiator withdraws', () => {
    expect(nextStatus(twoPerson, { type: 'cancel', reason: 'subject_changed' }, hours(1))).toBe(
      'cancelled',
    );
    expect(nextStatus(singleUser, { type: 'cancel', reason: 'withdrawn' }, hours(1))).toBe(
      'cancelled',
    );
  });
});

describe('AD-05 single-user cooling-off (state machine)', () => {
  it('allows self-confirmation only after 24 hours', () => {
    expect(() =>
      nextStatus(
        singleUser,
        { type: 'decision', kind: 'self_confirm', approvalsAfter: 0, required: 1 },
        hours(23.9),
      ),
    ).toThrow('cooling-off');
    expect(
      nextStatus(
        singleUser,
        { type: 'decision', kind: 'self_confirm', approvalsAfter: 0, required: 1 },
        hours(24),
      ),
    ).toBe('approved');
  });

  it('never allows self-confirmation in two-person mode', () => {
    expect(() =>
      nextStatus(
        twoPerson,
        { type: 'decision', kind: 'self_confirm', approvalsAfter: 0, required: 1 },
        hours(48),
      ),
    ).toThrow();
  });

  it('does not accept an ordinary approval in single-user mode', () => {
    expect(() =>
      nextStatus(
        singleUser,
        { type: 'decision', kind: 'approve', approvalsAfter: 1, required: 1 },
        hours(48),
      ),
    ).toThrow();
  });
});
