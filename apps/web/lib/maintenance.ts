import type { MaintenanceJob, MaintenanceJobDetail } from '@rent/contracts';
import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_CATEGORY_LABELS,
  MAINTENANCE_JOB_STATUSES,
  MAINTENANCE_JOB_STATUS_LABELS,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_PRIORITY_LABELS,
  MEDIA_MAX_FILES_PER_REQUEST,
  MEDIA_RULES,
  OPEN_MAINTENANCE_STATUSES,
  mediaKindOf,
  type MaintenanceAttachmentStage,
  type MaintenanceCategory,
  type MaintenanceJobStatus,
  type MaintenancePriority,
  type MediaKind,
} from '@rent/domain/maintenance';
import { instantFrom } from '@rent/domain/dates';
import { errorCode } from './errors';
import { formatTime } from './format';
import { formatMinor } from './tenancy-format';

// The maintenance board and job detail (MI-01 to MI-06, CM-04; M8 plan 4.11). The API decides
// what each reader may do (the job's `actions`); these are the screen's words and the forms'
// checks, which the API makes again.

export type MaintenanceEvent = MaintenanceJobDetail['events'][number];
export type MaintenanceAttachment = MaintenanceJobDetail['attachments'][number];
export type MaintenanceActions = MaintenanceJobDetail['actions'];

export const PRIORITY_OPTIONS = MAINTENANCE_PRIORITIES.map((p) => ({
  value: p,
  label: MAINTENANCE_PRIORITY_LABELS[p],
}));
export const CATEGORY_OPTIONS = MAINTENANCE_CATEGORIES.map((c) => ({
  value: c,
  label: MAINTENANCE_CATEGORY_LABELS[c],
}));

export const priorityOf = (value: string): MaintenancePriority | null =>
  MAINTENANCE_PRIORITIES.find((p) => p === value) ?? null;
export const categoryOf = (value: string): MaintenanceCategory | null =>
  MAINTENANCE_CATEGORIES.find((c) => c === value) ?? null;
export const jobStatusOf = (value: string): MaintenanceJobStatus | null =>
  MAINTENANCE_JOB_STATUSES.find((s) => s === value) ?? null;

export const STAGE_LABELS: Record<MaintenanceAttachmentStage, string> = {
  report: 'With the report',
  before: 'Before the work',
  after: 'After the work',
  other: 'Other',
};

/**
 * An emergency: set by staff, or flagged by the tenant and not yet triaged (decision 5). A job a
 * manager lowered from emergency is no longer one, even though the tenant flagged it.
 */
export function isEmergency(job: Pick<MaintenanceJob, 'priority' | 'emergencyFlag'>): boolean {
  return job.priority === 'emergency' || (job.priority === null && job.emergencyFlag);
}

// The board -----------------------------------------------------------------------------------

export interface BoardFilters {
  /** `open` (reported to work done), `all`, or one status. */
  readonly status: 'open' | 'all' | MaintenanceJobStatus;
  readonly priority: MaintenancePriority | '';
  readonly category: MaintenanceCategory | '';
  readonly propertyId: string;
  readonly overdue: boolean;
  /** `staff:<personId>` or `artisan:<artisanId>`, or empty. */
  readonly assignee: string;
  readonly search: string;
}

export const DEFAULT_BOARD_FILTERS: BoardFilters = {
  status: 'open',
  priority: '',
  category: '',
  propertyId: '',
  overdue: false,
  assignee: '',
  search: '',
};

export type BoardQuery = {
  propertyId?: string;
  status?: MaintenanceJobStatus;
  /** Query flags travel as text (`z.stringbool`). */
  open?: 'true';
  priority?: MaintenancePriority;
  category?: MaintenanceCategory;
  overdue?: 'true';
  assigneePersonId?: string;
  artisanId?: string;
  search?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The list call for the filters chosen: only what is set is sent. */
export function boardQuery(filters: BoardFilters): BoardQuery {
  const query: BoardQuery = {};
  if (filters.status === 'open') query.open = 'true';
  else if (filters.status !== 'all') query.status = filters.status;
  if (filters.priority) query.priority = filters.priority;
  if (filters.category) query.category = filters.category;
  if (UUID.test(filters.propertyId)) query.propertyId = filters.propertyId;
  if (filters.overdue) query.overdue = 'true';
  const id = filters.assignee.slice(filters.assignee.indexOf(':') + 1);
  if (UUID.test(id)) {
    if (filters.assignee.startsWith('staff:')) query.assigneePersonId = id;
    else if (filters.assignee.startsWith('artisan:')) query.artisanId = id;
  }
  const search = filters.search.trim().slice(0, 100);
  if (search) query.search = search;
  return query;
}

export interface BoardGroup<J> {
  readonly status: MaintenanceJobStatus;
  readonly label: string;
  readonly jobs: readonly J[];
}

/**
 * The board by status, in the job's order of steps, open steps first. Emergencies come first in
 * each group; otherwise the API's order (newest first) is kept. Empty groups are left out.
 */
export function groupByStatus<
  J extends Pick<MaintenanceJob, 'status' | 'priority' | 'emergencyFlag'>,
>(jobs: readonly J[]): BoardGroup<J>[] {
  const order: readonly MaintenanceJobStatus[] = [
    ...OPEN_MAINTENANCE_STATUSES,
    ...MAINTENANCE_JOB_STATUSES.filter((s) => !OPEN_MAINTENANCE_STATUSES.includes(s)),
  ];
  return order
    .map((status) => {
      const inGroup = jobs.filter((job) => job.status === status);
      const urgent = inGroup.filter((job) => isEmergency(job));
      const rest = inGroup.filter((job) => !isEmergency(job));
      return { status, label: MAINTENANCE_JOB_STATUS_LABELS[status], jobs: [...urgent, ...rest] };
    })
    .filter((group) => group.jobs.length > 0);
}

/** Who a job is with, in words. */
export function assigneeLabel(assignee: MaintenanceJob['assignee']): string {
  if (!assignee) return 'Not assigned';
  if (assignee.kind === 'staff') return assignee.name;
  const answer =
    assignee.response === 'accepted'
      ? 'accepted'
      : assignee.response === 'declined'
        ? 'declined'
        : 'not answered yet';
  return `${assignee.name} (artisan, ${answer})`;
}

/** The value of an assignee in the filter and the assign form. */
export function assigneeKey(assignee: NonNullable<MaintenanceJob['assignee']>): string {
  return assignee.kind === 'staff' ? `staff:${assignee.personId}` : `artisan:${assignee.artisanId}`;
}

/** The assignees seen on these jobs, for the filter of someone who cannot list staff. */
export function assigneesSeen(
  jobs: readonly Pick<MaintenanceJob, 'assignee'>[],
): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const job of jobs) if (job.assignee) seen.set(assigneeKey(job.assignee), job.assignee.name);
  return [...seen].map(([value, label]) => ({ value, label }));
}

export type TargetState = 'met' | 'overdue' | 'due';

/**
 * Where a target stands, as the API worked it out (decision 4): met once responded or done,
 * overdue when the API names it as the target missed. The client's clock is never used.
 */
export function targetState(
  targets: NonNullable<MaintenanceJob['targets']>,
  kind: 'respond' | 'complete',
): TargetState {
  const met = kind === 'respond' ? targets.respondedAt !== null : targets.workDoneAt !== null;
  if (met) return 'met';
  return targets.overdue === kind ? 'overdue' : 'due';
}

/** "Respond by 5 Nov 2026, 14:00 GMT (missed)". */
export function targetText(
  targets: NonNullable<MaintenanceJob['targets']>,
  kind: 'respond' | 'complete',
  timeZone: string,
): string {
  const state = targetState(targets, kind);
  const at = formatTime(kind === 'respond' ? targets.respondBy : targets.completeBy, timeZone);
  const name = kind === 'respond' ? 'Respond by' : 'Complete by';
  const suffix = state === 'met' ? ' (met)' : state === 'overdue' ? ' (missed)' : '';
  return `${name} ${at}${suffix}`;
}

/** A job with a target missed and not yet met. */
export const isOverdue = (job: Pick<MaintenanceJob, 'targets'>): boolean =>
  job.targets?.overdue != null;

/** "GH₵0.00" until an expense is linked (decision 8). */
export const costText = (job: Pick<MaintenanceJob, 'costMinor'>): string =>
  formatMinor(job.costMinor);

// The timeline --------------------------------------------------------------------------------

export const EVENT_LABELS: Record<MaintenanceEvent['kind'], string> = {
  reported: 'Reported',
  triaged: 'Triaged',
  priority_changed: 'Priority changed',
  assigned: 'Assigned',
  unassigned: 'Taken back',
  accepted: 'Accepted by the artisan',
  declined: 'Declined by the artisan',
  visit_planned: 'Visit planned',
  started: 'Work started',
  work_done: 'Work done',
  confirmed: 'Confirmed by the tenant',
  disputed: 'Disputed by the tenant',
  closed: 'Closed',
  auto_closed: 'Closed without a reply from the tenant',
  cancelled: 'Cancelled',
  note: 'Note',
  media_added: 'Files added',
  alerted: 'Emergency alert sent',
  sla_warned: 'Target warning',
  tenant_updated: 'Tenant told',
  expense_linked: 'Expense linked',
};

const ACTOR_LABELS: Record<MaintenanceEvent['actorKind'], string> = {
  staff: 'Staff',
  artisan: 'Artisan',
  tenant: 'Tenant',
  system: 'Automatic',
};

/** Who did it: their name, or what kind of actor they were. */
export const eventActor = (event: Pick<MaintenanceEvent, 'actorKind' | 'actorName'>): string =>
  event.actorName?.trim() || ACTOR_LABELS[event.actorKind];

const str = (data: Record<string, unknown>, key: string): string | null => {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const TARGET_WORDS: Record<string, string> = {
  respond: 'the response target',
  complete: 'the completion target',
};
const SLA_STAGE_WORDS: Record<string, string> = {
  due_soon: 'about to be missed',
  missed: 'missed',
};
const ASSIGNEE_KIND_WORDS: Readonly<Record<string, string>> = {
  staff: '',
  artisan: ' (artisan, sent a job sheet)',
};

const REPAIR_SOURCES: Readonly<Record<string, string>> = {
  whatsapp: 'On WhatsApp',
  app: 'In the tenant app',
  sms: 'By SMS',
  email: 'By email',
  staff: 'Logged by staff',
};

const CHANNEL_WORDS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'email',
  app: 'the app',
};

const priorityWord = (value: string | null): string | null => {
  const p = value ? priorityOf(value) : null;
  return p ? MAINTENANCE_PRIORITY_LABELS[p] : null;
};

const VIA_WORDS: Record<string, string> = {
  app: 'in the tenant app',
  whatsapp: 'on WhatsApp',
  sms: 'by SMS',
  staff: 'recorded by staff',
};

const STEP_WORDS: Record<string, string> = {
  assigned: 'that it was assigned',
  visit_planned: 'about the visit',
  work_done: 'the work is done, and asked to confirm',
  closed: 'that it is closed',
};

const timeOf = (value: string | null, timeZone: string): string | null => {
  if (!value) return null;
  try {
    instantFrom(value);
    return formatTime(value, timeZone);
  } catch {
    // A malformed time is left out rather than shown wrongly.
    return null;
  }
};

const countOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * What an event says beyond its kind, read from the fields the API records with it (the backend's
 * keys per kind; never a phone, email or ID number). Plain text only: the screen never renders it
 * as HTML. Unknown fields are left out.
 */
export function eventDetail(
  event: Pick<MaintenanceEvent, 'kind' | 'data'>,
  timeZone: string,
): string | null {
  const data = event.data ?? {};
  const parts: string[] = [];
  const via = VIA_WORDS[str(data, 'via') ?? ''];
  switch (event.kind) {
    case 'reported': {
      const source = str(data, 'source');
      if (source && source in REPAIR_SOURCES) parts.push(REPAIR_SOURCES[source]!);
      break;
    }
    case 'triaged': {
      const priority = priorityWord(str(data, 'priority'));
      const category = categoryOf(str(data, 'category') ?? '');
      if (priority) parts.push(priority);
      if (category) parts.push(MAINTENANCE_CATEGORY_LABELS[category]);
      break;
    }
    case 'priority_changed': {
      const from = priorityWord(str(data, 'from'));
      const to = priorityWord(str(data, 'to') ?? str(data, 'priority'));
      if (from && to) parts.push(`${from} to ${to}`);
      else if (to) parts.push(`Now ${to.toLowerCase()}`);
      break;
    }
    case 'assigned': {
      const name = str(data, 'assigneeName');
      const kind = str(data, 'assigneeKind');
      if (name) parts.push(`${name}${ASSIGNEE_KIND_WORDS[kind ?? ''] ?? ''}`);
      const due = timeOf(str(data, 'dueAt'), timeZone);
      if (due) parts.push(`due ${due}`);
      break;
    }
    case 'unassigned':
    case 'accepted':
    case 'declined': {
      const name = str(data, 'assigneeName');
      if (name) parts.push(name);
      break;
    }
    case 'visit_planned': {
      const at = timeOf(str(data, 'visitAt'), timeZone);
      if (at) parts.push(at);
      break;
    }
    case 'started': {
      const count = countOf(data.count);
      if (count) parts.push(`${count} before ${count === 1 ? 'photo' : 'photos'}`);
      break;
    }
    case 'work_done': {
      const count = countOf(data.count);
      if (count) parts.push(`${count} after ${count === 1 ? 'photo' : 'photos'}`);
      break;
    }
    case 'confirmed':
    case 'disputed':
    case 'closed':
      if (via) parts.push(`${via[0]!.toUpperCase()}${via.slice(1)}`);
      break;
    case 'auto_closed': {
      const days = countOf(data.days);
      if (days)
        parts.push(`No reply ${days} ${days === 1 ? 'day' : 'days'} after the work was done`);
      break;
    }
    case 'sla_warned': {
      const target = TARGET_WORDS[str(data, 'target') ?? ''];
      const stage = SLA_STAGE_WORDS[str(data, 'stage') ?? ''];
      if (target && stage) parts.push(`${target[0]!.toUpperCase()}${target.slice(1)} is ${stage}`);
      const due = timeOf(str(data, 'dueAt'), timeZone);
      if (due) parts.push(`due ${due}`);
      break;
    }
    case 'alerted': {
      const name = str(data, 'recipientName');
      const channels = Array.isArray(data.channels)
        ? data.channels.filter((c): c is string => typeof c === 'string' && c in CHANNEL_WORDS)
        : [];
      if (name) parts.push(name);
      if (channels.length > 0)
        parts.push(`by ${channels.map((c) => CHANNEL_WORDS[c]).join(' and ')}`);
      break;
    }
    case 'media_added': {
      const count = countOf(data.count);
      const stage = str(data, 'stage');
      const known =
        stage && stage in STAGE_LABELS ? STAGE_LABELS[stage as MaintenanceAttachmentStage] : null;
      if (count)
        parts.push(
          `${count} ${count === 1 ? 'file' : 'files'}${known ? `, ${known.toLowerCase()}` : ''}`,
        );
      break;
    }
    case 'tenant_updated': {
      const step = STEP_WORDS[str(data, 'step') ?? ''];
      if (step) parts.push(`Told ${step}`);
      break;
    }
    case 'expense_linked': {
      const amount = data.amountMinor;
      const supplier = str(data, 'supplierName');
      if (typeof amount === 'number' && Number.isSafeInteger(amount))
        parts.push(formatMinor(amount));
      if (supplier) parts.push(supplier);
      break;
    }
    default:
      break;
  }
  for (const key of ['completionNote', 'beforePhotoReason', 'reason', 'note']) {
    const text = str(data, key);
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * What the emergency alerts actually did (review WEB 7), from the timeline's `alerted` events, one
 * per recipient: who was alerted and on which channels. Nothing is claimed that was not sent.
 */
export function emergencyAlertText(
  events: readonly Pick<MaintenanceEvent, 'kind' | 'data'>[],
): string {
  const alerts = events.filter((e) => e.kind === 'alerted');
  if (alerts.length === 0) return 'No emergency alert has been recorded on this job yet.';
  const channels = new Set<string>();
  const names = new Set<string>();
  for (const alert of alerts) {
    const data = alert.data ?? {};
    if (Array.isArray(data.channels))
      for (const c of data.channels)
        if (typeof c === 'string' && c in CHANNEL_WORDS) channels.add(c);
    const name = str(data, 'recipientName');
    if (name) names.add(name);
  }
  const people =
    names.size > 0
      ? [...names].join(', ')
      : `${alerts.length} ${alerts.length === 1 ? 'person' : 'people'}`;
  const on = ['whatsapp', 'sms', 'email', 'app']
    .filter((c) => channels.has(c))
    .map((c) => CHANNEL_WORDS[c]);
  return on.length > 0 ? `Alerted: ${people}, by ${on.join(' and ')}.` : `Alerted: ${people}.`;
}

// Forms -------------------------------------------------------------------------------------

type Errors<F extends string> = Partial<Record<F, string>>;

const length = (text: string) => text.trim().length;

export function triageProblems(draft: {
  readonly priority: string;
  readonly category: string;
}): Errors<'priority' | 'category'> {
  const errors: Errors<'priority' | 'category'> = {};
  if (!priorityOf(draft.priority)) errors.priority = 'Choose the priority';
  if (!categoryOf(draft.category)) errors.category = 'Choose the category';
  return errors;
}

/** A reason kept with the record: 3 to `max` characters. */
export function reasonProblem(text: string, max = 500): string | null {
  if (length(text) < 3) return 'Give the reason, at least 3 characters';
  if (length(text) > max) return `Use at most ${max} characters`;
  return null;
}

export function noteProblem(text: string): string | null {
  if (length(text) < 2) return 'Write the note';
  if (length(text) > 2000) return 'Use at most 2,000 characters';
  return null;
}

/**
 * Starting work (MI-06, decision 7): a before photo, or the reason there is none (for example
 * "emergency: no time"), which is audited.
 */
export function startProblems(draft: {
  readonly photoCount: number;
  readonly reason: string;
}): Errors<'photos' | 'reason'> {
  if (draft.photoCount > MEDIA_MAX_FILES_PER_REQUEST)
    return { photos: `Add at most ${MEDIA_MAX_FILES_PER_REQUEST} files at a time` };
  if (draft.photoCount > 0) return {};
  if (!draft.reason.trim())
    return {
      photos: 'Add a before photo, or say why there is none',
      reason: 'Say why there is no before photo',
    };
  const reason = reasonProblem(draft.reason);
  return reason ? { reason } : {};
}

/**
 * Marking work done (MI-06, ★): at least one after photo and a completion note, both always
 * required. The API and the database refuse it without them too.
 */
export function completeProblems(draft: {
  readonly photoCount: number;
  readonly note: string;
}): Errors<'photos' | 'note'> {
  const errors: Errors<'photos' | 'note'> = {};
  if (draft.photoCount < 1) errors.photos = 'Add at least one photo of the finished work';
  else if (draft.photoCount > MEDIA_MAX_FILES_PER_REQUEST)
    errors.photos = `Add at most ${MEDIA_MAX_FILES_PER_REQUEST} files at a time`;
  if (length(draft.note) < 3) errors.note = 'Write what was done, at least 3 characters';
  else if (length(draft.note) > 2000) errors.note = 'Use at most 2,000 characters';
  return errors;
}

/** The tenant's answer recorded for them: a dispute needs what is still wrong. */
export function responseProblems(draft: {
  readonly response: string;
  readonly reason: string;
}): Errors<'response' | 'reason'> {
  if (draft.response === 'confirmed') return {};
  if (draft.response !== 'disputed') return { response: 'Choose what the tenant said' };
  const reason = reasonProblem(draft.reason, 1000);
  return reason ? { reason: 'Say what the tenant says is still wrong, at least 3 characters' } : {};
}

/** Where the API's refusals belong on the forms (plan 4.2, contract errors). */
export const MAINTENANCE_FIELD_OF_CODE: Readonly<Record<string, 'photos' | 'note' | 'reason'>> = {
  MAINTENANCE_AFTER_PHOTO_REQUIRED: 'photos',
  MAINTENANCE_COMPLETION_NOTE_REQUIRED: 'note',
  MAINTENANCE_BEFORE_PHOTO_REQUIRED: 'photos',
  MAINTENANCE_REASON_REQUIRED: 'reason',
};

const MAINTENANCE_MESSAGES: Readonly<Record<string, string>> = {
  MAINTENANCE_TRANSITION:
    'The job has moved on since this page loaded, so that step no longer applies. The page has been refreshed.',
  MAINTENANCE_AFTER_PHOTO_REQUIRED: 'Add at least one photo of the finished work.',
  MAINTENANCE_COMPLETION_NOTE_REQUIRED: 'Write a completion note.',
  MAINTENANCE_BEFORE_PHOTO_REQUIRED: 'Add a before photo, or say why there is none.',
  MAINTENANCE_REASON_REQUIRED: 'Give the reason.',
  MAINTENANCE_TRIAGE_INCOMPLETE: 'Set the priority and the category first.',
  TENANT_CONFIRMS:
    'This job has a tenant, so it closes when they confirm the work, or by itself after the auto-close days.',
  NO_TENANT: 'This job has no tenant to answer for. Close it once the work is checked.',
  MEDIA_TYPE_MISMATCH:
    'One of the files is not what its name says (for example a renamed file). Choose the original photo, video or voice note.',
  MEDIA_TOO_LARGE: 'One of the files is too large.',
  MEDIA_TOO_LONG: 'One of the recordings is too long.',
  MEDIA_TYPE_NOT_ALLOWED: 'One of the files is not a photo, video or voice note this accepts.',
  MEDIA_DURATION_REQUIRED:
    'We could not tell how long a recording is. Choose another file, or send it from the tenant app or WhatsApp.',
};

/** The words for a named refusal, or null to show the API's own. */
export function maintenanceMessage(error: unknown): string | null {
  return MAINTENANCE_MESSAGES[errorCode(error)] ?? null;
}

const STALE_CODES: ReadonlySet<string> = new Set([
  'MAINTENANCE_TRANSITION',
  // The job's tenant is not what the page showed: closing it versus recording their answer.
  'TENANT_CONFIRMS',
  'NO_TENANT',
]);

/** A refusal that means the job changed under this page, so it reloads. */
export const isStaleStep = (error: unknown): boolean => STALE_CODES.has(errorCode(error));

// Media (decision 2) ----------------------------------------------------------------------------

/** Names some browsers give these types, mapped to the ones the rules use. */
const TYPE_ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': 'image/jpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/mp4a-latm': 'audio/mp4',
  'audio/x-aac': 'audio/aac',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/opus': 'audio/ogg',
  'audio/3gpp': 'audio/amr',
  'video/3gp': 'video/3gpp',
};

/** By the file's ending, for a browser that gives no type (often AMR, 3GP or M4A). */
const TYPE_OF_ENDING: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  '3gp': 'video/3gpp',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  amr: 'audio/amr',
  pdf: 'application/pdf',
};

/** The type to declare for a chosen file; the API checks its first bytes anyway. */
export function declaredMediaType(file: { readonly name: string; readonly type: string }): string {
  const type = file.type.toLowerCase();
  if (type) return TYPE_ALIASES[type] ?? type;
  const ending = file.name.toLowerCase().split('.').pop() ?? '';
  return TYPE_OF_ENDING[ending] ?? '';
}

const KIND_NAMES: Record<MediaKind, string> = {
  image: 'A photo',
  video: 'A video',
  audio: 'A voice note',
  document: 'A document',
};

const megabytes = (bytes: number) => `${bytes / 1_000_000} MB`;

/** What a picker takes: every type of the kinds given. */
export function mediaAccept(kinds: readonly MediaKind[]): string {
  return kinds.flatMap((kind) => MEDIA_RULES[kind].contentTypes).join(',');
}

/** "Photos (JPEG, PNG or WebP, 10 MB), videos (90 seconds, 50 MB)…" for a picker's hint. */
export function mediaHint(kinds: readonly MediaKind[]): string {
  const parts = kinds.map((kind) => {
    const rule = MEDIA_RULES[kind];
    if (kind === 'image') return `photos up to ${megabytes(rule.maxBytes)}`;
    if (kind === 'video')
      return `videos up to ${rule.maxSeconds ?? 0} seconds and ${megabytes(rule.maxBytes)}`;
    if (kind === 'audio')
      return `voice notes up to ${(rule.maxSeconds ?? 0) / 60} minutes and ${megabytes(rule.maxBytes)}`;
    return `PDFs up to ${megabytes(rule.maxBytes)}`;
  });
  const text =
    parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
  return `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}. At most ${MEDIA_MAX_FILES_PER_REQUEST} at a time.`;
}

/**
 * Why a chosen file cannot be added, before anything is sent: its kind, size and (video, voice
 * note) length, by the domain's rules. `durationSeconds` is null when the browser could not read
 * it; the API needs it, so such a recording is refused here with a way out.
 */
export function mediaProblem(
  file: { readonly name: string; readonly type: string; readonly size: number },
  kinds: readonly MediaKind[],
  durationSeconds: number | null,
): string | null {
  const kind = mediaKindOf(declaredMediaType(file));
  const label = file.name || 'This file';
  if (!kind || !kinds.includes(kind))
    return kinds.length === 1 && kinds[0] === 'image'
      ? `${label} is not a JPEG, PNG or WebP photo.`
      : `${label} is not a photo, video or voice note this accepts.`;
  const rule = MEDIA_RULES[kind];
  if (file.size === 0) return `${label} is empty.`;
  if (file.size > rule.maxBytes)
    return `${KIND_NAMES[kind]} can be at most ${megabytes(rule.maxBytes)}; ${label} is larger.`;
  if (rule.maxSeconds !== undefined) {
    if (durationSeconds === null || !(durationSeconds > 0))
      return `We could not tell how long ${label} is. Choose another recording, or send it from the tenant app or WhatsApp.`;
    if (durationSeconds > rule.maxSeconds)
      return kind === 'video'
        ? `A video can be at most ${rule.maxSeconds} seconds; ${label} is longer.`
        : `A voice note can be at most ${rule.maxSeconds / 60} minutes; ${label} is longer.`;
  }
  return null;
}

/** Whether a file needs its length read before it is declared. */
export const needsDuration = (file: { readonly name: string; readonly type: string }): boolean => {
  const kind = mediaKindOf(declaredMediaType(file));
  return kind !== null && MEDIA_RULES[kind].maxSeconds !== undefined;
};

/** How a file is shown: the browser's own players for video and voice notes (decision 2). */
export function playerOf(
  attachment: Pick<MaintenanceAttachment, 'kind' | 'contentType'>,
): 'image' | 'video' | 'audio' | 'link' {
  if (attachment.kind === 'image') return 'image';
  if (attachment.kind === 'video') return 'video';
  if (attachment.kind === 'audio') return 'audio';
  return 'link';
}

/** "0:45" for a recording's length. */
export function durationText(seconds: number | null): string | null {
  if (seconds === null || !(seconds > 0) || !Number.isFinite(seconds)) return null;
  const whole = Math.ceil(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Files grouped by when they were taken: with the report, before, after, other. */
export function attachmentsByStage<A extends Pick<MaintenanceAttachment, 'stage'>>(
  attachments: readonly A[],
): { stage: MaintenanceAttachmentStage; label: string; items: A[] }[] {
  return (Object.keys(STAGE_LABELS) as MaintenanceAttachmentStage[])
    .map((stage) => ({
      stage,
      label: STAGE_LABELS[stage],
      items: attachments.filter((a) => a.stage === stage),
    }))
    .filter((group) => group.items.length > 0);
}

/** Whether the reader may do anything to the job, so a read-only view says so. */
export const anyAction = (actions: MaintenanceActions): boolean =>
  Object.values(actions).some(Boolean);
