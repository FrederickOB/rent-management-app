import { LADDER_ESCALATION_REQUIRED_MESSAGE } from '@rent/domain/notices';
import { describe, expect, it } from 'vitest';
import { noticeSettingsDraftOf, noticeSettingsPatch } from './notice-settings';
import { UploadCache } from './notice-uploads';
import {
  approveQuitText,
  composeInputOf,
  issuePlanLines,
  noticeApprovalOutcome,
  RECIPIENT_KIND_LABELS,
  returnedCallout,
  tooEarly,
} from './notices';
import { assessmentBarState, assessmentReasonProblem } from './rent-assessments';

// The M7 review round's web fixes (findings WEB 1 to 7; C1 to C5; D-E and D-F).

const AT = '2026-11-04T10:00:00.000Z';

describe('review item 2 and C1 why a draft is a draft again', () => {
  const draft = (
    code: string,
    lastApproval: Parameters<typeof returnedCallout>[0]['lastApproval'] = null,
  ) => ({
    status: 'draft' as const,
    lastApproval,
    returnedReason: { code, message: 'The Rent Officer assessed the unit on 25 Oct 2026.', at: AT },
  });
  const approved = (actionType: 'notice.issue' | 'notice.issue_quit') => ({
    id: 'a1',
    actionType,
    status: 'approved' as const,
    decidedAt: AT,
    decidedByName: 'Akosua Manager (demo)',
  });

  it('says an approved notice to quit was refused at issue, by the second person', () => {
    const callout = returnedCallout(draft('notice.quit_barred', approved('notice.issue_quit')));
    expect(callout).toMatchObject({ tone: 'error', refusedAtIssue: true });
    expect(callout?.title).toBe(
      'Approved by a second person by Akosua Manager (demo), but it could not be issued',
    );
    expect(callout?.text).toContain('The Rent Officer assessed the unit');
  });

  it('fits the wording to a one-person approval', () => {
    expect(
      returnedCallout(draft('notice.effective_date_too_early', approved('notice.issue')))?.title,
    ).toBe('Approved by Akosua Manager (demo), but it could not be issued');
  });

  it('shows rejected, expired, cancelled and taken-back approvals too', () => {
    const rejected = { ...approved('notice.issue_quit'), status: 'rejected' as const };
    expect(returnedCallout(draft('approval.rejected', rejected))?.title).toBe(
      'Rejected by Akosua Manager (demo)',
    );
    expect(returnedCallout(draft('approval.expired'))?.title).toBe('The approval request expired');
    expect(returnedCallout(draft('approval.cancelled'))?.tone).toBe('info');
    expect(returnedCallout(draft('notice.taken_back'))?.refusedAtIssue).toBe(false);
  });

  it('says nothing for a notice that was not returned', () => {
    expect(
      returnedCallout({ status: 'draft', lastApproval: null, returnedReason: null }),
    ).toBeNull();
    expect(returnedCallout({ ...draft('notice.quit_barred'), status: 'sent' as const })).toBeNull();
  });
});

describe('review items 1 and 2 approving a notice', () => {
  const notice = {
    issuedAt: null,
    number: null,
    status: 'pending_approval' as const,
    blockers: [],
    type: 'notice_to_quit' as const,
    tenant: { id: 't1', name: 'Esi Arrears-95 (demo)' },
    unitCode: 'ACC-LEG-B2-02',
    effectiveDate: '2027-02-02',
    property: { id: 'p1', name: 'Legon compound house' },
  };

  it('names the notice to quit in the confirmation', () => {
    const text = approveQuitText(notice);
    expect(text).toContain('Esi Arrears-95 (demo) (ACC-LEG-B2-02), effective 2 Feb 2027');
    expect(text).toContain('It never ends the tenancy by itself.');
  });

  it('reads what approving did from the notice: issued, back in draft, or on its way', () => {
    expect(
      noticeApprovalOutcome({ ...notice, issuedAt: AT, number: 'N-000042', status: 'sent' }),
    ).toBe('Approved. The notice was issued as N-000042 and is on its way.');
    expect(
      noticeApprovalOutcome({
        ...notice,
        status: 'draft',
        returnedReason: { message: 'The unit is inside the s.23 bar.' },
      }),
    ).toBe(
      'Approved, but the notice could not be issued, so it went back to draft: The unit is inside the s.23 bar.',
    );
    expect(noticeApprovalOutcome({ ...notice, status: 'approved' })).toBe(
      'Approved. The notice is being issued: open it to follow its progress.',
    );
  });
});

describe('review items 5 and 7 a draft’s checks on the tracker', () => {
  it('asks the composer’s question for a saved draft', () => {
    const fields = { particulars: 'Loud music', remedyBy: '2026-11-20' };
    expect(
      composeInputOf({
        type: 'breach',
        subtype: 'noise',
        leaseId: 'l1',
        property: { id: 'p1', name: 'x' },
        blockIds: [],
        fields,
      }),
    ).toEqual({ type: 'breach', subtype: 'noise', leaseId: 'l1', fields });
    expect(
      composeInputOf({
        type: 'building_wide',
        subtype: 'fire_safety',
        leaseId: null,
        property: { id: 'p1', name: 'x' },
        blockIds: ['b1'],
        fields: {},
      }),
    ).toEqual({
      type: 'building_wide',
      subtype: 'fire_safety',
      propertyId: 'p1',
      blockIds: ['b1'],
      fields: {},
    });
  });

  it('D-E: holds submit and issue only while the date is too early', () => {
    expect(tooEarly({ effectiveCheck: { ok: false, shortByDays: 3, reason: null } })).toBe(true);
    expect(tooEarly({ effectiveCheck: { ok: true, shortByDays: 0, reason: null } })).toBe(false);
    expect(tooEarly({ effectiveCheck: null })).toBe(false);
    expect(tooEarly(null)).toBe(false);
  });

  it('lists the channels and the physical service before issuing', () => {
    expect(
      issuePlanLines([
        {
          name: 'Ama Tenant',
          channels: [
            { channel: 'whatsapp', mode: 'service', reason: null },
            { channel: 'sms', mode: 'courtesy', reason: null },
            { channel: 'email', mode: 'withheld', reason: 'no_address' },
          ],
          physicalServicePlanned: false,
        },
        {
          name: 'Kofi Tenant',
          channels: [{ channel: 'sms', mode: 'withheld', reason: 'opted_out' }],
          physicalServicePlanned: true,
        },
      ]),
    ).toEqual([
      'Ama Tenant: by WhatsApp, SMS (courtesy copy); Email withheld.',
      'Kofi Tenant: no electronic copy; SMS withheld; physical service planned.',
    ]);
  });

  it('labels co-tenants (C3)', () => {
    expect(RECIPIENT_KIND_LABELS.co_tenant).toBe('Co-tenant');
  });
});

describe('review item 4 a retry reuses the upload of the same file', () => {
  it('uploads a file once per purpose, and another file again', async () => {
    const cache = new UploadCache();
    let sent = 0;
    const send = async () => `upload-${(sent += 1)}`;
    const photo = new File(['a'], 'a.jpg', { type: 'image/jpeg' });
    expect(await cache.upload(photo, 'service_photo', send)).toBe('upload-1');
    expect(await cache.upload(photo, 'service_photo', send)).toBe('upload-1');
    expect(await cache.upload(photo, 'affidavit', send)).toBe('upload-2');
    expect(await cache.upload(new File(['b'], 'b.jpg'), 'service_photo', send)).toBe('upload-3');
  });

  it('tries again after a failed upload', async () => {
    const cache = new UploadCache();
    const photo = new File(['a'], 'a.jpg');
    await expect(
      cache.upload(photo, 'service_photo', () => Promise.reject(new Error('offline'))),
    ).rejects.toThrow('offline');
    expect(await cache.upload(photo, 'service_photo', async () => 'upload-9')).toBe('upload-9');
  });
});

describe('review item 6 and C4 the unit’s bar', () => {
  const bar = { barredUntil: '2027-03-01', months: 24, ruleStatus: 'unverified' as const };

  it('says barred until a date only while the bar is active', () => {
    expect(assessmentBarState({ ...bar, active: true }, false)).toMatchObject({
      tone: 'warning',
      title: 'Notices to quit are barred',
    });
    expect(assessmentBarState({ ...bar, active: false }, false)).toEqual({
      tone: 'info',
      title: 'The bar has ended',
      text: 'The s.23 bar from the latest assessment ended on 1 Mar 2027.',
    });
    expect(assessmentBarState(null, false)).toBeNull();
  });

  it('warns when no bar rule is in force', () => {
    expect(assessmentBarState(null, true)).toMatchObject({
      tone: 'error',
      title: 'No rule for the assessment bar is in force',
    });
  });

  it('needs a reason to correct or void one', () => {
    expect(assessmentReasonProblem('no')).toBe('Give a reason of at least 3 characters');
    expect(assessmentReasonProblem('Typed the wrong date')).toBeNull();
  });
});

describe('D-F a full-ladder type always escalates', () => {
  const settings = {
    rentReminderOffsetsDays: [-7, 0, 3, 7, 14],
    noticeReminderOffsetsHours: [24, 72, 120, 168],
    renewalReminderDays: [90, 60, 30],
    advanceRentPolicy: 'off' as const,
    approvalExpiryDays: 7,
    approvalCoolingOffHours: 24,
  };

  it('refuses a ladder that drops escalation for a notice to quit, not for a building-wide notice', () => {
    const draft = noticeSettingsDraftOf(settings);
    const dropped = noticeSettingsPatch({
      ...draft,
      ladders: {
        ...draft.ladders,
        notice_to_quit: { ...draft.ladders.notice_to_quit, escalationHours: '' },
      },
    });
    expect('errors' in dropped && dropped.errors.notice_to_quit).toBe(
      LADDER_ESCALATION_REQUIRED_MESSAGE,
    );
    expect('patch' in noticeSettingsPatch(draft)).toBe(true);
  });
});

describe('LN-05 the service form’s default time (e2e: service right after issue)', () => {
  it('defaults to the second, so it is never before a notice issued moments earlier', async () => {
    const { instantOfLocal, localNow } = await import('./notices');
    const now = new Date('2026-11-04T23:33:42.000Z');
    const value = localNow('Africa/Accra', now, 'second');
    expect(value).toBe('2026-11-04T23:33:42');
    expect(instantOfLocal(value, 'Africa/Accra')).toBe('2026-11-04T23:33:42Z');
    // The minute alone would read 23:33:00, before an issue at 23:33:20.
    expect(localNow('Africa/Accra', now)).toBe('2026-11-04T23:33');
  });
});
