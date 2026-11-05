import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { companySettingsSchema } from '../settings/company-settings';
import { noticeDocumentContent } from './document';
import {
  dueLadderSteps,
  laddersMissingEscalation,
  noticeLadderSteps,
  PRD_NOTICE_LADDER,
  sendWindowOf,
} from './ladder';

/** The M7 review's domain changes (docs/plans/M7.md section 9.3). */
const HOUR = 3_600_000;
const STEPS = noticeLadderSteps(PRD_NOTICE_LADDER);
const WINDOW = sendWindowOf({ from: '07:00', to: '20:00' });

describe('M7 review MF-5 a building-wide notice names no tenant', () => {
  it('is addressed to the occupants of the property and its blocks, whoever receives it', () => {
    const base = {
      type: 'building_wide' as const,
      subtype: 'fire_safety' as const,
      fields: { title: 'Fire drill', particulars: 'Gather at the car park.' },
      number: 'N-000004',
      issueDate: '2026-11-09',
      landlordName: 'Osu Ridge',
      propertyName: 'Osu Plaza',
      replaces: null,
      counselReviewed: false,
    };
    const all = noticeDocumentContent({
      ...base,
      premises: '',
      recipients: ['Ama Mensah', 'Kofi Boateng'],
    });
    expect(all.recipients).toEqual(['The occupants of Osu Plaza']);
    const blocks = noticeDocumentContent({
      ...base,
      premises: 'Blocks B1, B2',
      recipients: Array.from({ length: 800 }, (_, i) => `Tenant ${i}`),
    });
    expect(blocks.recipients).toEqual(['The occupants of Osu Plaza, Blocks B1, B2']);
    // Every other type still names its parties.
    expect(
      noticeDocumentContent({
        ...base,
        type: 'breach',
        subtype: 'noise',
        premises: 'ACC-OSU-F1-01',
        recipients: ['Ama Mensah'],
      }).recipients,
    ).toEqual(['Ama Mensah']);
  });
});

describe('M7 review D-F escalation is required for full-ladder types', () => {
  it('finds a company ladder that drops escalation, and the settings refuse it', () => {
    expect(
      laddersMissingEscalation({
        breach: { reminderHours: [24], inPersonHours: 120, escalationHours: null },
        entry: { reminderHours: [24], inPersonHours: null, escalationHours: null },
        rent_demand: { reminderHours: [24], inPersonHours: 120, escalationHours: 168 },
      }),
    ).toEqual(['breach']);
    const refused = companySettingsSchema.safeParse({
      noticeLadders: {
        notice_to_quit: { reminderHours: [24, 72], inPersonHours: 120, escalationHours: null },
      },
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual([
      'noticeLadders',
      'notice_to_quit',
      'escalationHours',
    ]);
    expect(
      companySettingsSchema.safeParse({
        noticeLadders: {
          building_wide: { reminderHours: [24], inPersonHours: null, escalationHours: null },
        },
      }).success,
    ).toBe(true);
  });
});

describe('M7 review D-B a resumed ladder carries on where it paused', () => {
  it('moves every step on by the time paused, and fires the same steps as an unpaused ladder would (property-based)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 240 }),
        (issued, shiftHours, nowHours) => {
          const base = {
            status: 'sent' as const,
            flags: { paused: false, cancelled: false },
            steps: STEPS,
            recipients: [{ recipientId: 'r1', signed: false, doneSteps: new Set<string>() }],
            completion: 'each' as const,
            timeZone: 'UTC',
            window: { fromMinutes: 0, toMinutes: 24 * 60 },
          };
          const shifted = dueLadderSteps({
            ...base,
            issuedAt: new Date(issued),
            now: new Date(issued + (shiftHours + nowHours) * HOUR),
            shiftSeconds: shiftHours * 3600,
          });
          const plain = dueLadderSteps({
            ...base,
            issuedAt: new Date(issued),
            now: new Date(issued + nowHours * HOUR),
          });
          expect(shifted.map((d) => [d.step.key, d.decision])).toEqual(
            plain.map((d) => [d.step.key, d.decision]),
          );
          for (const [i, d] of shifted.entries())
            expect(d.dueAt.getTime() - plain[i]!.dueAt.getTime()).toBe(shiftHours * HOUR);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('works out the sending window only when a reminder is due', () => {
    // A window that is never open would hold every reminder; staff steps still run.
    const due = dueLadderSteps({
      issuedAt: '2026-11-09T10:00:00Z',
      now: '2026-11-16T10:30:00Z',
      status: 'sent',
      flags: { paused: false, cancelled: false },
      steps: STEPS,
      recipients: [
        {
          recipientId: 'r1',
          signed: false,
          doneSteps: new Set(['reminder_1', 'reminder_2']),
        },
      ],
      completion: 'each',
      timeZone: 'Africa/Accra',
      window: WINDOW,
    });
    expect(due.map((d) => d.step.key)).toEqual(['manager_alert', 'caretaker_task', 'escalate']);
  });
});
