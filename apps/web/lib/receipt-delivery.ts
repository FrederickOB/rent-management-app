import { ladderFor } from '@rent/domain/payments';
import { formatBusinessDate } from './business-dates';
import { formatTime } from './format';

// Receipts on their way to the tenant (BC-06; M4b plan 4.6) and the rent reminder ladder for an
// invoice (BC-09; plan 4.7), as staff see them. The API records what was sent, on which channel
// and when; these helpers only say it.

/**
 * BC-06: a receipt reaches the tenant within a minute of the payment's confirmation. A product
 * target from the PRD, not law; the API raises the alert past it, and the screen says so too.
 */
export const RECEIPT_TARGET_MS = 60_000;

export type DeliveryStatus = 'queued' | 'sent' | 'not_sent' | 'failed';

export interface DeliveryFacts {
  readonly status: DeliveryStatus;
  /** The channel it went on (`sms`, `email`), once sent. */
  readonly channel: string | null;
  readonly sentAt: string | null;
  /** From the payment's confirmation to the send, by the server's clock. */
  readonly latencyMs: number | null;
}

const CHANNEL_NAMES: Record<string, string> = { sms: 'SMS', email: 'email', whatsapp: 'WhatsApp' };
const channelName = (channel: string): string => CHANNEL_NAMES[channel] ?? channel;

/** `under a second`, `12 seconds`, `1 minute 5 seconds`, `3 minutes`. Whole seconds, rounded down. */
export function durationLabel(ms: number): string {
  const seconds = Math.trunc(Math.max(0, ms) / 1000);
  if (seconds === 0) return 'under a second';
  const minutes = Math.trunc(seconds / 60);
  const rest = seconds % 60;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (minutes === 0) return plural(rest, 'second');
  return rest === 0
    ? plural(minutes, 'minute')
    : `${plural(minutes, 'minute')} ${plural(rest, 'second')}`;
}

/** The badge colours the screens use (components/ui/badge). */
export type DeliveryTone = 'neutral' | 'blue' | 'green' | 'amber' | 'red';

export interface DeliveryLine {
  readonly tone: DeliveryTone;
  readonly label: string;
  /** When and how fast, for a sent receipt; what to do, for one that did not go. */
  readonly detail: string | null;
  /** Sent later than the BC-06 target. */
  readonly late: boolean;
}

/** One receipt's delivery in words, for the payment page and the receipts list. */
export function deliveryLine(delivery: DeliveryFacts | null, timeZone: string): DeliveryLine {
  if (!delivery)
    return { tone: 'neutral', label: 'Not sent to the tenant', detail: null, late: false };
  switch (delivery.status) {
    case 'queued':
      return { tone: 'blue', label: 'On its way to the tenant', detail: null, late: false };
    case 'sent': {
      const late = delivery.latencyMs !== null && delivery.latencyMs > RECEIPT_TARGET_MS;
      const how = delivery.channel ? ` by ${channelName(delivery.channel)}` : '';
      const when = delivery.sentAt ? ` ${formatTime(delivery.sentAt, timeZone)}` : '';
      const speed =
        delivery.latencyMs === null
          ? null
          : `${durationLabel(delivery.latencyMs)} after the payment was confirmed${late ? ', later than the one-minute target' : ''}.`;
      return {
        tone: late ? 'amber' : 'green',
        label: `Sent${how}`,
        detail: [when.trim() ? `Sent${when}.` : null, speed].filter(Boolean).join(' ') || null,
        late,
      };
    }
    case 'not_sent':
      return {
        tone: 'amber',
        label: 'Not sent: no channel we may use',
        detail:
          'The tenant has not agreed to messages on any channel we have for them. The receipt is still on the payment, and in the tenant’s app.',
        late: false,
      };
    case 'failed':
      return {
        tone: 'red',
        label: 'Could not be sent',
        detail:
          'Every channel failed after retries. The receipt is still on the payment, and in the tenant’s app.',
        late: false,
      };
  }
}

/** For a table row: `12 seconds after confirmation`, flagged when late; null until sent. */
export function deliverySpeed(delivery: DeliveryFacts | null): string | null {
  if (delivery?.status !== 'sent' || delivery.latencyMs === null) return null;
  const late = delivery.latencyMs > RECEIPT_TARGET_MS ? ' (late)' : '';
  return `${durationLabel(delivery.latencyMs)} after confirmation${late}`;
}

// The reminder ladder for one invoice (BC-09) ---------------------------------------------------

export interface ReminderStepFacts {
  readonly offsetDays: number;
  readonly status: 'sent' | 'skipped';
  readonly stepDate: string;
  /** When the step was recorded, by the server's clock. */
  readonly createdAt?: string;
}

export type ReminderState = 'sent' | 'skipped' | 'upcoming' | 'stopped';

export interface ReminderRow {
  readonly offsetDays: number;
  readonly date: string;
  /** `7 days before`, `On the due date`, `3 days after`. */
  readonly when: string;
  readonly state: ReminderState;
  /** When a sent or skipped step was recorded; null for a step still to come. */
  readonly recordedAt: string | null;
}

export const REMINDER_STATE_LABELS: Record<ReminderState, string> = {
  sent: 'Sent',
  skipped: 'Skipped: missed while the reminders were not running',
  upcoming: 'Due to go',
  stopped: 'Not needed: nothing left to pay',
};

const whenWords = (offset: number): string => {
  const days = Math.abs(offset);
  const unit = days === 1 ? 'day' : 'days';
  if (offset === 0) return 'On the due date';
  return offset < 0 ? `${days} ${unit} before` : `${days} ${unit} after`;
};

/**
 * An invoice's reminders, step by step (BC-09): what was sent or skipped, as the API recorded
 * it, and the company's steps still to come. Once the invoice needs no more money, the steps
 * not yet sent are not needed. A step recorded under an older ladder still shows.
 */
export function reminderRows(input: {
  readonly dueDate: string;
  readonly offsetsDays: readonly number[];
  readonly steps: readonly ReminderStepFacts[];
  /** Nothing left to pay on the invoice after the lease's credit. */
  readonly settled: boolean;
}): ReminderRow[] {
  const recorded = new Map(input.steps.map((s) => [s.offsetDays, s]));
  const planned = ladderFor(input.dueDate, input.offsetsDays);
  const rows: ReminderRow[] = planned.map((step) => {
    const done = recorded.get(step.offsetDays);
    return {
      offsetDays: step.offsetDays,
      date: done?.stepDate ?? step.date,
      when: whenWords(step.offsetDays),
      state: done ? done.status : input.settled ? 'stopped' : 'upcoming',
      recordedAt: done?.createdAt ?? null,
    };
  });
  for (const step of input.steps)
    if (!planned.some((p) => p.offsetDays === step.offsetDays))
      rows.push({
        offsetDays: step.offsetDays,
        date: step.stepDate,
        when: whenWords(step.offsetDays),
        state: step.status,
        recordedAt: step.createdAt ?? null,
      });
  return rows.sort((a, b) => a.offsetDays - b.offsetDays);
}

/** `7 days before · 8 Nov 2026`. */
export const reminderWhen = (row: Pick<ReminderRow, 'when' | 'date'>): string =>
  `${row.when} · ${formatBusinessDate(row.date)}`;
