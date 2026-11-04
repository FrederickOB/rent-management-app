import { describe, expect, it } from 'vitest';
import {
  deliveryLine,
  deliverySpeed,
  durationLabel,
  RECEIPT_TARGET_MS,
  reminderRows,
  reminderWhen,
} from './receipt-delivery';

const ACCRA = 'Africa/Accra';

describe('BC-06 a receipt’s delivery and how long it took', () => {
  it('says how fast in a table row, and flags a late one', () => {
    const sent = { status: 'sent' as const, channel: 'sms' as const, sentAt: null };
    expect(deliverySpeed({ ...sent, latencyMs: 9_000 })).toBe('9 seconds after confirmation');
    expect(deliverySpeed({ ...sent, latencyMs: 75_000 })).toBe(
      '1 minute 15 seconds after confirmation (late)',
    );
    expect(deliverySpeed({ ...sent, status: 'queued', latencyMs: null })).toBeNull();
    expect(deliverySpeed(null)).toBeNull();
  });

  it('says how long after the confirmation it went, in whole seconds', () => {
    expect(durationLabel(400)).toBe('under a second');
    expect(durationLabel(12_900)).toBe('12 seconds');
    expect(durationLabel(1_000)).toBe('1 second');
    expect(durationLabel(65_000)).toBe('1 minute 5 seconds');
    expect(durationLabel(180_000)).toBe('3 minutes');
  });

  it('shows a receipt sent within the minute, by channel, in the company’s time zone', () => {
    const line = deliveryLine(
      { status: 'sent', channel: 'sms', sentAt: '2026-11-03T09:00:12.000Z', latencyMs: 12_000 },
      ACCRA,
    );
    expect(line).toEqual({
      tone: 'green',
      label: 'Sent by SMS',
      detail:
        'Sent 3 Nov 2026, 09:00 GMT (Africa/Accra). 12 seconds after the payment was confirmed.',
      late: false,
    });
  });

  it('flags a receipt sent later than the one-minute target', () => {
    const line = deliveryLine(
      {
        status: 'sent',
        channel: 'email',
        sentAt: '2026-11-03T09:02:00.000Z',
        latencyMs: RECEIPT_TARGET_MS + 5_000,
      },
      ACCRA,
    );
    expect(line.late).toBe(true);
    expect(line.tone).toBe('amber');
    expect(line.detail).toContain('1 minute 5 seconds after the payment was confirmed');
    expect(line.detail).toContain('later than the one-minute target');
    expect(
      deliveryLine(
        { status: 'sent', channel: 'sms', sentAt: null, latencyMs: RECEIPT_TARGET_MS },
        ACCRA,
      ).late,
    ).toBe(false);
  });

  it('says plainly when a receipt is on its way, could not go, or had no channel', () => {
    const facts = { channel: null, sentAt: null, latencyMs: null };
    expect(deliveryLine({ status: 'queued', ...facts }, ACCRA).label).toBe(
      'On its way to the tenant',
    );
    expect(deliveryLine({ status: 'failed', ...facts }, ACCRA).tone).toBe('red');
    expect(deliveryLine({ status: 'not_sent', ...facts }, ACCRA).label).toMatch(/no channel/);
    expect(deliveryLine(null, ACCRA).label).toBe('Not sent to the tenant');
  });
});

describe('BC-09 an invoice’s reminders, step by step', () => {
  const offsets = [-7, 0, 3, 7, 14];

  it('shows each step once: sent or skipped as recorded, the rest still to go', () => {
    const rows = reminderRows({
      dueDate: '2026-11-15',
      offsetsDays: offsets,
      steps: [
        { offsetDays: -7, status: 'skipped', stepDate: '2026-11-08' },
        { offsetDays: 0, status: 'sent', stepDate: '2026-11-15' },
      ],
      settled: false,
    });
    expect(rows.map((r) => [r.offsetDays, r.state, r.date])).toEqual([
      [-7, 'skipped', '2026-11-08'],
      [0, 'sent', '2026-11-15'],
      [3, 'upcoming', '2026-11-18'],
      [7, 'upcoming', '2026-11-22'],
      [14, 'upcoming', '2026-11-29'],
    ]);
    expect(reminderWhen(rows[0]!)).toBe('7 days before · 8 Nov 2026');
    expect(rows[1]!.when).toBe('On the due date');
    expect(rows[2]!.when).toBe('3 days after');
  });

  it('stops once the invoice is paid: steps not sent are not needed', () => {
    const rows = reminderRows({
      dueDate: '2026-11-15',
      offsetsDays: offsets,
      steps: [{ offsetDays: -7, status: 'sent', stepDate: '2026-11-08' }],
      settled: true,
    });
    expect(rows.map((r) => r.state)).toEqual(['sent', 'stopped', 'stopped', 'stopped', 'stopped']);
  });

  it('keeps when each recorded step was recorded', () => {
    const rows = reminderRows({
      dueDate: '2026-11-15',
      offsetsDays: [0, 3],
      steps: [
        {
          offsetDays: 0,
          status: 'sent',
          stepDate: '2026-11-15',
          createdAt: '2026-11-15T08:00:04.000Z',
        },
      ],
      settled: false,
    });
    expect(rows.map((r) => r.recordedAt)).toEqual(['2026-11-15T08:00:04.000Z', null]);
  });

  it('keeps a step sent under an older ladder', () => {
    const rows = reminderRows({
      dueDate: '2026-11-15',
      offsetsDays: [0],
      steps: [{ offsetDays: -1, status: 'sent', stepDate: '2026-11-14' }],
      settled: false,
    });
    expect(rows.map((r) => [r.offsetDays, r.state, r.when])).toEqual([
      [-1, 'sent', '1 day before'],
      [0, 'upcoming', 'On the due date'],
    ]);
  });
});
