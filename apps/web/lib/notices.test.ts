import type { Me } from '@rent/contracts';
import { featuresOf } from '@rent/domain/settings';
import { NOTICE_OUTCOME_LABELS } from '@rent/domain/notices';
import { describe, expect, it } from 'vitest';
import { navFor } from '../components/nav';
import { approvalActionLabel, subjectHref } from './approvals';
import { activeNavHref } from './nav-match';
import {
  noticeSettingsDraftOf,
  noticeSettingsPatch,
  acknowledgementProblem,
} from './notice-settings';
import {
  approvedButReturned,
  composerFields,
  draftFingerprint,
  draftOfFields,
  earliestText,
  effectiveProblem,
  eventsByRecipient,
  fieldErrorsOf,
  fieldKind,
  fieldsOfDraft,
  instantOfLocal,
  ladderConfigOf,
  ladderControls,
  ladderSummary,
  linkExpiryProblem,
  localNow,
  noticeOfTimelineEvent,
  noticeRefusal,
  noticeTitle,
  orderedWarnings,
  quitBarText,
  sendWindowProblem,
  timelineNoticeText,
  warningTitle,
  type NoticeEvent,
} from './notices';
import { assessmentBarText, assessmentProblems } from './rent-assessments';
import { taskOverdue } from './tasks';

const ACCRA = 'Africa/Accra';

describe('LN-01 the composer’s fields', () => {
  it('enters each field the right way', () => {
    expect(fieldKind('arrearsMinor')).toBe('money');
    expect(fieldKind('effectiveDate')).toBe('date');
    expect(fieldKind('windowFrom')).toBe('time');
    expect(fieldKind('invoiceIds')).toBe('invoices');
    expect(fieldKind('particulars')).toBe('longText');
    expect(fieldKind('title')).toBe('text');
    expect(fieldKind('propertyId')).toBe('target');
  });

  it('shows the required fields, then the optional details; a building-wide notice its end date', () => {
    expect(
      composerFields({ type: 'notice_to_quit', requiredFields: ['particulars', 'effectiveDate'] }),
    ).toEqual(['particulars', 'effectiveDate', 'details']);
    expect(
      composerFields({
        type: 'building_wide',
        requiredFields: ['propertyId', 'title', 'particulars', 'startDate'],
      }),
    ).toEqual(['title', 'particulars', 'startDate', 'endDate', 'details']);
  });

  it('turns amounts into integer pesewas and back, exactly', () => {
    const draft = draftOfFields({
      arrearsMinor: 150_050,
      arrearsAsOf: '2026-11-04',
      invoiceIds: ['i1', 'i2'],
      details: null,
    });
    expect(draft).toEqual({
      arrearsMinor: '1500.50',
      arrearsAsOf: '2026-11-04',
      invoiceIds: ['i1', 'i2'],
    });
    expect(fieldsOfDraft({ ...draft, arrearsMinor: '1,500.50', payBy: ' ' }).fields).toEqual({
      arrearsMinor: 150_050,
      arrearsAsOf: '2026-11-04',
      invoiceIds: ['i1', 'i2'],
    });
  });

  it('says which amounts it cannot read, and refuses zero', () => {
    expect(fieldsOfDraft({ newRentMinor: '12.345' }).errors).toEqual({
      newRentMinor: 'Enter an amount such as 1500 or 1,500.50',
    });
    expect(fieldsOfDraft({ newRentMinor: '0' }).errors).toEqual({
      newRentMinor: 'Enter an amount above zero',
    });
  });

  it('puts a building-wide notice’s property and blocks in its fields', () => {
    expect(
      fieldsOfDraft(
        { title: 'Fire drill' },
        { propertyId: 'p1', blockIds: ['b1'] },
        'building_wide',
      ).fields,
    ).toEqual({ title: 'Fire drill', propertyId: 'p1', blockIds: ['b1'] });
    expect(fieldsOfDraft({ title: 'x' }, { propertyId: 'p1' }, 'breach').fields).toEqual({
      title: 'x',
    });
  });

  it('gives a changed draft a new idempotency key, and the same draft the same', () => {
    const base = {
      type: 'breach',
      subtype: 'noise',
      leaseId: 'l1',
      propertyId: null,
      blockIds: [],
      fields: { particulars: 'Loud music', remedyBy: '2026-11-20' },
    };
    const key = draftFingerprint(base);
    expect(
      draftFingerprint({ ...base, fields: { remedyBy: '2026-11-20', particulars: 'Loud music' } }),
    ).toBe(key);
    expect(
      draftFingerprint({ ...base, fields: { ...base.fields, remedyBy: '2026-11-21' } }),
    ).not.toBe(key);
    expect(draftFingerprint({ ...base, subtype: 'damage' })).not.toBe(key);
  });

  it('shows the API’s first problem for each field', () => {
    expect(
      fieldErrorsOf([
        { field: 'effectiveDate', message: 'Too early' },
        { field: 'effectiveDate', message: 'Second' },
        { field: 'particulars', message: 'Required' },
      ]),
    ).toEqual({ effectiveDate: 'Too early', particulars: 'Required' });
  });
});

describe('LN-01 and plan 4.3 the earliest lawful date and the warnings', () => {
  it('says how the earliest date was reached', () => {
    expect(
      earliestText({
        earliestDate: '2026-12-04',
        serviceDate: '2026-11-04',
        serviceDateBasis: 'electronic_issue',
        periodDays: 30,
        periodSource: 'contractual',
        contractualDays: 30,
        statutoryDays: null,
        leaseEndApplied: false,
      }),
    ).toBe(
      '4 Dec 2026: 30 days (the lease’s notice period) from the issue date, served electronically under the lease’s clause (4 Nov 2026).',
    );
  });

  it('refuses a date before the earliest, in words', () => {
    expect(effectiveProblem({ ok: false, shortByDays: 3, reason: null })).toBe(
      'The date is 3 days earlier than the earliest lawful date.',
    );
    expect(effectiveProblem({ ok: true, shortByDays: 0, reason: null })).toBeNull();
    expect(effectiveProblem(null)).toBeNull();
  });

  it('puts the unverified legal rules first, and names every warning', () => {
    const codes = orderedWarnings([
      { code: 'counsel_wording_outstanding' as const },
      { code: 'no_electronic_service_clause' as const },
      { code: 'statutory_minimum_unverified' as const },
    ]).map((w) => w.code);
    expect(codes).toEqual([
      'statutory_minimum_unverified',
      'no_electronic_service_clause',
      'counsel_wording_outstanding',
    ]);
    expect(warningTitle({ code: 'assessment_bar_unverified' })).toContain('not verified');
  });

  it('states the s.23 bar with its dates', () => {
    expect(
      quitBarText({ barred: true, barredUntil: '2027-03-01', latestAssessment: '2025-03-02' }),
    ).toContain('until after 1 Mar 2027 (Act 220 s.23)');
    expect(quitBarText({ barred: false, barredUntil: null, latestAssessment: null })).toBeNull();
  });
});

describe('LN-03 and LN-09 the tracker and the dashboard', () => {
  const event = (id: string, at: string, recipientId: string | null): NoticeEvent => ({
    id,
    kind: 'sent',
    recipientId,
    channel: null,
    at,
    actorName: null,
    data: null,
  });

  it('groups events by recipient, oldest first, with the notice-wide ones apart', () => {
    const groups = eventsByRecipient([
      event('b', '2026-11-04T10:05:00.000Z', 'r1'),
      event('a', '2026-11-04T10:00:00.000Z', 'r1'),
      event('c', '2026-11-04T10:01:00.000Z', null),
    ]);
    expect(groups.get('r1')?.map((e) => e.id)).toEqual(['a', 'b']);
    expect(groups.get(null)?.map((e) => e.id)).toEqual(['c']);
  });

  it('titles a notice by its number, or its status before it has one', () => {
    expect(noticeTitle({ number: 'N-000007', type: 'notice_to_quit', status: 'sent' })).toBe(
      'N-000007 · Notice to quit',
    );
    expect(noticeTitle({ number: null, type: 'breach', status: 'draft' })).toBe(
      'Draft · Breach of tenancy notice',
    );
  });

  it('flags a notice to quit approved but returned to draft at issue', () => {
    const approval = { status: 'approved' } as never;
    expect(approvedButReturned({ status: 'draft', approval, blockers: [] })).toBe(true);
    expect(approvedButReturned({ status: 'sent', approval, blockers: [] })).toBe(false);
    expect(approvedButReturned({ status: 'draft', approval: null, blockers: [] })).toBe(false);
  });

  it('reads the named refusals', () => {
    expect(noticeRefusal({ status: 403, code: 'NOT_ON_PLAN' })).toBe('not_on_plan');
    expect(noticeRefusal({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' })).toBe('key_reused');
    expect(noticeRefusal({ status: 409, code: 'NOTICE.QUIT_NOT_ENABLED' })).toBe('quit_disabled');
    expect(noticeRefusal({ status: 409, code: 'NOTICE_FROZEN' })).toBe('not_editable');
    expect(noticeRefusal({ status: 409, code: 'NOTICE.EFFECTIVE_DATE_TOO_EARLY' })).toBe('blocked');
  });

  it('puts each status change on the tenant timeline with the notice’s number', () => {
    const found = noticeOfTimelineEvent(
      {
        action: 'notice.closed',
        data: {
          noticeId: 'n1',
          number: 'N-000012',
          type: 'rent_demand',
          typeLabel: 'Rent demand and arrears notice',
          status: 'closed',
          outcome: 'paid',
        },
      },
      NOTICE_OUTCOME_LABELS,
    );
    expect(found).toMatchObject({ noticeId: 'n1', number: 'N-000012', kind: 'closed' });
    expect(timelineNoticeText(found!)).toBe(
      'Notice N-000012 (Rent demand and arrears notice): Closed: Paid',
    );
    const hidden = noticeOfTimelineEvent({ action: 'notice.escalated', data: null }, {});
    expect(timelineNoticeText(hidden!)).toBe('A notice: Escalated to physical service');
    expect(noticeOfTimelineEvent({ action: 'tenant.update', data: null }, {})).toBeNull();
    expect(noticeOfTimelineEvent({ action: 'notice.ladder_paused', data: null }, {})).toBeNull();
  });
});

describe('LN-05 the ladder', () => {
  it('reads a ladder as typed, and refuses one out of order', () => {
    expect(
      ladderConfigOf({ reminderHours: '72, 24', inPersonHours: '120', escalationHours: '168' }),
    ).toEqual({ config: { reminderHours: [24, 72], inPersonHours: 120, escalationHours: 168 } });
    expect(ladderConfigOf({ reminderHours: '24', inPersonHours: '', escalationHours: '' })).toEqual(
      {
        config: { reminderHours: [24], inPersonHours: null, escalationHours: null },
      },
    );
    expect(
      ladderConfigOf({ reminderHours: '200', inPersonHours: '', escalationHours: '168' }),
    ).toEqual({
      error: 'Every reminder comes before escalation',
    });
    expect(ladderConfigOf({ reminderHours: 'x', inPersonHours: '', escalationHours: '' })).toEqual({
      error: 'Reminder hours are whole numbers from 1 to 1440',
    });
    expect(
      ladderSummary({ reminderHours: [24, 72], inPersonHours: 120, escalationHours: 168 }),
    ).toBe('Reminders at 1 day, 3 days · in person at 5 days · escalation at 7 days');
  });

  it('offers only the controls that make sense', () => {
    expect(ladderControls({ paused: false, cancelled: false })).toEqual(['pause', 'cancel']);
    expect(ladderControls({ paused: true, cancelled: false })).toEqual(['resume', 'cancel']);
    expect(ladderControls({ paused: false, cancelled: true })).toEqual([]);
  });

  it('checks the sending window and the link expiry', () => {
    expect(sendWindowProblem('07:00', '20:00')).toBeNull();
    expect(sendWindowProblem('20:00', '07:00')).toBe(
      'The window must end after it starts, on the same day',
    );
    expect(sendWindowProblem('7am', '20:00')).toBe('Use times such as 07:00 and 20:00');
    expect(linkExpiryProblem('90')).toBeNull();
    expect(linkExpiryProblem('29')).not.toBeNull();
  });
});

describe('plan 4.9 notice settings', () => {
  const settings = {
    rentReminderOffsetsDays: [-7, 0, 3, 7, 14],
    noticeReminderOffsetsHours: [24, 72, 120, 168],
    renewalReminderDays: [90, 60, 30],
    advanceRentPolicy: 'off' as const,
    approvalExpiryDays: 7,
    approvalCoolingOffHours: 24,
  };

  it('starts from the settings in force, with the domain’s defaults', () => {
    const draft = noticeSettingsDraftOf(settings);
    expect(draft.from).toBe('07:00');
    expect(draft.to).toBe('20:00');
    expect(draft.linkExpiryDays).toBe('90');
    expect(draft.ladders.notice_to_quit).toEqual({
      reminderHours: '24, 72',
      inPersonHours: '120',
      escalationHours: '168',
    });
    // A building-wide notice has reminders only.
    expect(draft.ladders.building_wide.escalationHours).toBe('');
  });

  it('saves every type’s ladder, the window and the expiry, or says what is wrong', () => {
    const draft = noticeSettingsDraftOf(settings);
    const saved = noticeSettingsPatch(draft);
    expect('patch' in saved && saved.patch.noticeLinkExpiryDays).toBe(90);
    expect('patch' in saved && saved.patch.noticeLadders.entry?.escalationHours).toBeNull();
    const wrong = noticeSettingsPatch({ ...draft, from: '21:00', linkExpiryDays: '5' });
    expect('errors' in wrong && Object.keys(wrong.errors).sort()).toEqual([
      'linkExpiryDays',
      'window',
    ]);
  });

  it('asks the admin to type their name to accept the statement (OQ-16)', () => {
    expect(acknowledgementProblem(' ')).toBe('Type your full name to accept.');
    expect(acknowledgementProblem('Efua Agency-Admin')).toBeNull();
  });
});

describe('decision 3 Rent Officer assessments', () => {
  it('states the bar, warning while its rule is unverified', () => {
    const bar = assessmentBarText({
      barredUntil: '2027-03-01',
      months: 24,
      ruleStatus: 'unverified',
    });
    expect(bar.warn).toBe(true);
    expect(bar.text).toContain('until after 1 Mar 2027: 24 months');
    expect(bar.text).toContain('not yet verified by counsel');
    expect(
      assessmentBarText({ barredUntil: '2027-03-01', months: 24, ruleStatus: 'verified' }).warn,
    ).toBe(false);
  });

  it('needs a date not in the future and a reference', () => {
    expect(
      assessmentProblems({ assessedOn: '2026-11-05', reference: 'RO/1' }, '2026-11-04'),
    ).toEqual({
      assessedOn: 'An assessment cannot be in the future',
    });
    expect(assessmentProblems({ assessedOn: '', reference: ' ' }, '2026-11-04')).toEqual({
      assessedOn: 'Give the date of the assessment',
      reference: 'Give the Rent Officer’s reference',
    });
  });
});

describe('plan 4.7 service times are typed in company time', () => {
  it('turns a local time into the UTC instant, and back for the form', () => {
    expect(instantOfLocal('2026-11-04T09:30', ACCRA)).toBe('2026-11-04T09:30:00Z');
    expect(instantOfLocal('2026-11-04T09:30', 'Europe/London')).toBe('2026-11-04T09:30:00Z');
    expect(instantOfLocal('2026-07-04T09:30', 'Europe/London')).toBe('2026-07-04T08:30:00Z');
    expect(instantOfLocal('not a time', ACCRA)).toBeNull();
    expect(localNow(ACCRA, new Date('2026-11-04T09:30:45.000Z'))).toBe('2026-11-04T09:30');
  });
});

describe('CF-06 tasks', () => {
  it('flags an open task past its due time', () => {
    const now = new Date('2026-11-04T10:00:00.000Z');
    expect(taskOverdue({ status: 'open', dueAt: '2026-11-04T09:00:00.000Z' }, now)).toBe(true);
    expect(taskOverdue({ status: 'done', dueAt: '2026-11-04T09:00:00.000Z' }, now)).toBe(false);
    expect(taskOverdue({ status: 'open', dueAt: '2026-11-04T11:00:00.000Z' }, now)).toBe(false);
  });
});

describe('decision 8 a notice to quit’s approval', () => {
  it('names the request and links it to the notice', () => {
    expect(approvalActionLabel('notice.issue_quit')).toBe('Issue a notice to quit');
    expect(approvalActionLabel('notice.issue')).toBe('Issue a notice');
    expect(
      subjectHref({ subjectType: 'notice', subjectId: '019a3000-0000-7000-8000-0000000000n1' }),
    ).toBe('/notices/019a3000-0000-7000-8000-0000000000n1');
  });
});

function member(
  role: string,
  kind: 'agency' | 'landlord' = 'agency',
  /** A caretaker: a phone session scoped to one property. */
  scoped = false,
): Me {
  const companyId = '019a3000-0000-7000-8000-000000000001';
  return {
    personId: '019a3000-0000-7000-8000-0000000000aa',
    name: 'Someone (demo)',
    state: 'ready',
    authMethod: scoped ? 'phone_otp' : 'password_totp',
    sessionExpiresAt: '2026-11-04T13:00:00.000Z',
    actorKind: 'staff',
    activeCompanyId: companyId,
    role,
    memberships: [
      {
        membershipId: '019a3000-0000-7000-8000-0000000000bb',
        companyId,
        companyName: 'Demo company',
        companyKind: kind,
        role,
        nominatedApprover: false,
        ...(scoped ? { scope: { properties: ['p1'] } } : {}),
      },
    ],
  };
}

const M7 = ['Notices', 'Tasks', 'Notice settings'];
const labels = (me: Me, plan: 'growth' | 'starter' = 'growth') =>
  navFor(me, featuresOf(plan))
    .map((item) => item.label)
    .filter((label) => M7.includes(label));

describe('decision 14 and plan 4.11 notice navigation follows the policy and the plan', () => {
  it('gives a manager notices and tasks, and an admin the settings too', () => {
    expect(labels(member('property_manager'))).toEqual(['Notices', 'Tasks']);
    expect(labels(member('agency_admin'))).toEqual(['Notices', 'Tasks', 'Notice settings']);
  });

  it('gives a caretaker notices and their tasks, and an accountant notices to read', () => {
    expect(labels(member('caretaker', 'agency', true))).toEqual(['Notices', 'Tasks']);
    expect(labels(member('accountant'))).toEqual(['Notices']);
  });

  it('shows a Starter landlord no notices at all', () => {
    expect(labels(member('owner', 'landlord'), 'starter')).toEqual([]);
    expect(labels(member('owner', 'landlord'), 'growth')).toEqual([
      'Notices',
      'Tasks',
      'Notice settings',
    ]);
  });

  it('marks the right section on each notice page', () => {
    const hrefs = navFor(member('agency_admin'), featuresOf('growth')).map((item) => item.href);
    expect(activeNavHref('/notices/new', hrefs)).toBe('/notices');
    expect(activeNavHref('/notices/019a3000-0000-7000-8000-0000000000n1/edit', hrefs)).toBe(
      '/notices',
    );
    expect(activeNavHref('/settings/notices', hrefs)).toBe('/settings/notices');
  });
});
