import { describe, expect, it } from 'vitest';
import { selfDecisionState, treatmentText, type SelfConfirmation } from './withholding';

describe('TX-04 the withholding says how its rent tax was treated, which the certificate follows', () => {
  it('says each treatment plainly, and nothing when the API did not say', () => {
    expect(treatmentText('accrued')).toContain('the certificate settles it');
    expect(treatmentText('letting_business')).toContain('tax credit');
    expect(treatmentText('not_assessed')).toContain('a rules row was missing');
    expect(treatmentText(null)).toBeNull();
    expect(treatmentText(undefined)).toBeNull();
  });
});

describe('TX-04 decision 7 and review 4 a sole uploader asks again to confirm or withdraw, then decides with a code', () => {
  const me = 'akua';
  const request = (
    status: SelfConfirmation['status'],
    until = '2026-11-04T10:00:00.000Z',
  ): SelfConfirmation => ({
    approvalId: `appr-${status}`,
    status,
    coolingOffUntil: until,
  });
  const before = new Date('2026-11-04T09:00:00Z');
  const after = new Date('2026-11-04T11:00:00Z');

  it('offers asking again once the last request lapsed, when the API allows it', () => {
    expect(
      selfDecisionState(
        { uploadedBy: me, selfConfirmation: request('expired'), mayRequestSelfDecision: true },
        me,
        after,
      ),
    ).toEqual({ kind: 'lapsed', decision: 'confirm', status: 'expired', mayRequest: true });
    expect(
      selfDecisionState({ uploadedBy: me, selfConfirmation: request('expired') }, me, after),
    ).toMatchObject({ kind: 'lapsed', mayRequest: false });
  });

  it('follows a fresh request to withdraw it through its cooling-off', () => {
    const certificate = {
      uploadedBy: me,
      selfConfirmation: request('expired'),
      selfWithdrawal: request('cooling_off'),
    };
    expect(selfDecisionState(certificate, me, before)).toEqual({
      kind: 'waiting',
      decision: 'withdraw',
      approvalId: 'appr-cooling_off',
      until: '2026-11-04T10:00:00.000Z',
    });
    expect(selfDecisionState(certificate, me, after)).toEqual({
      kind: 'ready',
      decision: 'withdraw',
      approvalId: 'appr-cooling_off',
    });
  });

  it('decides nothing for anyone but the uploader, or once a request was approved', () => {
    expect(
      selfDecisionState({ uploadedBy: me, selfConfirmation: request('cooling_off') }, 'x', after),
    ).toEqual({
      kind: 'none',
    });
    expect(
      selfDecisionState({ uploadedBy: me, selfConfirmation: request('approved') }, me, after),
    ).toEqual({
      kind: 'none',
    });
    expect(selfDecisionState({ uploadedBy: me }, me, after)).toEqual({ kind: 'none' });
  });
});
