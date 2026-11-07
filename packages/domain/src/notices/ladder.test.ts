import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors';
import {
  defaultNoticeLadder,
  dueLadderSteps,
  inSendWindow,
  nextSendTime,
  noticeLadderKey,
  noticeLadderSteps,
  plannedNoticeLadder,
  PRD_NOTICE_LADDER,
  sendWindowOf,
  type DueLadderInput,
  type LadderRecipientState,
  type NoticeLadderConfig,
  type NoticeSendWindow,
} from './ladder';
import { noticeSigned, type NoticeCompletion } from './states';

const HOUR = 3_600_000;
/** A fixed clock: Monday 2 November 2026, 10:00 in Accra (UTC+0). Never the wall clock. */
const ISSUED = new Date('2026-11-02T10:00:00Z');
const at = (hoursAfterIssue: number, from: Date = ISSUED) =>
  new Date(from.getTime() + hoursAfterIssue * HOUR);
const WINDOW = sendWindowOf({ from: '07:00', to: '20:00' });
const STEPS = noticeLadderSteps(PRD_NOTICE_LADDER);

const recipient = (
  recipientId: string,
  over: Partial<LadderRecipientState> = {},
): LadderRecipientState => ({ recipientId, signed: false, doneSteps: new Set(), ...over });

const input = (over: Partial<DueLadderInput> = {}): DueLadderInput => ({
  issuedAt: ISSUED,
  now: ISSUED,
  status: 'sent',
  flags: { paused: false, cancelled: false },
  steps: STEPS,
  recipients: [recipient('r1')],
  completion: 'each',
  timeZone: 'Africa/Accra',
  window: WINDOW,
  ...over,
});

const decided = (over: Partial<DueLadderInput>) =>
  dueLadderSteps(input(over)).map((d) => `${d.recipientId}:${d.step.key}:${d.decision}`);

/** Local minutes after midnight, worked out independently of packages/domain/dates. */
function localMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const hour = Number(parts.find((p) => p.type === 'hour')!.value);
  const minute = Number(parts.find((p) => p.type === 'minute')!.value);
  return hour * 60 + minute;
}

describe('LN-05 ladder', () => {
  it('has the PRD’s steps: 24 h and 72 h reminders, the in-person step at 5 days, escalation at 7', () => {
    expect(
      STEPS.map((s) => [
        s.key,
        s.action,
        s.afterHours,
        s.channels,
        s.statesRemainsInForce,
        s.toTenant,
      ]),
    ).toEqual([
      ['reminder_1', 'reminder', 24, ['whatsapp', 'sms'], false, true],
      ['reminder_2', 'reminder', 72, ['whatsapp', 'sms', 'email'], true, true],
      ['manager_alert', 'manager_alert', 120, [], false, false],
      ['caretaker_task', 'caretaker_task', 120, [], false, false],
      ['escalate', 'escalate', 168, [], false, false],
    ]);
  });

  it('gives each type its default: full, reminders only, or none', () => {
    expect(defaultNoticeLadder('notice_to_quit')).toEqual(PRD_NOTICE_LADDER);
    expect(defaultNoticeLadder('rent_demand')).toEqual(PRD_NOTICE_LADDER);
    for (const type of ['entry', 'building_wide'] as const)
      expect(defaultNoticeLadder(type)).toEqual({
        reminderHours: [24, 72],
        inPersonHours: null,
        escalationHours: null,
      });
    expect(noticeLadderSteps(defaultNoticeLadder('tenant_originated'))).toEqual([]);
  });

  it('uses the company’s M1 four-rung hours when it has four, and the PRD’s otherwise', () => {
    expect(defaultNoticeLadder('breach', [168, 48, 12, 96])).toEqual({
      reminderHours: [12, 48],
      inPersonHours: 96,
      escalationHours: 168,
    });
    expect(defaultNoticeLadder('entry', [12, 48, 96, 168]).reminderHours).toEqual([12, 48]);
    expect(defaultNoticeLadder('breach', [24, 72])).toEqual(PRD_NOTICE_LADDER);
  });

  it('refuses steps that are not whole hours after issue', () => {
    expect(() =>
      noticeLadderSteps({ reminderHours: [0], inPersonHours: null, escalationHours: null }),
    ).toThrow(expect.objectContaining({ code: 'notice.ladder_invalid' }));
    expect(() =>
      noticeLadderSteps({ reminderHours: [], inPersonHours: 1.5, escalationHours: null }),
    ).toThrow(DomainError);
  });

  it('runs a step once it is due, not before', () => {
    expect(decided({ now: at(23.9) })).toEqual([]);
    expect(decided({ now: at(24) })).toEqual(['r1:reminder_1:fire']);
    expect(dueLadderSteps(input({ now: at(24) }))[0]).toMatchObject({
      dueAt: at(24),
      idempotencyKey: 'notice-ladder:r1:reminder_1',
    });
    expect(noticeLadderKey('r9', 'escalate')).toBe('notice-ladder:r9:escalate');
  });

  it('never repeats a step already run or skipped', () => {
    const done = new Set(['reminder_1']);
    expect(decided({ now: at(30), recipients: [recipient('r1', { doneSteps: done })] })).toEqual(
      [],
    );
    expect(
      decided({
        now: at(169),
        recipients: [recipient('r1', { doneSteps: new Set(STEPS.map((s) => s.key)) })],
      }),
    ).toEqual([]);
  });

  it('holds tenant reminders for the sending window but never tasks or alerts (decision 11)', () => {
    const late = new Date('2026-11-02T21:30:00Z');
    expect(decided({ issuedAt: late, now: at(24, late) })).toEqual([]);
    expect(decided({ issuedAt: late, now: new Date('2026-11-04T06:59:00Z') })).toEqual([]);
    expect(decided({ issuedAt: late, now: new Date('2026-11-04T07:00:00Z') })).toEqual([
      'r1:reminder_1:fire',
    ]);
    expect(
      decided({
        issuedAt: late,
        now: at(120, late),
        recipients: [recipient('r1', { doneSteps: new Set(['reminder_1', 'reminder_2']) })],
      }),
    ).toEqual(['r1:manager_alert:fire', 'r1:caretaker_task:fire']);
    expect(
      decided({
        issuedAt: late,
        now: at(168, late),
        recipients: [
          recipient('r1', {
            doneSteps: new Set(['reminder_1', 'reminder_2', 'manager_alert', 'caretaker_task']),
          }),
        ],
      }),
    ).toEqual(['r1:escalate:fire']);
  });

  it('plans when each step runs, a held reminder at the window’s next opening', () => {
    const late = new Date('2026-11-02T21:30:00Z');
    const plan = plannedNoticeLadder({
      issuedAt: late,
      steps: STEPS,
      timeZone: 'Africa/Accra',
      window: WINDOW,
    });
    expect(plan.map((p) => [p.step.key, p.runsAt.toISOString()])).toEqual([
      ['reminder_1', '2026-11-04T07:00:00.000Z'],
      ['reminder_2', '2026-11-06T07:00:00.000Z'],
      ['manager_alert', '2026-11-07T21:30:00.000Z'],
      ['caretaker_task', '2026-11-07T21:30:00.000Z'],
      ['escalate', '2026-11-09T21:30:00.000Z'],
    ]);
  });

  it('keeps the window in company time across a clock change (Europe/London)', () => {
    const window = sendWindowOf({ from: '08:00', to: '20:00' });
    // 29 March 2026: clocks go forward at 01:00 GMT. 06:30 UTC is 07:30 BST, before 08:00.
    expect(inSendWindow(new Date('2026-03-29T06:30:00Z'), window, 'Europe/London')).toBe(false);
    expect(
      nextSendTime(new Date('2026-03-29T06:30:00Z'), window, 'Europe/London').toISOString(),
    ).toBe('2026-03-29T07:00:00.000Z');
    expect(inSendWindow(new Date('2026-03-28T07:30:00Z'), window, 'Europe/London')).toBe(false);
    expect(inSendWindow(new Date('2026-03-28T08:00:00Z'), window, 'Europe/London')).toBe(true);
    expect(inSendWindow(new Date('2026-03-29T18:59:00Z'), window, 'Europe/London')).toBe(true);
    expect(inSendWindow(new Date('2026-03-29T19:00:00Z'), window, 'Europe/London')).toBe(false);
  });

  it('refuses a window that does not end after it starts', () => {
    expect(() => sendWindowOf({ from: '20:00', to: '07:00' })).toThrow(
      expect.objectContaining({ code: 'notice.window_invalid' }),
    );
    expect(() => sendWindowOf({ from: '7am', to: '20:00' })).toThrow(DomainError);
  });

  it('sends only the latest of reminders that fell due together, and skips the rest', () => {
    expect(decided({ now: at(80) })).toEqual(['r1:reminder_1:skip', 'r1:reminder_2:fire']);
    expect(decided({ now: at(170) })).toEqual([
      'r1:reminder_1:skip',
      'r1:reminder_2:fire',
      'r1:manager_alert:fire',
      'r1:caretaker_task:fire',
      'r1:escalate:fire',
    ]);
  });

  it('skips reminders once the notice’s links have expired, but still runs staff steps', () => {
    expect(decided({ now: at(30), linksExpireAt: at(30) })).toEqual(['r1:reminder_1:skip']);
    const late = new Date('2026-11-02T21:30:00Z');
    expect(decided({ issuedAt: late, now: at(122, late), linksExpireAt: at(100, late) })).toEqual([
      'r1:reminder_1:skip',
      'r1:reminder_2:skip',
      'r1:manager_alert:fire',
      'r1:caretaker_task:fire',
    ]);
    expect(decided({ now: at(30), linksExpireAt: at(31) })).toEqual(['r1:reminder_1:fire']);
  });

  it('stops when the notice is paused, cancelled, closed or not issued', () => {
    expect(decided({ now: at(30), flags: { paused: true, cancelled: false } })).toEqual([]);
    expect(decided({ now: at(30), flags: { paused: false, cancelled: true } })).toEqual([]);
    for (const status of ['closed', 'draft', 'approved', 'cancelled'] as const)
      expect(decided({ now: at(30), status })).toEqual([]);
    expect(decided({ now: at(30), status: 'escalated' })).toEqual(['r1:reminder_1:fire']);
  });

  it('stops when the recipient signs, and for joint tenants only for the one who signed', () => {
    expect(decided({ now: at(30), recipients: [recipient('r1', { signed: true })] })).toEqual([]);
    expect(
      decided({ now: at(30), recipients: [recipient('r1', { signed: true }), recipient('r2')] }),
    ).toEqual(['r2:reminder_1:fire']);
  });

  it('★ an unsigned notice still progresses through every step to escalation', () => {
    const done = new Map<string, string[]>();
    const fired: string[] = [];
    for (let t = ISSUED.getTime(); t <= at(8 * 24).getTime(); t += 15 * 60_000) {
      const steps = dueLadderSteps(
        input({
          now: new Date(t),
          recipients: [recipient('r1', { doneSteps: new Set(done.get('r1') ?? []) })],
        }),
      );
      for (const d of steps) {
        done.set(d.recipientId, [...(done.get(d.recipientId) ?? []), d.step.key]);
        fired.push(`${d.step.key}:${d.decision}@${(t - ISSUED.getTime()) / HOUR}h`);
      }
    }
    expect(fired).toEqual([
      'reminder_1:fire@24h',
      'reminder_2:fire@72h',
      'manager_alert:fire@120h',
      'caretaker_task:fire@120h',
      'escalate:fire@168h',
    ]);
  });

  it('runs each step at most once, stops once signed, paused or cancelled, and keeps tenant messages inside the window and the links’ life (property-based)', () => {
    const config = fc.record({
      reminderHours: fc.uniqueArray(fc.integer({ min: 1, max: 200 }), { maxLength: 4 }),
      inPersonHours: fc.option(fc.integer({ min: 1, max: 240 })),
      escalationHours: fc.option(fc.integer({ min: 1, max: 300 })),
    });
    const window = fc
      .integer({ min: 0, max: 22 * 60 })
      .chain((from) =>
        fc
          .integer({ min: from + 30, max: 24 * 60 - 1 })
          .map((to) => ({ fromMinutes: from, toMinutes: to })),
      );
    fc.assert(
      fc.property(
        fc.record({
          issuedAt: fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }),
          timeZone: fc.constantFrom('Africa/Accra', 'Europe/London', 'America/New_York'),
          config,
          window,
          completion: fc.constantFrom<NoticeCompletion>('each', 'any_one'),
          recipients: fc.array(
            fc.record({
              party: fc.constantFrom('a', 'b', null),
              signAfterHours: fc.option(fc.integer({ min: 0, max: 400 }), { freq: 2 }),
            }),
            { minLength: 1, maxLength: 4 },
          ),
          runs: fc.uniqueArray(fc.integer({ min: 0, max: 400 * 60 }), {
            minLength: 1,
            maxLength: 120,
          }),
          pause: fc.option(
            fc.tuple(fc.integer({ min: 0, max: 300 }), fc.integer({ min: 0, max: 200 })),
          ),
          cancelAfterHours: fc.option(fc.integer({ min: 0, max: 400 }), { freq: 4 }),
          linksExpireAfterHours: fc.option(fc.integer({ min: 1, max: 400 }), { freq: 2 }),
        }),
        (c) => {
          const issuedAt = new Date(c.issuedAt);
          const steps = noticeLadderSteps(c.config as NoticeLadderConfig);
          const w: NoticeSendWindow = c.window;
          const done = c.recipients.map(() => new Set<string>());
          const seen = new Set<string>();
          const runs = [...c.runs].sort((a, b) => a - b);
          for (const minutes of runs) {
            const now = new Date(c.issuedAt + minutes * 60_000);
            const hours = minutes / 60;
            const paused = !!c.pause && hours >= c.pause[0] && hours < c.pause[0] + c.pause[1];
            const cancelled = c.cancelAfterHours !== null && hours >= c.cancelAfterHours;
            const recipients = c.recipients.map((r, i) => ({
              recipientId: `r${i}`,
              party: r.party,
              signed: r.signAfterHours !== null && hours >= r.signAfterHours,
              doneSteps: done[i]!,
            }));
            const result = dueLadderSteps({
              issuedAt,
              now,
              status: 'sent',
              flags: { paused, cancelled },
              steps,
              recipients,
              completion: c.completion,
              timeZone: c.timeZone,
              window: w,
              linksExpireAt:
                c.linksExpireAfterHours === null
                  ? null
                  : new Date(c.issuedAt + c.linksExpireAfterHours * HOUR),
            });
            if (result.length > 0) {
              expect(paused || cancelled).toBe(false);
            }
            for (const d of result) {
              const i = Number(d.recipientId.slice(1));
              const key = `${d.recipientId}:${d.step.key}`;
              // At most once per recipient and step, fired or skipped.
              expect(seen.has(key)).toBe(false);
              seen.add(key);
              done[i]!.add(d.step.key);
              // Never before it is due.
              expect(now.getTime()).toBeGreaterThanOrEqual(c.issuedAt + d.step.afterHours * HOUR);
              // Never once the recipient's party (or, for any_one, anyone) has signed.
              const self = recipients[i]!;
              const acknowledged =
                c.completion === 'any_one'
                  ? recipients.some((r) => r.signed)
                  : recipients.some(
                      (r) =>
                        r.signed && (r.party ?? r.recipientId) === (self.party ?? self.recipientId),
                    );
              expect(acknowledged).toBe(false);
              // Tenant messages only inside the window, in company time, while the links work.
              if (d.step.toTenant && d.decision === 'fire') {
                if (c.linksExpireAfterHours !== null)
                  expect(hours).toBeLessThan(c.linksExpireAfterHours);
                const m = localMinutes(now, c.timeZone);
                expect(m).toBeGreaterThanOrEqual(w.fromMinutes);
                expect(m).toBeLessThan(w.toMinutes);
              }
            }
            expect(noticeSigned(recipients, c.completion)).toBe(
              c.completion === 'any_one'
                ? recipients.some((r) => r.signed)
                : [...new Set(recipients.map((r) => r.party ?? r.recipientId))].every((p) =>
                    recipients.some((r) => r.signed && (r.party ?? r.recipientId) === p),
                  ),
            );
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('runs every staff step on time and decides every reminder when the job runs every 15 minutes (property-based)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }),
        fc.constantFrom('Africa/Accra', 'Europe/London'),
        (issued, timeZone) => {
          const issuedAt = new Date(issued);
          const done = new Set<string>();
          const firstRun = new Map<string, number>();
          for (let t = issued; t <= issued + 200 * HOUR; t += 15 * 60_000) {
            for (const d of dueLadderSteps(
              input({
                issuedAt,
                now: new Date(t),
                timeZone,
                recipients: [recipient('r1', { doneSteps: done })],
              }),
            )) {
              done.add(d.step.key);
              firstRun.set(d.step.key, t);
            }
          }
          expect([...done].sort()).toEqual(STEPS.map((s) => s.key).sort());
          for (const s of STEPS.filter((x) => !x.toTenant))
            expect(firstRun.get(s.key)! - (issued + s.afterHours * HOUR)).toBeLessThan(15 * 60_000);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('LN-07 one signature', () => {
  it('acknowledges a company tenant’s notice with any one signatory’s signature', () => {
    const signatories = [
      { recipientId: 's1', signed: false },
      { recipientId: 's2', signed: true },
    ];
    expect(noticeSigned(signatories, 'any_one')).toBe(true);
    expect(noticeSigned(signatories, 'each')).toBe(false);
    expect(noticeSigned([], 'any_one')).toBe(false);
    expect(
      noticeSigned(
        [
          { recipientId: 's1', party: 'co', signed: false },
          { recipientId: 's2', party: 'co', signed: true },
          { recipientId: 'flat', signed: true },
        ],
        'each',
      ),
    ).toBe(true);
  });

  it('★ stops every signatory’s ladder when one signs', () => {
    const recipients = [recipient('s1'), recipient('s2', { signed: true }), recipient('s3')];
    expect(decided({ now: at(170), recipients, completion: 'any_one' })).toEqual([]);
    expect(
      decided({
        now: at(170),
        recipients: [recipient('s1'), recipient('s3')],
        completion: 'any_one',
      }),
    ).toHaveLength(10);
  });
});
