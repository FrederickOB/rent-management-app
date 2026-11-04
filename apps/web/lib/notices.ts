import type { NoticeCompose, NoticeDetail } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import { instantFrom, Temporal } from '@rent/domain/dates';
import { money, parseAmount, toDecimal } from '@rent/domain/money';
import { CHANNEL_LABELS } from '@rent/domain/messaging';
import {
  LIVE_STATUSES,
  NOTICE_STATUS_LABELS,
  NOTICE_TYPE_LABELS,
  type NoticeChannel,
  type NoticeChannelMode,
  type NoticeRecordKind,
  type NoticeStatus,
  type NoticeType,
} from '@rent/domain/notices';
import { formatBusinessDate } from './business-dates';
import { errorCode, statusOf } from './errors';

// Legal notices on staff screens (LN-01 to LN-09; M7 plan 4.10). What a notice may say, when it
// may take effect, who it reaches and what each person may do are the API's: the screens read
// the composer's answer, the notice's `actions` and the domain's labels, and say them in words.
// Nothing here ends a tenancy (Act 220 s.17 and s.27).

export type NoticeTypeInfo = Awaited<ReturnType<ApiClient['notices']['types']>>['types'][number];
export type NoticeRow = Awaited<ReturnType<ApiClient['notices']['list']>>[number];
export type NoticeWarning = NoticeCompose['warnings'][number];
export type NoticeEvent = NoticeDetail['events'][number];
export type NoticeRecipient = NoticeDetail['recipients'][number];

// The composer's fields ---------------------------------------------------------------------------

export type FieldKind = 'money' | 'date' | 'time' | 'invoices' | 'longText' | 'text' | 'target';

const DATE_FIELDS = new Set([
  'arrearsAsOf',
  'payBy',
  'effectiveDate',
  'entryDate',
  'remedyBy',
  'leaseEndDate',
  'startDate',
  'endDate',
  'receivedOn',
]);
const LONG_FIELDS = new Set(['particulars', 'reason', 'details']);
/** Set from the notice's target (the property and blocks), not typed. */
const TARGET_FIELDS = new Set(['propertyId', 'blockIds', 'documentId', 'receivedVia']);

/** How a field is entered on the composer. */
export function fieldKind(field: string): FieldKind {
  if (field.endsWith('Minor')) return 'money';
  if (DATE_FIELDS.has(field)) return 'date';
  if (field === 'windowFrom' || field === 'windowTo') return 'time';
  if (field === 'invoiceIds') return 'invoices';
  if (LONG_FIELDS.has(field)) return 'longText';
  if (TARGET_FIELDS.has(field)) return 'target';
  return 'text';
}

/** The fields the composer shows for a type, in the API's order, then the optional details. */
export function composerFields(info: Pick<NoticeTypeInfo, 'requiredFields' | 'type'>): string[] {
  const fields = info.requiredFields.filter((f) => fieldKind(f) !== 'target');
  if (info.type === 'building_wide' && !fields.includes('endDate')) fields.push('endDate');
  if (!fields.includes('details')) fields.push('details');
  return fields;
}

/** The form's values: text as typed, the invoice choices as ids. */
export type FieldDraft = Readonly<Record<string, string | readonly string[]>>;

/** The form for fields the API suggested or a draft holds; amounts show as `1500.00`. */
export function draftOfFields(fields: Readonly<Record<string, unknown>>): FieldDraft {
  const draft: Record<string, string | readonly string[]> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value))
      draft[field] = value.filter((v): v is string => typeof v === 'string');
    else if (
      fieldKind(field) === 'money' &&
      typeof value === 'number' &&
      Number.isSafeInteger(value)
    )
      draft[field] = toDecimal(money(value));
    else if (typeof value === 'string' || typeof value === 'number') draft[field] = String(value);
  }
  return draft;
}

export interface FieldsOut {
  readonly fields: Record<string, unknown>;
  /** Problems the form can see before asking the API, by field. */
  readonly errors: Readonly<Record<string, string>>;
}

/**
 * The fields as the API takes them: amounts as integer pesewas, blanks left out, and for a
 * building-wide notice the property and blocks from its target. The API checks them all again.
 */
export function fieldsOfDraft(
  draft: FieldDraft,
  target: { readonly propertyId?: string | null; readonly blockIds?: readonly string[] } = {},
  type?: NoticeType,
): FieldsOut {
  const fields: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [field, value] of Object.entries(draft)) {
    if (Array.isArray(value)) {
      if (value.length) fields[field] = [...value];
      continue;
    }
    const text = (value as string).trim();
    if (text === '') continue;
    if (fieldKind(field) === 'money') {
      try {
        const amount = parseAmount(text);
        if (amount.amountMinor <= 0) errors[field] = 'Enter an amount above zero';
        else fields[field] = amount.amountMinor;
      } catch {
        errors[field] = 'Enter an amount such as 1500 or 1,500.50';
      }
      continue;
    }
    fields[field] = text;
  }
  if (type === 'building_wide') {
    if (target.propertyId) fields.propertyId = target.propertyId;
    if (target.blockIds?.length) fields.blockIds = [...target.blockIds];
  }
  return { fields, errors };
}

/** What a draft's content is, so a changed draft gets a new idempotency key (M6 lesson). */
export function draftFingerprint(input: {
  readonly type: string;
  readonly subtype: string | null;
  readonly leaseId: string | null;
  readonly propertyId: string | null;
  readonly blockIds: readonly string[];
  readonly fields: Readonly<Record<string, unknown>>;
}): string {
  const fields = Object.keys(input.fields)
    .sort()
    .map((key) => [key, input.fields[key]]);
  return JSON.stringify([
    input.type,
    input.subtype,
    input.leaseId,
    input.propertyId,
    [...input.blockIds].sort(),
    fields,
  ]);
}

/** The API's field problems, by field, for the form; the first message for each field wins. */
export function fieldErrorsOf(
  errors: readonly { readonly field: string; readonly message: string }[],
): Record<string, string> {
  const byField: Record<string, string> = {};
  for (const error of errors) byField[error.field] ??= error.message;
  return byField;
}

// The earliest lawful date and the warnings (plan 4.3) ------------------------------------------

const BASIS_TEXT: Record<NonNullable<NoticeCompose['earliest']>['serviceDateBasis'], string> = {
  electronic_issue: 'the issue date, served electronically under the lease’s clause',
  physical_service: 'the date physical service was recorded',
  planned_issue: 'the planned issue date; the period really runs from physical service',
  issue: 'the issue date',
};

const PERIOD_SOURCE_TEXT: Record<NonNullable<NoticeCompose['earliest']>['periodSource'], string> = {
  none: 'no notice period applies',
  contractual: 'the lease’s notice period',
  statutory: 'the statutory minimum',
};

/** `5 Dec 2026: 30 days (the lease’s notice period) from the issue date, …` */
export function earliestText(earliest: NonNullable<NoticeCompose['earliest']>): string {
  const days = earliest.periodDays === 1 ? '1 day' : `${earliest.periodDays} days`;
  const end = earliest.leaseEndApplied ? ', and not before the lease ends' : '';
  return `${formatBusinessDate(earliest.earliestDate)}: ${days} (${PERIOD_SOURCE_TEXT[earliest.periodSource]}) from ${BASIS_TEXT[earliest.serviceDateBasis]} (${formatBusinessDate(earliest.serviceDate)})${end}.`;
}

/** Whether the stated date holds, in words; null when it does or there is no date yet. */
export function effectiveProblem(check: NoticeCompose['effectiveCheck']): string | null {
  if (!check || check.ok) return null;
  const days = check.shortByDays === 1 ? '1 day' : `${check.shortByDays} days`;
  return `The date is ${days} earlier than the earliest lawful date${check.reason ? `: ${check.reason}` : '.'}`;
}

const WARNING_TITLES: Record<NoticeWarning['code'], string> = {
  statutory_minimum_unverified: 'The statutory notice period is not verified by counsel',
  statutory_minimum_not_set: 'No statutory notice period is recorded',
  statutory_rule_missing: 'No statutory notice period rule is in force',
  assessment_bar_unverified: 'The Rent Officer assessment bar is not verified by counsel',
  no_electronic_service_clause: 'The lease has no electronic-service clause',
  electronic_service_withheld: 'Electronic service is withheld',
  counsel_wording_outstanding: 'The wording is still to come from your lawyer',
  no_period_enforced: 'No notice period is enforced for this type',
};

/** A warning's heading; the API's message is shown under it, with the rule it names. */
export const warningTitle = (warning: Pick<NoticeWarning, 'code'>): string =>
  WARNING_TITLES[warning.code] ?? 'Check this before issuing';

/** Warnings in the order they matter: legal rules first, then service, then wording. */
const WARNING_ORDER: readonly NoticeWarning['code'][] = [
  'statutory_rule_missing',
  'statutory_minimum_unverified',
  'statutory_minimum_not_set',
  'assessment_bar_unverified',
  'no_period_enforced',
  'no_electronic_service_clause',
  'electronic_service_withheld',
  'counsel_wording_outstanding',
];

export function orderedWarnings<T extends Pick<NoticeWarning, 'code'>>(
  warnings: readonly T[],
): T[] {
  const rank = (w: T) => {
    const index = WARNING_ORDER.indexOf(w.code);
    return index === -1 ? WARNING_ORDER.length : index;
  };
  return [...warnings].sort((a, b) => rank(a) - rank(b));
}

/** The s.23 bar in words, or null when it does not apply. */
export function quitBarText(bar: NoticeCompose['quitBar']): string | null {
  if (!bar) return null;
  if (bar.barred && bar.barredUntil)
    return `A Rent Officer assessed this unit on ${bar.latestAssessment ? formatBusinessDate(bar.latestAssessment) : 'a recorded date'}, so no notice to quit may be issued until after ${formatBusinessDate(bar.barredUntil)} (Act 220 s.23).`;
  if (bar.latestAssessment)
    return `The latest Rent Officer assessment, on ${formatBusinessDate(bar.latestAssessment)}, no longer bars a notice to quit.`;
  return null;
}

// Channels and recipients (decisions 4, 5 and 7) ------------------------------------------------

export const CHANNEL_MODE_LABELS: Record<NoticeChannelMode, string> = {
  service: 'Served on it (named in the lease)',
  courtesy: 'Courtesy copy',
  withheld: 'Withheld',
};

export const noticeChannelName = (channel: NoticeChannel): string => CHANNEL_LABELS[channel];

// Statuses, events and the dashboard (LN-03, LN-09) ---------------------------------------------

export const isLiveStatus = (status: NoticeStatus): boolean =>
  (LIVE_STATUSES as readonly string[]).includes(status);

/** Statuses the dashboard counts as open, in order (issued and not closed). */
export const OPEN_STATUSES: readonly NoticeStatus[] = LIVE_STATUSES;

export const AGE_BUCKET_LABELS: Record<'0_7' | '8_14' | '15_30' | 'over_30', string> = {
  '0_7': '0 to 7 days',
  '8_14': '8 to 14 days',
  '15_30': '15 to 30 days',
  over_30: 'Over 30 days',
};

/** What each kind of notice record says on the tracker. */
export const NOTICE_RECORD_KIND_LABELS: Record<NoticeRecordKind, string> = {
  submitted: 'Submitted for approval',
  returned_to_draft: 'Returned to draft',
  approved: 'Approved',
  cancelled: 'Discarded',
  sent: 'Sent',
  delivered: 'Delivered',
  opened: 'Opened',
  reminded: 'Reminder sent',
  escalated: 'Escalated to physical service',
  served: 'Served',
  signed: 'Signed: receipt acknowledged',
  closed: 'Closed',
  received: 'Received from the tenant',
  ladder_paused: 'Reminders paused',
  ladder_resumed: 'Reminders resumed',
  ladder_cancelled: 'Reminders cancelled',
  channel_withheld: 'Channel withheld',
  step_skipped: 'Reminder skipped',
  manager_alerted: 'Manager alerted',
  task_created: 'Task created',
  document_ready: 'Document frozen',
  service_pack_ready: 'Service pack ready',
  served_too_late: 'Served too late for its date',
  link_issued: 'Link handed over',
};

export const recordKindLabel = (kind: string): string =>
  NOTICE_RECORD_KIND_LABELS[kind as NoticeRecordKind] ?? kind.replace(/_/g, ' ');

/** The notice's events by recipient, oldest first; key `null` holds the notice-wide events. */
export function eventsByRecipient(
  events: readonly NoticeEvent[],
): Map<string | null, NoticeEvent[]> {
  const groups = new Map<string | null, NoticeEvent[]>();
  const sorted = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const event of sorted) {
    const key = event.recipientId;
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
  }
  return groups;
}

/** `N-000123 · Notice to quit` or `Draft · Notice to quit`. */
export function noticeTitle(notice: {
  readonly number: string | null;
  readonly type: NoticeType;
  readonly status: NoticeStatus;
}): string {
  const label = NOTICE_TYPE_LABELS[notice.type];
  return notice.number
    ? `${notice.number} · ${label}`
    : `${NOTICE_STATUS_LABELS[notice.status]} · ${label}`;
}

/**
 * Decision 8 and plan 4.3: a notice to quit issues itself when its approval completes; when the
 * date or the s.23 bar no longer held then, it went back to draft with the reason while the
 * approval still reads approved. The tracker says so plainly.
 */
export function approvedButReturned(
  notice: Pick<NoticeDetail, 'status' | 'approval' | 'blockers'>,
): boolean {
  return notice.status === 'draft' && notice.approval?.status === 'approved';
}

// Named refusals (M6 lesson: handle named 409 and 422 codes) -------------------------------------

export type NoticeRefusal =
  'not_on_plan' | 'quit_disabled' | 'blocked' | 'not_editable' | 'key_reused' | 'other';

/** What a refused notice write means for the screen. */
export function noticeRefusal(error: unknown): NoticeRefusal {
  const status = statusOf(error);
  const code = errorCode(error);
  if (status === 403 && code === 'NOT_ON_PLAN') return 'not_on_plan';
  if (code === 'IDEMPOTENCY_KEY_REUSED') return 'key_reused';
  // Domain codes reach the client upper-cased: `notice.quit_not_enabled` as NOTICE.QUIT_NOT_ENABLED
  // (or with an underscore for the dot, depending on the route).
  if (code.includes('QUIT_NOT_ENABLED')) return 'quit_disabled';
  if (code.includes('FROZEN') || code.includes('IN_APPROVAL')) return 'not_editable';
  if (status === 409 || status === 422) return 'blocked';
  return 'other';
}

// The ladder per type, the sending window and link expiry (plan 4.9) ------------------------------

export interface LadderDraft {
  readonly reminderHours: string;
  readonly inPersonHours: string;
  readonly escalationHours: string;
}

export interface LadderConfig {
  readonly reminderHours: readonly number[];
  readonly inPersonHours: number | null;
  readonly escalationHours: number | null;
}

export const LADDER_HOURS_MAX = 24 * 60;

export function ladderDraftOf(config: LadderConfig): LadderDraft {
  return {
    reminderHours: config.reminderHours.join(', '),
    inPersonHours: config.inPersonHours === null ? '' : String(config.inPersonHours),
    escalationHours: config.escalationHours === null ? '' : String(config.escalationHours),
  };
}

const hoursOf = (text: string): number | null | 'bad' => {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d{1,4}$/.test(trimmed)) return 'bad';
  const value = Number.parseInt(trimmed, 10);
  return value >= 1 && value <= LADDER_HOURS_MAX ? value : 'bad';
};

/** A ladder as typed, checked against the settings contract's bounds; the API checks again. */
export function ladderConfigOf(
  draft: LadderDraft,
): { readonly config: LadderConfig } | { readonly error: string } {
  const reminders: number[] = [];
  for (const part of draft.reminderHours.split(/[\s,]+/).filter(Boolean)) {
    const value = hoursOf(part);
    if (value === 'bad' || value === null)
      return { error: `Reminder hours are whole numbers from 1 to ${LADDER_HOURS_MAX}` };
    reminders.push(value);
  }
  if (reminders.length > 6) return { error: 'Keep at most 6 reminders' };
  const inPerson = hoursOf(draft.inPersonHours);
  const escalation = hoursOf(draft.escalationHours);
  if (inPerson === 'bad' || escalation === 'bad')
    return { error: `Hours are whole numbers from 1 to ${LADDER_HOURS_MAX}, or blank for none` };
  const sorted = [...new Set(reminders)].sort((a, b) => a - b);
  if (escalation !== null && inPerson !== null && inPerson >= escalation)
    return { error: 'The in-person step comes before escalation' };
  if (escalation !== null && sorted.some((h) => h >= escalation))
    return { error: 'Every reminder comes before escalation' };
  return {
    config: { reminderHours: sorted, inPersonHours: inPerson, escalationHours: escalation },
  };
}

/** `24 h, 72 h · in person at 5 days · escalation at 7 days`. */
export function ladderSummary(config: LadderConfig): string {
  const hours = (h: number) => (h % 24 === 0 ? `${h / 24} ${h === 24 ? 'day' : 'days'}` : `${h} h`);
  const parts = [
    config.reminderHours.length
      ? `Reminders at ${config.reminderHours.map(hours).join(', ')}`
      : 'No reminders',
  ];
  if (config.inPersonHours !== null) parts.push(`in person at ${hours(config.inPersonHours)}`);
  if (config.escalationHours !== null) parts.push(`escalation at ${hours(config.escalationHours)}`);
  return parts.join(' · ');
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The sending window for ladder messages (decision 11): from before to, both `HH:MM`. */
export function sendWindowProblem(from: string, to: string): string | null {
  if (!TIME.test(from) || !TIME.test(to)) return 'Use times such as 07:00 and 20:00';
  if (from >= to) return 'The window must end after it starts, on the same day';
  return null;
}

export const LINK_EXPIRY_MIN = 30;
export const LINK_EXPIRY_MAX = 366;

export function linkExpiryProblem(text: string): string | null {
  const value = /^\d{1,3}$/.test(text.trim()) ? Number.parseInt(text.trim(), 10) : NaN;
  return value >= LINK_EXPIRY_MIN && value <= LINK_EXPIRY_MAX
    ? null
    : `Use a whole number of days from ${LINK_EXPIRY_MIN} to ${LINK_EXPIRY_MAX}`;
}

// The tenant timeline (★ every status change shows on it) ---------------------------------------

export interface TimelineNotice {
  readonly noticeId: string | null;
  readonly number: string | null;
  readonly typeLabel: string | null;
  readonly kind: string;
  readonly outcomeLabel: string | null;
}

const NOTICE_TIMELINE_KINDS = new Set([
  'sent',
  'delivered',
  'opened',
  'reminded',
  'escalated',
  'served',
  'signed',
  'closed',
  'received',
]);

/**
 * A `notice.<kind>` event on the tenant's timeline, or null for any other event. Without `data`
 * (a reader without notices.read) it still says what happened.
 */
export function noticeOfTimelineEvent(
  event: { readonly action: string; readonly data: Readonly<Record<string, unknown>> | null },
  outcomeLabels: Readonly<Record<string, string>>,
): TimelineNotice | null {
  const [record, kind] = event.action.split('.', 2);
  if (record !== 'notice' || !kind || !NOTICE_TIMELINE_KINDS.has(kind)) return null;
  const data = event.data ?? {};
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const outcome = text(data.outcome);
  return {
    noticeId: text(data.noticeId),
    number: text(data.number),
    typeLabel: text(data.typeLabel),
    kind,
    outcomeLabel: outcome ? (outcomeLabels[outcome] ?? outcome) : null,
  };
}

/** `Notice N-000123 (Notice to quit): Escalated to physical service`. */
export function timelineNoticeText(notice: TimelineNotice): string {
  const name = notice.number ? `Notice ${notice.number}` : 'A notice';
  const type = notice.typeLabel ? ` (${notice.typeLabel})` : '';
  const what = recordKindLabel(notice.kind);
  const outcome = notice.kind === 'closed' && notice.outcomeLabel ? `: ${notice.outcomeLabel}` : '';
  return `${name}${type}: ${what}${outcome}`;
}

// Times typed on the service form (plan 4.7): company time in, a UTC instant out ---------------

/** `2026-11-04T09:30` typed in the company's time zone, as the instant the API takes; or null. */
export function instantOfLocal(local: string, timeZone: string): string | null {
  try {
    return Temporal.PlainDateTime.from(local).toZonedDateTime(timeZone).toInstant().toString();
  } catch {
    return null;
  }
}

/** Now in the company's time zone, as a `datetime-local` value (`2026-11-04T09:30`). */
export function localNow(timeZone: string, now: Date = new Date()): string {
  return instantFrom(now)
    .toZonedDateTimeISO(timeZone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'minute' });
}

// The ladder's steps and controls (LN-05) --------------------------------------------------------

export const LADDER_STEP_LABELS: Record<
  'reminder' | 'manager_alert' | 'caretaker_task' | 'escalate',
  string
> = {
  reminder: 'Reminder to the tenant',
  manager_alert: 'Alert to the manager',
  caretaker_task: 'Task: remind the tenant in person',
  escalate: 'Escalation: the physical service pack',
};

/**
 * The ladder controls that make sense now (LN-05): pause or cancel a running ladder, resume or
 * cancel a paused one, nothing once cancelled. Shown only when the API allows controlling it.
 */
export function ladderControls(ladder: {
  readonly paused: boolean;
  readonly cancelled: boolean;
}): ('pause' | 'resume' | 'cancel')[] {
  if (ladder.cancelled) return [];
  return ladder.paused ? ['resume', 'cancel'] : ['pause', 'cancel'];
}

/** How a tenant's own notice arrived (decision 13); the domain holds the values only. */
export const RECEIVED_VIA_LABELS: Record<
  'in_person' | 'post' | 'email' | 'whatsapp' | 'sms' | 'other',
  string
> = {
  in_person: 'Handed over in person',
  post: 'By post',
  email: 'By email',
  whatsapp: 'On WhatsApp',
  sms: 'By SMS',
  other: 'Another way',
};
