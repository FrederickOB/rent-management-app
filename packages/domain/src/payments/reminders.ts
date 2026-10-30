import { addDays, parseBusinessDate, toIsoDate } from '../dates';

/**
 * The rent reminder ladder (BC-09; M4b plan 4.7): steps at the company's offsets from the due
 * date, 7 days before, on the day, and 3, 7 and 14 days after by default. Each step goes once per
 * invoice, and the ladder stops as soon as nothing is left to pay.
 */
export interface LadderStep {
  readonly offsetDays: number;
  readonly date: string;
}

export function ladderFor(dueDate: string, offsetsDays: readonly number[]): LadderStep[] {
  const due = parseBusinessDate(dueDate);
  return [...new Set(offsetsDays)]
    .sort((a, b) => a - b)
    .map((offsetDays) => ({ offsetDays, date: toIsoDate(addDays(due, offsetDays)) }));
}

export interface ReminderDecision {
  /** The step to send today, if any: the latest one that is due and not yet sent. */
  readonly send: LadderStep | null;
  /**
   * Earlier steps the job missed (it was down, or the invoice was issued late). They are
   * recorded as skipped rather than sent together, so a tenant never gets a burst of reminders.
   */
  readonly skip: readonly LadderStep[];
}

/** Which step to send today for one invoice. Nothing once the invoice needs no more money. */
export function reminderDue(input: {
  readonly dueDate: string;
  readonly offsetsDays: readonly number[];
  readonly today: string;
  /** Offsets already sent or skipped for this invoice. */
  readonly done: ReadonlySet<number>;
  /** Still to pay after credit the lease holds (the forward walk). */
  readonly outstandingMinor: number;
}): ReminderDecision {
  if (input.outstandingMinor <= 0) return { send: null, skip: [] };
  const open = ladderFor(input.dueDate, input.offsetsDays).filter(
    (s) => s.date <= input.today && !input.done.has(s.offsetDays),
  );
  if (open.length === 0) return { send: null, skip: [] };
  const latest = open[open.length - 1] as LadderStep;
  return { send: latest, skip: open.slice(0, -1) };
}

/** The first step carries the invoice itself (plan 4.7): it is how an invoice reaches the tenant. */
export const carriesInvoice = (step: LadderStep, offsetsDays: readonly number[]): boolean =>
  step.offsetDays === Math.min(...offsetsDays);
