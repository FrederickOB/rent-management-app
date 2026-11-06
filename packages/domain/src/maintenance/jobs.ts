import { z } from 'zod';
import { DomainError } from '../errors';
import {
  MAINTENANCE_PRIORITIES,
  type MaintenanceJobStatus,
  type MaintenancePriority,
} from './maintenance';

/**
 * The maintenance job's state machine (MI-01 to MI-06; architecture section 7; M8 plan 4.2):
 * Reported → Triaged → Assigned → In progress → Work done → Closed, with Work done → In progress
 * on a dispute, Assigned → Triaged on a decline or unassignment, and Reported or Triaged →
 * Cancelled. The rules of MI-06 travel with the steps: starting needs a before photo or a
 * recorded reason; marking work done needs an after photo and a completion note (decision 7).
 */
export const MAINTENANCE_JOB_ACTIONS = [
  'triage',
  'assign',
  'unassign',
  'start',
  'complete',
  'confirm',
  'dispute',
  'auto_close',
  'cancel',
] as const;
export type MaintenanceJobAction = (typeof MAINTENANCE_JOB_ACTIONS)[number];

const MOVES: Readonly<
  Record<MaintenanceJobAction, { from: readonly MaintenanceJobStatus[]; to: MaintenanceJobStatus }>
> = {
  triage: { from: ['reported', 'triaged'], to: 'triaged' },
  assign: { from: ['triaged', 'assigned'], to: 'assigned' },
  unassign: { from: ['assigned'], to: 'triaged' },
  start: { from: ['assigned'], to: 'in_progress' },
  complete: { from: ['in_progress'], to: 'work_done' },
  confirm: { from: ['work_done'], to: 'closed' },
  dispute: { from: ['work_done'], to: 'in_progress' },
  auto_close: { from: ['work_done'], to: 'closed' },
  cancel: { from: ['reported', 'triaged'], to: 'cancelled' },
};

/** Every move the machine allows, from → to (the database's transition trigger keeps the same). */
export const MAINTENANCE_JOB_TRANSITIONS: readonly (readonly [
  MaintenanceJobStatus,
  MaintenanceJobStatus,
])[] = [
  ...new Map(
    Object.values(MOVES).flatMap(({ from, to }) =>
      from.map((f) => [`${f}>${to}`, [f, to] as const] as const),
    ),
  ).values(),
];

/** What a step needs to know about the job's evidence (MI-06). */
export interface MaintenanceStepFacts {
  /** Photos taken before work started, on the job. */
  readonly beforePhotos?: number;
  /** Why work started without a before photo (for example "emergency: no time"). */
  readonly beforePhotoReason?: string | null;
  /** Photos taken after the work, on the job. */
  readonly afterPhotos?: number;
  readonly completionNote?: string | null;
  /** A dispute or a cancellation needs its reason. */
  readonly reason?: string | null;
  /** Triage sets both. */
  readonly priority?: MaintenancePriority | null;
  readonly category?: string | null;
}

const text = (value: string | null | undefined) => value?.trim() ?? '';

/**
 * The job's next status after an action, or a DomainError naming why not. The service maps the
 * codes to named 409s (an illegal move) and 400s (missing evidence).
 */
export function nextMaintenanceStatus(
  from: MaintenanceJobStatus,
  action: MaintenanceJobAction,
  facts: MaintenanceStepFacts = {},
): MaintenanceJobStatus {
  const move = MOVES[action];
  if (!move.from.includes(from))
    throw new DomainError(
      'maintenance.transition',
      `A job that is ${from.replace('_', ' ')} cannot be ${ACTION_PAST[action]}`,
    );
  switch (action) {
    case 'triage':
      if (!facts.priority || !facts.category)
        throw new DomainError('maintenance.triage_incomplete', 'Set the priority and the category');
      break;
    case 'start':
      if ((facts.beforePhotos ?? 0) < 1 && text(facts.beforePhotoReason).length < 3)
        throw new DomainError(
          'maintenance.before_photo_required',
          'Add a photo of the problem before work starts, or say why there is none',
        );
      break;
    case 'complete':
      if ((facts.afterPhotos ?? 0) < 1)
        throw new DomainError(
          'maintenance.after_photo_required',
          'Add at least one photo of the finished work',
        );
      if (text(facts.completionNote).length < 3)
        throw new DomainError(
          'maintenance.completion_note_required',
          'Add a note saying what was done',
        );
      break;
    case 'dispute':
    case 'cancel':
      if (text(facts.reason).length < 3)
        throw new DomainError('maintenance.reason_required', 'Say why, in a few words');
      break;
    default:
      break;
  }
  return move.to;
}

const ACTION_PAST: Record<MaintenanceJobAction, string> = {
  triage: 'triaged',
  assign: 'assigned',
  unassign: 'unassigned',
  start: 'started',
  complete: 'marked done',
  confirm: 'confirmed',
  dispute: 'disputed',
  auto_close: 'closed',
  cancel: 'cancelled',
};

/** A completion note or a reason: trimmed, up to 2000 characters. */
export function checkMaintenanceText(value: string | null | undefined, what: string): string {
  const t = text(value);
  if (t.length > 2000)
    throw new DomainError('maintenance.text_too_long', `${what} is at most 2000 characters`);
  return t;
}

// Target times (MI-02; decision 4) -----------------------------------------------------------------

/** How long a job may take to be responded to (assigned or attended) and completed. */
export interface MaintenanceTarget {
  readonly respondHours: number;
  readonly completeHours: number;
}

/** Decision 4's defaults: product settings, not law, editable per company. */
export const MAINTENANCE_TARGET_DEFAULTS: Readonly<Record<MaintenancePriority, MaintenanceTarget>> =
  {
    emergency: { respondHours: 2, completeHours: 24 },
    urgent: { respondHours: 24, completeHours: 72 },
    routine: { respondHours: 72, completeHours: 14 * 24 },
  };

/** Decision 7: days after work done that a job closes when the tenant has not answered. */
export const MAINTENANCE_AUTO_CLOSE_DAYS = 7;

export const MAINTENANCE_TARGET_KINDS = ['respond', 'complete'] as const;
export type MaintenanceTargetKind = (typeof MAINTENANCE_TARGET_KINDS)[number];

/** A warning is sent when a target is about to be missed, and again when it is missed. */
export const MAINTENANCE_SLA_STAGES = ['due_soon', 'missed'] as const;
export type MaintenanceSlaStage = (typeof MAINTENANCE_SLA_STAGES)[number];

const HOUR = 3_600_000;

/** When each target falls due, from the time the job was reported (calendar hours). */
export function maintenanceDueTimes(
  reportedAt: Date,
  target: MaintenanceTarget,
): Record<MaintenanceTargetKind, Date> {
  return {
    respond: new Date(reportedAt.getTime() + target.respondHours * HOUR),
    complete: new Date(reportedAt.getTime() + target.completeHours * HOUR),
  };
}

/**
 * "About to be missed": the last quarter of the target's time, and at least the last 15 minutes
 * (a product choice; the SLA job runs every 15 minutes).
 */
export function dueSoonFrom(reportedAt: Date, due: Date): Date {
  const span = due.getTime() - reportedAt.getTime();
  const lead = Math.max(15 * 60_000, Math.floor(span / 4));
  return new Date(due.getTime() - Math.min(lead, span));
}

export interface SlaWarning {
  readonly target: MaintenanceTargetKind;
  readonly stage: MaintenanceSlaStage;
  readonly dueAt: Date;
  /** The idempotency key: once per job, target and stage (plan 4.13). */
  readonly key: string;
}

/**
 * The SLA warnings due now for one job (decision 4), each once: a target already met warns no
 * more. When both stages are due at once only "missed" is sent.
 */
export function dueSlaWarnings(input: {
  readonly jobId: string;
  readonly status: MaintenanceJobStatus;
  readonly priority: MaintenancePriority | null;
  readonly reportedAt: Date;
  /** First assigned or attended. */
  readonly respondedAt: Date | null;
  readonly workDoneAt: Date | null;
  readonly target: MaintenanceTarget | null;
  readonly now: Date;
  readonly sent: ReadonlySet<string>;
}): SlaWarning[] {
  if (!input.priority || !input.target) return [];
  if (input.status === 'closed' || input.status === 'cancelled') return [];
  const due = maintenanceDueTimes(input.reportedAt, input.target);
  const out: SlaWarning[] = [];
  for (const target of MAINTENANCE_TARGET_KINDS) {
    const met = target === 'respond' ? input.respondedAt : input.workDoneAt;
    if (met) continue;
    const at = due[target];
    const stage: MaintenanceSlaStage | null =
      input.now >= at
        ? 'missed'
        : input.now >= dueSoonFrom(input.reportedAt, at)
          ? 'due_soon'
          : null;
    if (!stage) continue;
    const key = `maintenance-sla:${input.jobId}:${target}:${stage}`;
    if (input.sent.has(key)) continue;
    out.push({ target, stage, dueAt: at, key });
  }
  return out;
}

/** Decision 7: a job marked done closes on its own after this many days without a reply. */
export function autoCloseDue(workDoneAt: Date, now: Date, days: number): boolean {
  return now.getTime() >= workDoneAt.getTime() + days * 24 * HOUR;
}

// Company settings (decision 4 and 7): the shapes live here; company-settings.ts holds the keys.

const hours = z
  .number()
  .int()
  .min(1)
  .max(24 * 90);

export const maintenanceTargetSchema = z
  .object({ respondHours: hours, completeHours: hours })
  .strict()
  .refine((t) => t.respondHours <= t.completeHours, {
    message: 'The response target must come before the completion target',
  });

export interface MaintenanceSettings {
  readonly targets: Readonly<Record<MaintenancePriority, MaintenanceTarget>>;
  readonly autoCloseDays: number;
}

/** A company's targets and auto-close days, the defaults applied where it set none. */
export function maintenanceSettingsOf(settings: {
  readonly maintenanceTargets?: Partial<Record<MaintenancePriority, MaintenanceTarget>>;
  readonly maintenanceAutoCloseDays?: number;
}): MaintenanceSettings {
  return {
    targets: {
      emergency: settings.maintenanceTargets?.emergency ?? MAINTENANCE_TARGET_DEFAULTS.emergency,
      urgent: settings.maintenanceTargets?.urgent ?? MAINTENANCE_TARGET_DEFAULTS.urgent,
      routine: settings.maintenanceTargets?.routine ?? MAINTENANCE_TARGET_DEFAULTS.routine,
    },
    autoCloseDays: settings.maintenanceAutoCloseDays ?? MAINTENANCE_AUTO_CLOSE_DAYS,
  };
}

export const maintenanceTargetsSchema = z.partialRecord(
  z.enum(MAINTENANCE_PRIORITIES),
  maintenanceTargetSchema,
);
