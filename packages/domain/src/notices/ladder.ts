import { z } from 'zod';
import {
  addDays,
  addHours,
  addSeconds,
  businessDateOf,
  epochMillisOf,
  epochMillisPlusHours,
  instantAtMinutes,
  instantFrom,
  instantToDate,
  minutesIntoDay,
  parseTimeOfDay,
  type Instant,
} from '../dates';
import { DomainError } from '../errors';
import {
  isLive,
  recipientAcknowledged,
  type NoticeCompletion,
  type NoticeLadderFlags,
  type NoticeStatus,
  type RecipientSignature,
} from './states';
import { NOTICE_TYPE_RULES, type NoticeType } from './types';

/**
 * The reminder ladder (LN-05; PRD section 8; M7 plan 4.7, decision 11). Steps count hours from
 * issue. Tenant reminders go only inside the company's sending window (07:00 to 20:00 company
 * time by default); manager alerts, caretaker tasks and escalation are never held. Each step
 * runs at most once per recipient, keyed by (recipient, step), however often the job runs. The
 * ladder stops for a recipient once their party has acknowledged (LN-07), and for everyone when
 * the notice closes or staff pause or cancel it.
 */
export const NOTICE_CHANNELS = ['whatsapp', 'sms', 'email'] as const;
export type NoticeChannel = (typeof NOTICE_CHANNELS)[number];

export const NOTICE_LADDER_ACTIONS = [
  'reminder',
  'manager_alert',
  'caretaker_task',
  'escalate',
] as const;
export type NoticeLadderAction = (typeof NOTICE_LADDER_ACTIONS)[number];

export interface NoticeLadderStep {
  /** Stable within a notice, for idempotency: `reminder_1`, `reminder_2`, `manager_alert`… */
  readonly key: string;
  readonly action: NoticeLadderAction;
  readonly afterHours: number;
  /** The channels a reminder goes on; empty for staff steps. */
  readonly channels: readonly NoticeChannel[];
  /** The 72-hour wording: the notice remains in force whether or not it is signed. */
  readonly statesRemainsInForce: boolean;
  /** A message to the tenant, held for the sending window (decision 11). */
  readonly toTenant: boolean;
}

/** A ladder as configured: the tenant reminders, the in-person step and escalation. */
export interface NoticeLadderConfig {
  /** Hours after issue for each tenant reminder. */
  readonly reminderHours: readonly number[];
  /** Hours after issue that the manager is alerted and a caretaker task created; null for none. */
  readonly inPersonHours: number | null;
  /** Hours after issue that the notice escalates to physical service; null for none. */
  readonly escalationHours: number | null;
}

/** The PRD's defaults (section 8): product settings, not law. */
export const PRD_NOTICE_LADDER: NoticeLadderConfig = {
  reminderHours: [24, 72],
  inPersonHours: 120,
  escalationHours: 168,
};

const NO_LADDER: NoticeLadderConfig = {
  reminderHours: [],
  inPersonHours: null,
  escalationHours: null,
};

/**
 * A type's default ladder (plan 4.2): `full` types get every rung, `reminders_only` types the
 * reminders alone, and a tenant-originated notice none. `companyHours` is the company's M1
 * setting `noticeReminderOffsetsHours`; when it has the PRD's four rungs (first reminder, second
 * reminder, in person, escalation) its hours are used, and otherwise the PRD's.
 */
export function defaultNoticeLadder(
  type: NoticeType,
  companyHours?: readonly number[],
): NoticeLadderConfig {
  const kind = NOTICE_TYPE_RULES[type].ladder;
  if (kind === 'none') return NO_LADDER;
  const sorted = companyHours ? [...companyHours].sort((a, b) => a - b) : [];
  const base: NoticeLadderConfig =
    sorted.length === 4 && sorted.every((h) => Number.isInteger(h) && h > 0)
      ? {
          reminderHours: [sorted[0]!, sorted[1]!],
          inPersonHours: sorted[2]!,
          escalationHours: sorted[3]!,
        }
      : PRD_NOTICE_LADDER;
  return kind === 'full' ? base : { ...NO_LADDER, reminderHours: base.reminderHours };
}

/**
 * The steps of a ladder, in the order they fall due. The first reminder goes by WhatsApp and
 * SMS; every later one by WhatsApp, SMS and email, stating that the notice remains in force
 * whether or not it is signed (PRD section 8). The in-person step is two steps, the manager's
 * alert and the caretaker's task, so each runs once on its own.
 */
export function noticeLadderSteps(config: NoticeLadderConfig): NoticeLadderStep[] {
  const steps: NoticeLadderStep[] = [];
  const hours = [...new Set(config.reminderHours)].sort((a, b) => a - b);
  hours.forEach((h, i) =>
    steps.push({
      key: `reminder_${i + 1}`,
      action: 'reminder',
      afterHours: h,
      channels: i === 0 ? ['whatsapp', 'sms'] : ['whatsapp', 'sms', 'email'],
      statesRemainsInForce: i > 0,
      toTenant: true,
    }),
  );
  const staff = (key: string, action: NoticeLadderAction, h: number): NoticeLadderStep => ({
    key,
    action,
    afterHours: h,
    channels: [],
    statesRemainsInForce: false,
    toTenant: false,
  });
  if (config.inPersonHours !== null) {
    steps.push(staff('manager_alert', 'manager_alert', config.inPersonHours));
    steps.push(staff('caretaker_task', 'caretaker_task', config.inPersonHours));
  }
  if (config.escalationHours !== null)
    steps.push(staff('escalate', 'escalate', config.escalationHours));
  for (const s of steps)
    if (!Number.isInteger(s.afterHours) || s.afterHours <= 0)
      throw new DomainError('notice.ladder_invalid', 'Ladder steps are whole hours after issue');
  return steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.afterHours - b.s.afterHours || a.i - b.i)
    .map(({ s }) => s);
}

// Company settings (plan 4.9): the shapes live here; company-settings.ts holds the keys.

const ladderHours = z
  .number()
  .int()
  .min(1)
  .max(24 * 60);

export const noticeLadderConfigSchema = z
  .object({
    reminderHours: z.array(ladderHours).max(6),
    inPersonHours: ladderHours.nullable(),
    escalationHours: ladderHours.nullable(),
  })
  .strict();

/**
 * Review D-F (CLAUDE.md section 9): an unsigned notice of a full-ladder type always escalates to
 * physical service, so a company ladder for one of those types must keep its escalation step.
 * Returns the types that drop it.
 */
export function laddersMissingEscalation(
  ladders: Partial<Record<string, NoticeLadderConfig>>,
): NoticeType[] {
  return (Object.keys(ladders) as NoticeType[]).filter(
    (type) => NOTICE_TYPE_RULES[type]?.ladder === 'full' && ladders[type]?.escalationHours === null,
  );
}

export const LADDER_ESCALATION_REQUIRED_MESSAGE =
  'Notices of this type must escalate to physical service when unsigned: set the escalation hours';

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time such as 07:00');

export const noticeSendWindowSchema = z
  .object({ from: timeOfDay, to: timeOfDay })
  .strict()
  .refine((w) => parseTimeOfDay(w.from) < parseTimeOfDay(w.to), {
    message: 'The window must end after it starts, on the same day',
  });

/** The sending window for tenant messages, as minutes after local midnight: from ≤ t < to. */
export interface NoticeSendWindow {
  readonly fromMinutes: number;
  readonly toMinutes: number;
}

/** Decision 11: 07:00 to 20:00 company time. */
export const DEFAULT_NOTICE_SEND_WINDOW = { from: '07:00', to: '20:00' } as const;

export function sendWindowOf(window: {
  readonly from: string;
  readonly to: string;
}): NoticeSendWindow {
  const fromMinutes = parseTimeOfDay(window.from);
  const toMinutes = parseTimeOfDay(window.to);
  return checkWindow({ fromMinutes, toMinutes });
}

function checkWindow(window: NoticeSendWindow): NoticeSendWindow {
  if (
    !Number.isInteger(window.fromMinutes) ||
    !Number.isInteger(window.toMinutes) ||
    window.fromMinutes < 0 ||
    window.toMinutes > 24 * 60 ||
    window.fromMinutes >= window.toMinutes
  )
    throw new DomainError(
      'notice.window_invalid',
      'The sending window must end after it starts, on the same day',
    );
  return window;
}

type InstantInput = Date | string | Instant;

/** Whether `at` falls inside the sending window in `timeZone`. */
export function inSendWindow(
  at: InstantInput,
  window: NoticeSendWindow,
  timeZone: string,
): boolean {
  const w = checkWindow(window);
  const m = minutesIntoDay(instantFrom(at), timeZone);
  return m >= w.fromMinutes && m < w.toMinutes;
}

function nextOpening(at: Instant, window: NoticeSendWindow, timeZone: string): Instant {
  const m = minutesIntoDay(at, timeZone);
  const day = businessDateOf(at, timeZone);
  if (m < window.fromMinutes) return instantAtMinutes(day, window.fromMinutes, timeZone);
  if (m >= window.toMinutes) return instantAtMinutes(addDays(day, 1), window.fromMinutes, timeZone);
  return at;
}

/** `at` itself inside the window; otherwise the window's next opening (decision 11). */
export function nextSendTime(at: InstantInput, window: NoticeSendWindow, timeZone: string): Date {
  return instantToDate(nextOpening(instantFrom(at), checkWindow(window), timeZone));
}

/** The idempotency key of one step for one recipient (plan 4.12: recipient id + ladder step). */
export const noticeLadderKey = (recipientId: string, stepKey: string): string =>
  `notice-ladder:${recipientId}:${stepKey}`;

export interface LadderRecipientState extends RecipientSignature {
  /** Step keys already run or skipped for this recipient. */
  readonly doneSteps: ReadonlySet<string>;
}

export interface DueLadderStep {
  readonly recipientId: string;
  readonly step: NoticeLadderStep;
  /** Issue plus the step's hours. */
  readonly dueAt: Date;
  /**
   * `fire`: run it now. `skip`: record it as done without sending: an earlier reminder the job
   * missed, overtaken by a later one, so a tenant never gets a burst of reminders.
   */
  readonly decision: 'fire' | 'skip';
  readonly idempotencyKey: string;
}

export interface DueLadderInput {
  readonly issuedAt: InstantInput;
  readonly now: InstantInput;
  readonly status: NoticeStatus;
  readonly flags: NoticeLadderFlags;
  readonly steps: readonly NoticeLadderStep[];
  readonly recipients: readonly LadderRecipientState[];
  readonly completion: NoticeCompletion;
  readonly timeZone: string;
  readonly window: NoticeSendWindow;
  /** When the notice's links expire (noticeLinkExpiresAt): a reminder after it is skipped. */
  readonly linksExpireAt?: InstantInput | null;
  /**
   * Review D-B: seconds the ladder spent paused. Every step falls due that much later, so a
   * resume carries on where the pause left off and never fires a burst of overdue steps.
   */
  readonly shiftSeconds?: number;
}

/**
 * The ladder steps to run now (plan 4.7), for the `notices.ladder` job. Nothing for a notice that
 * is not live, or whose ladder is paused or cancelled, or for a recipient whose party has
 * acknowledged. Staff steps run once due. Tenant reminders run once due and only while `now` is
 * inside the sending window; when several are due at once, the latest runs and the earlier ones
 * are skipped, as is any reminder once the notice's links have expired (its fresh link would not
 * work). The caller records each decision under its idempotency key and passes the keys back as
 * `doneSteps`, so a step never runs twice.
 */
export function dueLadderSteps(input: DueLadderInput): DueLadderStep[] {
  if (!isLive(input.status) || input.flags.paused || input.flags.cancelled) return [];
  const window = checkWindow(input.window);
  // Plain epoch milliseconds: this runs every 15 minutes for every live notice, and comparing
  // instants this way gives the same answers as Temporal without its cost (review, CI).
  const issued = epochMillisOf(input.issuedAt) + (input.shiftSeconds ?? 0) * 1000;
  const now = epochMillisOf(input.now);
  const dueSteps: { readonly step: NoticeLadderStep; readonly at: number }[] = [];
  for (const step of input.steps) {
    const at = epochMillisPlusHours(issued, step.afterHours);
    if (at <= now) dueSteps.push({ step, at });
  }
  if (dueSteps.length === 0) return [];
  // The window needs a time-zone conversion, so it and the link expiry are worked out only when
  // a reminder not yet done is due.
  let tenantSide: { readonly open: boolean; readonly linksExpired: boolean } | undefined;
  const tenantState = () =>
    (tenantSide ??= {
      open: inSendWindow(input.now, window, input.timeZone),
      linksExpired: input.linksExpireAt != null && now >= epochMillisOf(input.linksExpireAt),
    });
  const out: DueLadderStep[] = [];
  for (const r of input.recipients) {
    const due = dueSteps.filter(({ step }) => !r.doneSteps.has(step.key));
    if (due.length === 0) continue;
    if (recipientAcknowledged(r.recipientId, input.recipients, input.completion)) continue;
    const { open, linksExpired } = due.some((d) => d.step.toTenant)
      ? tenantState()
      : { open: false, linksExpired: false };
    const reminders = open ? due.filter((d) => d.step.toTenant) : [];
    const latest = reminders.at(-1);
    for (const d of due) {
      if (d.step.toTenant && !open && !linksExpired) continue;
      out.push({
        recipientId: r.recipientId,
        step: d.step,
        dueAt: new Date(d.at),
        decision: d.step.toTenant && (linksExpired || d !== latest) ? 'skip' : 'fire',
        idempotencyKey: noticeLadderKey(r.recipientId, d.step.key),
      });
    }
  }
  return out;
}

/**
 * When each step is planned to run, for the tracker ("next reminder 07:00 Tuesday"): its due
 * time, and for a tenant reminder the window's next opening from then.
 */
export function plannedNoticeLadder(input: {
  readonly issuedAt: InstantInput;
  readonly steps: readonly NoticeLadderStep[];
  readonly timeZone: string;
  readonly window: NoticeSendWindow;
  /** As in dueLadderSteps (review D-B). */
  readonly shiftSeconds?: number;
}): { readonly step: NoticeLadderStep; readonly dueAt: Date; readonly runsAt: Date }[] {
  const issued = addSeconds(instantFrom(input.issuedAt), input.shiftSeconds ?? 0);
  return input.steps.map((step) => {
    const at = addHours(issued, step.afterHours);
    return {
      step,
      dueAt: instantToDate(at),
      runsAt: step.toTenant ? nextSendTime(at, input.window, input.timeZone) : instantToDate(at),
    };
  });
}
