import type { Me, MaintenanceJob } from '@rent/contracts';
import { featuresOf } from '@rent/domain/settings';
import { describe, expect, it } from 'vitest';
import { navFor } from '../components/nav';
import { formatTime } from './format';
import {
  assigneeKey,
  assigneeLabel,
  assigneesSeen,
  attachmentsByStage,
  boardQuery,
  completeProblems,
  declaredMediaType,
  DEFAULT_BOARD_FILTERS,
  durationText,
  eventDetail,
  groupByStatus,
  isEmergency,
  isStaleStep,
  MAINTENANCE_FIELD_OF_CODE,
  maintenanceMessage,
  mediaHint,
  mediaProblem,
  needsDuration,
  playerOf,
  responseProblems,
  startProblems,
  targetState,
  targetText,
  triageProblems,
} from './maintenance';
import { REPAIR_STATUS_LABELS } from './repairs';
import { taskRecordLink } from './tasks';

const TZ = 'Africa/Accra';
const P1 = '019a3000-0000-7000-8000-0000000000c1';
const PERSON = '019a3000-0000-7000-8000-0000000000aa';
const ARTISAN = '019a3000-0000-7000-8000-0000000000ab';

type Board = Pick<MaintenanceJob, 'status' | 'priority' | 'emergencyFlag'> & {
  readonly id: string;
};
const job = (id: string, over: Partial<Board> = {}): Board => ({
  id,
  status: 'reported',
  priority: null,
  emergencyFlag: false,
  ...over,
});

describe('MI-01 to MI-06 job statuses come from the domain (M8 fix)', () => {
  it('names every status, so a new one never leaves a badge blank', () => {
    expect(REPAIR_STATUS_LABELS.in_progress).toBe('In progress');
    expect(REPAIR_STATUS_LABELS.work_done).toBe('Work done');
    expect(Object.keys(REPAIR_STATUS_LABELS)).toHaveLength(7);
  });
});

describe('MI-02 and decision 5 emergencies are marked', () => {
  it('treats a staff emergency and an untriaged tenant flag as emergencies', () => {
    expect(isEmergency({ priority: 'emergency', emergencyFlag: false })).toBe(true);
    expect(isEmergency({ priority: null, emergencyFlag: true })).toBe(true);
  });

  it('stops treating a job as an emergency once a manager lowers it', () => {
    expect(isEmergency({ priority: 'routine', emergencyFlag: true })).toBe(false);
    expect(isEmergency({ priority: 'urgent', emergencyFlag: false })).toBe(false);
  });
});

describe('MI-01 to MI-06 the board groups jobs by status', () => {
  it('orders the groups by step, leaves empty ones out and puts emergencies first', () => {
    const groups = groupByStatus([
      job('a', { status: 'triaged', priority: 'routine' }),
      job('b', { status: 'reported' }),
      job('c', { status: 'triaged', priority: 'emergency' }),
      job('d', { status: 'closed', priority: 'urgent' }),
      job('e', { status: 'reported', emergencyFlag: true }),
    ]);
    expect(groups.map((g) => g.status)).toEqual(['reported', 'triaged', 'closed']);
    expect(groups[0]!.jobs.map((j) => j.id)).toEqual(['e', 'b']);
    expect(groups[1]!.jobs.map((j) => j.id)).toEqual(['c', 'a']);
    expect(groups[1]!.label).toBe('Triaged');
  });

  it('sends only the filters chosen, with query flags as text', () => {
    expect(boardQuery(DEFAULT_BOARD_FILTERS)).toEqual({ open: 'true' });
    expect(boardQuery({ ...DEFAULT_BOARD_FILTERS, status: 'all' })).toEqual({});
    expect(
      boardQuery({
        status: 'work_done',
        priority: 'urgent',
        category: 'plumbing',
        propertyId: P1,
        overdue: true,
        assignee: `staff:${PERSON}`,
        search: '  MT-0042 ',
      }),
    ).toEqual({
      status: 'work_done',
      priority: 'urgent',
      category: 'plumbing',
      propertyId: P1,
      overdue: 'true',
      assigneePersonId: PERSON,
      search: 'MT-0042',
    });
    expect(boardQuery({ ...DEFAULT_BOARD_FILTERS, assignee: `artisan:${ARTISAN}` })).toEqual({
      open: 'true',
      artisanId: ARTISAN,
    });
    // Anything that is not an id is dropped rather than sent.
    expect(
      boardQuery({ ...DEFAULT_BOARD_FILTERS, propertyId: 'x', assignee: 'staff:nobody' }),
    ).toEqual({ open: 'true' });
  });

  it('offers the assignees already on the jobs to someone who cannot list staff', () => {
    const jobs = [
      { assignee: { kind: 'staff' as const, personId: PERSON, name: 'Kojo (demo)' } },
      {
        assignee: {
          kind: 'artisan' as const,
          artisanId: ARTISAN,
          name: 'Kwame Plumbing (demo)',
          response: null,
        },
      },
      { assignee: { kind: 'staff' as const, personId: PERSON, name: 'Kojo (demo)' } },
      { assignee: null },
    ];
    expect(assigneesSeen(jobs)).toEqual([
      { value: `staff:${PERSON}`, label: 'Kojo (demo)' },
      { value: `artisan:${ARTISAN}`, label: 'Kwame Plumbing (demo)' },
    ]);
    expect(assigneeKey(jobs[1]!.assignee!)).toBe(`artisan:${ARTISAN}`);
    expect(assigneeLabel(jobs[1]!.assignee)).toBe(
      'Kwame Plumbing (demo) (artisan, not answered yet)',
    );
    expect(assigneeLabel(null)).toBe('Not assigned');
  });
});

describe('MI-02 decision 4 targets are read from the API, never the client clock', () => {
  const targets = {
    respondBy: '2026-11-05T10:00:00.000Z',
    completeBy: '2026-11-06T08:00:00.000Z',
    respondedAt: null,
    workDoneAt: null,
    overdue: 'respond' as const,
  };

  it('says which target is missed, met or still due', () => {
    expect(targetState(targets, 'respond')).toBe('overdue');
    expect(targetState(targets, 'complete')).toBe('due');
    expect(
      targetState(
        { ...targets, respondedAt: '2026-11-05T09:00:00.000Z', overdue: null },
        'respond',
      ),
    ).toBe('met');
    expect(targetText(targets, 'respond', TZ)).toBe(
      `Respond by ${formatTime(targets.respondBy, TZ)} (missed)`,
    );
    expect(targetText(targets, 'complete', TZ)).toBe(
      `Complete by ${formatTime(targets.completeBy, TZ)}`,
    );
  });
});

describe('MI-06 ★ work is never marked done without an after photo and a completion note', () => {
  it('requires both, and says so for each', () => {
    expect(completeProblems({ photoCount: 0, note: '' })).toEqual({
      photos: 'Add at least one photo of the finished work',
      note: 'Write what was done, at least 3 characters',
    });
    expect(completeProblems({ photoCount: 1, note: ' ' }).note).toBeDefined();
    expect(
      completeProblems({ photoCount: 0, note: 'Replaced the tap washer' }).photos,
    ).toBeDefined();
    expect(completeProblems({ photoCount: 1, note: 'Replaced the tap washer' })).toEqual({});
  });

  it('keeps to ten files at a time (decision 2)', () => {
    expect(completeProblems({ photoCount: 11, note: 'Done well' }).photos).toBe(
      'Add at most 10 files at a time',
    );
  });

  it('places the API’s refusals on the right field', () => {
    expect(MAINTENANCE_FIELD_OF_CODE.MAINTENANCE_AFTER_PHOTO_REQUIRED).toBe('photos');
    expect(MAINTENANCE_FIELD_OF_CODE.MAINTENANCE_COMPLETION_NOTE_REQUIRED).toBe('note');
    const refusal = { status: 400, data: { body: { code: 'MAINTENANCE_AFTER_PHOTO_REQUIRED' } } };
    expect(maintenanceMessage(refusal)).toBe('Add at least one photo of the finished work.');
    expect(isStaleStep({ status: 409, code: 'MAINTENANCE_TRANSITION' })).toBe(true);
    expect(isStaleStep({ status: 409, code: 'CONFLICT' })).toBe(false);
    expect(maintenanceMessage({ status: 400, code: 'SOMETHING_ELSE' })).toBeNull();
  });
});

describe('MI-06 decision 7 starting work needs a before photo or a reason', () => {
  it('takes a photo, or a reason of at least 3 characters', () => {
    expect(startProblems({ photoCount: 1, reason: '' })).toEqual({});
    expect(startProblems({ photoCount: 0, reason: 'Emergency: no time' })).toEqual({});
    expect(Object.keys(startProblems({ photoCount: 0, reason: '' }))).toEqual(['photos', 'reason']);
    expect(startProblems({ photoCount: 0, reason: 'no' }).reason).toBe(
      'Give the reason, at least 3 characters',
    );
  });

  it('asks for the priority and category to triage, and a reason for a dispute', () => {
    expect(triageProblems({ priority: '', category: 'plumbing' })).toEqual({
      priority: 'Choose the priority',
    });
    expect(triageProblems({ priority: 'urgent', category: 'plumbing' })).toEqual({});
    expect(responseProblems({ response: 'confirmed', reason: '' })).toEqual({});
    expect(responseProblems({ response: 'disputed', reason: '' }).reason).toBeDefined();
    expect(responseProblems({ response: '', reason: '' }).response).toBeDefined();
  });
});

describe('MI-01 decision 2 media are checked by the domain’s rules before they are sent', () => {
  const file = (name: string, type: string, size: number) => ({ name, type, size });

  it('maps the types browsers give to the rules’ types, and names typeless files by ending', () => {
    expect(declaredMediaType(file('note.m4a', 'audio/x-m4a', 1))).toBe('audio/mp4');
    expect(declaredMediaType(file('clip.3gp', '', 1))).toBe('video/3gpp');
    expect(declaredMediaType(file('voice.AMR', '', 1))).toBe('audio/amr');
    expect(declaredMediaType(file('photo.jpg', 'image/jpeg', 1))).toBe('image/jpeg');
    expect(declaredMediaType(file('nothing', '', 1))).toBe('');
  });

  it('refuses the wrong kind, an empty or large file and a long recording', () => {
    const all = ['image', 'video', 'audio'] as const;
    expect(mediaProblem(file('a.jpg', 'image/jpeg', 5_000_000), all, null)).toBeNull();
    expect(mediaProblem(file('a.pdf', 'application/pdf', 5), all, null)).toBe(
      'a.pdf is not a photo, video or voice note this accepts.',
    );
    expect(mediaProblem(file('a.mp4', 'video/mp4', 10), ['image'], 5)).toBe(
      'a.mp4 is not a JPEG, PNG or WebP photo.',
    );
    expect(mediaProblem(file('a.jpg', 'image/jpeg', 0), all, null)).toBe('a.jpg is empty.');
    expect(mediaProblem(file('a.jpg', 'image/jpeg', 10_000_001), all, null)).toBe(
      'A photo can be at most 10 MB; a.jpg is larger.',
    );
    expect(mediaProblem(file('a.mp4', 'video/mp4', 1000), all, 91)).toBe(
      'A video can be at most 90 seconds; a.mp4 is longer.',
    );
    expect(mediaProblem(file('a.mp4', 'video/mp4', 1000), all, 90)).toBeNull();
    expect(mediaProblem(file('v.ogg', 'audio/ogg', 1000), all, 181)).toBe(
      'A voice note can be at most 3 minutes; v.ogg is longer.',
    );
    expect(mediaProblem(file('v.amr', '', 1000), all, null)).toContain('could not tell how long');
  });

  it('reads the length only of videos and voice notes, and says the limits', () => {
    expect(needsDuration(file('a.mp4', 'video/mp4', 1))).toBe(true);
    expect(needsDuration(file('a.jpg', 'image/jpeg', 1))).toBe(false);
    expect(mediaHint(['image'])).toBe('Photos up to 10 MB. At most 10 at a time.');
    expect(mediaHint(['image', 'video', 'audio'])).toBe(
      'Photos up to 10 MB, videos up to 90 seconds and 50 MB and voice notes up to 3 minutes and 10 MB. At most 10 at a time.',
    );
    expect(durationText(45.2)).toBe('0:46');
    expect(durationText(125)).toBe('2:05');
    expect(durationText(null)).toBeNull();
  });

  it('plays video and voice notes in the browser’s own players, and groups files by stage', () => {
    expect(playerOf({ kind: 'video', contentType: 'video/mp4' })).toBe('video');
    expect(playerOf({ kind: 'audio', contentType: 'audio/ogg' })).toBe('audio');
    expect(playerOf({ kind: 'document', contentType: 'application/pdf' })).toBe('link');
    const grouped = attachmentsByStage([
      { id: '1', stage: 'after' },
      { id: '2', stage: 'report' },
      { id: '3', stage: 'after' },
    ]);
    expect(grouped.map((g) => [g.stage, g.items.map((i) => i.id)])).toEqual([
      ['report', ['2']],
      ['after', ['1', '3']],
    ]);
  });
});

describe('CM-04 the timeline reads each event’s recorded fields as text', () => {
  const at = '2026-11-05T09:00:00.000Z';
  const detail = (
    kind: Parameters<typeof eventDetail>[0]['kind'],
    data: Record<string, unknown> | null,
  ) => eventDetail({ kind, data }, TZ);

  it('says what each step recorded', () => {
    expect(detail('triaged', { priority: 'urgent', category: 'plumbing' })).toBe(
      'Urgent · Plumbing',
    );
    expect(
      detail('priority_changed', {
        priority: 'routine',
        from: 'emergency',
        to: 'routine',
        reason: 'Only a drip',
      }),
    ).toBe('Emergency to Routine · Only a drip');
    expect(
      detail('assigned', { assigneeKind: 'artisan', assigneeName: 'Kwame (demo)', dueAt: at }),
    ).toBe(`Kwame (demo) (artisan, sent a job sheet) · due ${formatTime(at, TZ)}`);
    expect(detail('assigned', { assigneeKind: 'staff', assigneeName: 'Kojo (demo)' })).toBe(
      'Kojo (demo)',
    );
    expect(detail('visit_planned', { visitAt: at, note: 'Morning' })).toBe(
      `${formatTime(at, TZ)} · Morning`,
    );
    expect(detail('started', { count: 0, beforePhotoReason: 'Emergency: no time' })).toBe(
      'Emergency: no time',
    );
    expect(detail('work_done', { completionNote: 'Fixed', count: 2 })).toBe(
      '2 after photos · Fixed',
    );
    expect(detail('disputed', { reason: 'Still leaking', via: 'whatsapp' })).toBe(
      'On WhatsApp · Still leaking',
    );
    expect(detail('auto_closed', { days: 7 })).toBe('No reply 7 days after the work was done');
    expect(detail('sla_warned', { target: 'respond', stage: 'missed' })).toBe(
      'The response target is missed',
    );
    expect(
      detail('alerted', { channels: ['whatsapp', 'sms'], recipientName: 'Manager One (demo)' }),
    ).toBe('Manager One (demo) · by WhatsApp and SMS');
    expect(detail('media_added', { count: 1, stage: 'before' })).toBe('1 file, before the work');
    expect(detail('tenant_updated', { step: 'work_done' })).toBe(
      'Told the work is done, and asked to confirm',
    );
    expect(detail('expense_linked', { amountMinor: 45_000, supplierName: 'Kwame Plumbing' })).toBe(
      'GH₵450.00 · Kwame Plumbing',
    );
    expect(detail('reported', { source: 'app' })).toBe('In the tenant app');
  });

  it('leaves out what it does not know, and never shows markup as anything but text', () => {
    expect(detail('closed', null)).toBeNull();
    expect(detail('alerted', { channels: ['carrier pigeon'] })).toBeNull();
    expect(detail('visit_planned', { visitAt: 'not a time' })).toBeNull();
    expect(detail('note', { note: '<img src=x onerror=alert(1)>' })).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });
});

describe('MI-04 tasks link to the repair or the inspection they are for', () => {
  it('names the record', () => {
    expect(taskRecordLink({ relatedType: 'maintenance_job', relatedId: P1 })).toEqual({
      href: `/repairs/${P1}`,
      text: 'Open the repair',
    });
    expect(taskRecordLink({ relatedType: 'inspection', relatedId: P1 })?.href).toBe(
      `/inspections/${P1}`,
    );
    expect(taskRecordLink({ relatedType: 'notice', relatedId: P1 })).toBeNull();
  });
});

// Navigation (plan 4.11; decisions 1 and 9) -------------------------------------------------------

const AGENCY = '019a3000-0000-7000-8000-000000000001';
const LANDLORD = '019a3000-0000-7000-8000-000000000002';

function member(
  role: string,
  options: {
    readonly landlord?: boolean;
    readonly phone?: boolean;
    readonly scope?: { properties?: string[]; owners?: string[] };
  } = {},
): Me {
  const companyId = options.landlord ? LANDLORD : AGENCY;
  return {
    personId: PERSON,
    name: 'Someone (demo)',
    state: 'ready',
    authMethod: options.phone ? 'phone_otp' : 'password_totp',
    sessionExpiresAt: '2026-11-05T13:00:00.000Z',
    actorKind: 'staff',
    activeCompanyId: companyId,
    role,
    memberships: [
      {
        membershipId: '019a3000-0000-7000-8000-0000000000bb',
        companyId,
        companyName: 'Demo company',
        companyKind: options.landlord ? 'landlord' : 'agency',
        role,
        nominatedApprover: false,
        ...(options.scope ? { scope: options.scope } : {}),
      },
    ],
  };
}

const M8 = [
  'Reported repairs',
  'Repairs',
  'Artisans',
  'Inspections',
  'Expenses',
  'Maintenance settings',
];
const labels = (me: Me, plan: 'growth' | 'starter' = 'growth') =>
  navFor(me, featuresOf(plan))
    .map((item) => item.label)
    .filter((label) => M8.includes(label));

describe('decision 1 and decision 9 maintenance navigation follows the policy and the plan', () => {
  it('gives a manager the board, artisans, inspections and expenses', () => {
    expect(labels(member('property_manager'))).toEqual([
      'Reported repairs',
      'Artisans',
      'Inspections',
      'Expenses',
    ]);
    expect(labels(member('agency_admin'))).toContain('Maintenance settings');
  });

  it('gives accountants, client owners and advisers a read-only board, and no artisans', () => {
    expect(labels(member('accountant'))).toEqual(['Repairs', 'Inspections', 'Expenses']);
    expect(labels(member('owner', { scope: { owners: [AGENCY] } }))).toEqual([
      'Repairs',
      'Inspections',
      'Expenses',
    ]);
    expect(labels(member('adviser', { scope: { owners: [AGENCY] } }))).toEqual([
      'Repairs',
      'Inspections',
      'Expenses',
    ]);
  });

  it('gives a caretaker the board and inspections for their properties, no expenses', () => {
    expect(labels(member('caretaker', { phone: true, scope: { properties: [P1] } }))).toEqual([
      'Reported repairs',
      'Inspections',
    ]);
  });

  it('keeps the board and artisans off Starter, and move-in, move-out and expenses on it', () => {
    const landlord = member('owner', { landlord: true });
    expect(labels(landlord, 'starter')).toEqual([
      'Inspections',
      'Expenses',
      'Maintenance settings',
    ]);
    expect(labels(landlord, 'growth')).toEqual([
      'Reported repairs',
      'Artisans',
      'Inspections',
      'Expenses',
      'Maintenance settings',
    ]);
  });
});
