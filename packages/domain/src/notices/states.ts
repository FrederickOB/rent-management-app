import { DomainError } from '../errors';
import { NOTICE_TYPE_LABELS, NOTICE_TYPE_RULES, type NoticeType } from './types';

/**
 * The notice state machine (LN-03; architecture section 7; M7 plan 4.4 and 4.8). Before issue a
 * notice moves by transitions. After issue its status is the furthest point reached, derived
 * from its events, each also kept in `notice_event` with its server timestamp. Pausing or
 * cancelling the ladder is a flag, not a state. Nothing here ends a lease or touches a unit: a
 * notice to quit never ends a tenancy by itself (Act 220 s.17 and s.27; CLAUDE.md section 7).
 */
export const NOTICE_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'delivered',
  'reminded',
  'opened',
  'escalated',
  'served',
  'signed',
  'closed',
  'cancelled',
  /** Decision 13: a tenant-originated notice, recorded by staff when received. */
  'received',
] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

export const NOTICE_STATUS_LABELS: Record<NoticeStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Waiting for approval',
  approved: 'Approved',
  sent: 'Sent',
  delivered: 'Delivered',
  reminded: 'Reminded',
  opened: 'Opened',
  escalated: 'Escalated',
  served: 'Served',
  signed: 'Signed',
  closed: 'Closed',
  cancelled: 'Cancelled',
  received: 'Received',
};

export const PRE_ISSUE_STATUSES = ['draft', 'pending_approval', 'approved'] as const;
/** Issued and not closed: the ladder and tracking run. */
export const LIVE_STATUSES = [
  'sent',
  'delivered',
  'reminded',
  'opened',
  'escalated',
  'served',
  'signed',
] as const;
export type LiveNoticeStatus = (typeof LIVE_STATUSES)[number];

export const isLive = (status: NoticeStatus): status is LiveNoticeStatus =>
  (LIVE_STATUSES as readonly string[]).includes(status);
export const isIssued = (status: NoticeStatus): boolean => isLive(status) || status === 'closed';

/**
 * How far a recipient has got after issue. A reminder is our action and an open is the
 * tenant's, so an open outranks a reminder: a notice reminded after it was opened stays Opened
 * (the reminder is still an event). A signature outranks physical service, and both outrank
 * escalation, so a late signature after escalation is Signed (plan 4.4).
 */
const PROGRESS: Record<LiveNoticeStatus, number> = {
  sent: 1,
  delivered: 2,
  reminded: 3,
  opened: 4,
  escalated: 5,
  served: 6,
  signed: 7,
};

/** Events that move a notice before issue, by transition. */
const PRE_ISSUE_TRANSITIONS: Record<
  'draft' | 'pending_approval' | 'approved',
  readonly NoticeStatus[]
> = {
  draft: ['pending_approval', 'approved', 'cancelled'],
  pending_approval: ['draft', 'approved'],
  approved: ['sent', 'draft'],
};

/**
 * A transition before issue, or issue itself (architecture section 7):
 * - draft to pending_approval (submit), to approved (an issuer with notice authority approves
 *   their own draft; never a notice to quit, decision 8), or to cancelled (discard);
 * - pending_approval to approved, or back to draft (rejected, expired or withdrawn);
 * - approved to sent (issue), or back to draft when the date no longer holds at issue (4.3).
 */
export function checkNoticeTransition(
  type: NoticeType,
  from: NoticeStatus,
  to: NoticeStatus,
): void {
  const allowed =
    from === 'draft' || from === 'pending_approval' || from === 'approved'
      ? PRE_ISSUE_TRANSITIONS[from]
      : from === 'received'
        ? (['closed'] as const)
        : [];
  if (!allowed.includes(to))
    throw new DomainError(
      'notice.transition',
      `A notice that is ${NOTICE_STATUS_LABELS[from].toLowerCase()} cannot become ${NOTICE_STATUS_LABELS[to].toLowerCase()}`,
    );
  const rules = NOTICE_TYPE_RULES[type];
  if (!rules.issuable && from !== 'received')
    throw new DomainError(
      'notice.not_issuable',
      `A ${NOTICE_TYPE_LABELS[type].toLowerCase()} is recorded, not drafted or issued`,
    );
  if (from === 'draft' && to === 'approved' && rules.twoPersonApproval)
    throw new DomainError(
      'notice.two_person_required',
      `A ${NOTICE_TYPE_LABELS[type].toLowerCase()} needs a second person's approval`,
    );
}

export const NOTICE_EVENT_KINDS = [
  // Before issue.
  'submitted',
  'returned_to_draft',
  'approved',
  'cancelled',
  // Issue and tracking (LN-03).
  'sent',
  'delivered',
  'opened',
  'reminded',
  'escalated',
  'served',
  'signed',
  'closed',
  // Decision 13.
  'received',
  // LN-05: flags, not states.
  'ladder_paused',
  'ladder_resumed',
  'ladder_cancelled',
] as const;
export type NoticeEventKind = (typeof NOTICE_EVENT_KINDS)[number];

/**
 * An event as the rules read it, oldest first. `recipientId` is null for an event about the whole
 * notice (sent, escalated, a posting on the premises, closed), which reaches every recipient.
 */
export interface NoticeEventFact {
  readonly kind: NoticeEventKind;
  readonly recipientId?: string | null;
}

/**
 * Who must acknowledge (decision 7; LN-07). `each`: every party acknowledges, and a recipient is
 * their own party unless one is given (residential tenants each have their own ladder; a
 * building-wide notice groups a company tenant's signatories as one party). `any_one`: the whole
 * notice is one party, so the first signature acknowledges for everyone (a company tenant).
 */
export type NoticeCompletion = 'any_one' | 'each';

export interface NoticeRecipientRef {
  readonly recipientId: string;
  /** The party the recipient acknowledges for; defaults to the recipient. */
  readonly party?: string | null;
}

/** Commercial leases complete on any one signature (LN-07); everything else on each party. */
export function noticeCompletionFor(input: {
  readonly type: NoticeType;
  readonly leaseUse: 'residential' | 'commercial' | null;
}): NoticeCompletion {
  if (input.type === 'building_wide') return 'each';
  return input.leaseUse === 'commercial' ? 'any_one' : 'each';
}

const partyOf = (r: NoticeRecipientRef, completion: NoticeCompletion) =>
  completion === 'any_one' ? '*' : (r.party ?? r.recipientId);

/** The signature state of a recipient, for the completion rules. */
export interface RecipientSignature extends NoticeRecipientRef {
  readonly signed: boolean;
}

/**
 * Whether the notice is acknowledged (LN-07): `any_one`, any recipient has signed; `each`, every
 * party has a member who signed. A notice with no recipients is never acknowledged.
 */
export function noticeSigned(
  recipients: readonly RecipientSignature[],
  completion: NoticeCompletion,
): boolean {
  if (recipients.length === 0) return false;
  const parties = new Map<string, boolean>();
  for (const r of recipients) {
    const key = partyOf(r, completion);
    parties.set(key, (parties.get(key) ?? false) || r.signed);
  }
  return [...parties.values()].every(Boolean);
}

/** Whether this recipient's ladder has stopped because their party has acknowledged (LN-05, LN-07). */
export function recipientAcknowledged(
  recipientId: string,
  recipients: readonly RecipientSignature[],
  completion: NoticeCompletion,
): boolean {
  const self = recipients.find((r) => r.recipientId === recipientId);
  if (!self) throw new DomainError('notice.recipient_unknown', 'Not a recipient of this notice');
  const party = partyOf(self, completion);
  return recipients.some((r) => r.signed && partyOf(r, completion) === party);
}

const LIVE_KINDS: ReadonlySet<string> = new Set(LIVE_STATUSES);

function preIssueStatus(events: readonly NoticeEventFact[]): NoticeStatus {
  let status: NoticeStatus = 'draft';
  for (const e of events) {
    if (e.kind === 'submitted') status = 'pending_approval';
    else if (e.kind === 'returned_to_draft') status = 'draft';
    else if (e.kind === 'approved') status = 'approved';
    else if (e.kind === 'cancelled') status = 'cancelled';
    else if (e.kind === 'received') status = 'received';
  }
  return status;
}

/**
 * A recipient's furthest point after issue, from the notice-wide events and their own.
 * `withoutSignature` leaves the signature out: how far they got short of signing.
 */
export function recipientStatus(
  events: readonly NoticeEventFact[],
  recipientId: string,
  withoutSignature = false,
): LiveNoticeStatus | null {
  let best: LiveNoticeStatus | null = null;
  for (const e of events) {
    if (!LIVE_KINDS.has(e.kind) || (withoutSignature && e.kind === 'signed')) continue;
    if (e.recipientId && e.recipientId !== recipientId) continue;
    const kind = e.kind as LiveNoticeStatus;
    if (!best || PROGRESS[kind] > PROGRESS[best]) best = kind;
  }
  return best;
}

export interface NoticeProgress {
  readonly status: NoticeStatus;
  readonly recipients: readonly {
    readonly recipientId: string;
    readonly status: LiveNoticeStatus | null;
    readonly signed: boolean;
    /** Their party has acknowledged, so their ladder has stopped (LN-07). */
    readonly acknowledged: boolean;
  }[];
  /** LN-07: the notice is acknowledged under its completion rule. */
  readonly signed: boolean;
  readonly signedRecipients: number;
}

/**
 * The notice's status and each recipient's (plan 4.4). Before issue: the last transition. After
 * issue: each recipient's furthest point reached. The notice is Signed once it is acknowledged
 * under its completion rule (noticeSigned); until then it shows the furthest point any recipient
 * reached short of signing, so one joint tenant's signature never reads as the notice's. Both
 * only ever move forward. Closed and cancelled are final.
 */
export function noticeProgress(
  events: readonly NoticeEventFact[],
  recipients: readonly NoticeRecipientRef[],
  completion: NoticeCompletion,
): NoticeProgress {
  const perRecipient = recipients.map((r) => {
    const status = recipientStatus(events, r.recipientId);
    return { ...r, status, signed: status === 'signed' };
  });
  const out = perRecipient.map((r) => ({
    recipientId: r.recipientId,
    status: r.status,
    signed: r.signed,
    acknowledged: recipientAcknowledged(r.recipientId, perRecipient, completion),
  }));
  const signed = noticeSigned(perRecipient, completion);
  const signedRecipients = perRecipient.filter((r) => r.signed).length;
  const base = { recipients: out, signed, signedRecipients };

  if (events.some((e) => e.kind === 'closed')) return { status: 'closed', ...base };
  if (!events.some((e) => e.kind === 'sent')) return { status: preIssueStatus(events), ...base };
  if (signed) return { status: 'signed', ...base };
  const status = recipients
    .map((r) => recipientStatus(events, r.recipientId, true))
    .reduce<LiveNoticeStatus>((best, s) => (s && PROGRESS[s] > PROGRESS[best] ? s : best), 'sent');
  return { status, ...base };
}

/** The ladder's flags (LN-05): who, when and why are on the events. Cancel is final. */
export interface NoticeLadderFlags {
  readonly paused: boolean;
  readonly cancelled: boolean;
}

export function noticeLadderFlags(events: readonly NoticeEventFact[]): NoticeLadderFlags {
  let paused = false;
  let cancelled = false;
  for (const e of events) {
    if (e.kind === 'ladder_paused') paused = true;
    else if (e.kind === 'ladder_resumed') paused = false;
    else if (e.kind === 'ladder_cancelled') cancelled = true;
  }
  return { paused: paused && !cancelled, cancelled };
}

export type LadderControl = 'pause' | 'resume' | 'cancel';

/**
 * The ladder's flags after a control (LN-05), on a live notice only. Pausing a paused ladder,
 * resuming a running one, or anything after a cancel is refused.
 */
export function nextLadderFlags(
  status: NoticeStatus,
  flags: NoticeLadderFlags,
  action: LadderControl,
): NoticeLadderFlags {
  if (!isLive(status))
    throw new DomainError('notice.ladder_not_live', 'Only an issued, open notice has a ladder');
  if (flags.cancelled) throw new DomainError('notice.ladder_cancelled', 'The ladder was cancelled');
  switch (action) {
    case 'pause':
      if (flags.paused)
        throw new DomainError('notice.ladder_paused', 'The ladder is already paused');
      return { paused: true, cancelled: false };
    case 'resume':
      if (!flags.paused) throw new DomainError('notice.ladder_running', 'The ladder is not paused');
      return { paused: false, cancelled: false };
    case 'cancel':
      return { paused: false, cancelled: true };
  }
}

/** A ladder control from staff (LN-05): nextLadderFlags, with the reason it needs. */
export function checkLadderControl(input: {
  readonly status: NoticeStatus;
  readonly flags: NoticeLadderFlags;
  readonly action: LadderControl;
  readonly reason: string;
}): NoticeLadderFlags {
  if (input.reason.trim().length < 3)
    throw new DomainError('notice.ladder_reason_required', 'Say why the ladder is changing');
  return nextLadderFlags(input.status, input.flags, input.action);
}

/**
 * Checks that an event may be recorded now, so the service cannot skip a state (plan 4.4), and
 * returns the status after it. Facts about the tenant (delivered, opened, signed, served) are
 * still recorded after the notice closes and leave it Closed; our own actions (reminders,
 * escalation, ladder controls) stop at close. A signature needs the recipient's open first.
 */
export function applyNoticeEvent(input: {
  readonly type: NoticeType;
  readonly events: readonly NoticeEventFact[];
  readonly recipients: readonly NoticeRecipientRef[];
  readonly completion: NoticeCompletion;
  readonly event: NoticeEventFact;
}): NoticeProgress {
  const { type, events, recipients, completion, event } = input;
  const before = noticeProgress(events, recipients, completion);
  const status = before.status;
  const recipientId = event.recipientId ?? null;
  const refuse = (code: string, message: string): never => {
    throw new DomainError(code, message);
  };
  const needRecipient = () => {
    if (!recipientId)
      refuse('notice.recipient_required', `A ${event.kind} event names its recipient`);
    if (!recipients.some((r) => r.recipientId === recipientId))
      refuse('notice.recipient_unknown', 'Not a recipient of this notice');
  };
  const needIssued = () => {
    if (!isIssued(status))
      refuse(
        'notice.not_issued',
        `A notice that is ${NOTICE_STATUS_LABELS[status].toLowerCase()} has not been issued`,
      );
  };
  const needLive = () => {
    needIssued();
    if (!isLive(status)) refuse('notice.closed', 'The notice is closed');
  };
  const needLadderRunning = () => {
    const flags = noticeLadderFlags(events);
    if (flags.paused || flags.cancelled)
      refuse('notice.ladder_stopped', 'The ladder is paused or cancelled');
  };

  switch (event.kind) {
    case 'submitted':
      checkNoticeTransition(type, status, 'pending_approval');
      break;
    case 'returned_to_draft':
      checkNoticeTransition(type, status, 'draft');
      break;
    case 'approved':
      checkNoticeTransition(type, status, 'approved');
      break;
    case 'cancelled':
      checkNoticeTransition(type, status, 'cancelled');
      break;
    case 'sent':
      checkNoticeTransition(type, status, 'sent');
      if (recipients.length === 0) refuse('notice.no_recipients', 'A notice needs a recipient');
      if (recipientId) refuse('notice.sent_whole', 'A notice is issued to every recipient at once');
      break;
    case 'received':
      if (NOTICE_TYPE_RULES[type].issuable || events.length > 0)
        refuse('notice.transition', 'Only a new notice from the tenant is recorded as received');
      break;
    case 'delivered':
    case 'opened':
      needIssued();
      needRecipient();
      break;
    case 'signed': {
      needIssued();
      needRecipient();
      const own = events.filter((e) => e.recipientId === recipientId);
      if (own.some((e) => e.kind === 'signed'))
        refuse('notice.already_signed', 'This recipient has already signed');
      if (!own.some((e) => e.kind === 'opened'))
        refuse('notice.not_opened', 'A recipient opens the notice before signing it');
      break;
    }
    case 'served':
      needIssued();
      if (recipientId) needRecipient();
      break;
    case 'reminded': {
      needLive();
      needRecipient();
      needLadderRunning();
      const r = before.recipients.find((x) => x.recipientId === recipientId);
      if (r?.acknowledged) refuse('notice.already_signed', 'This recipient has acknowledged');
      break;
    }
    case 'escalated':
      needLive();
      if (recipientId) needRecipient();
      needLadderRunning();
      if (before.signed) refuse('notice.already_signed', 'The notice has been acknowledged');
      break;
    case 'ladder_paused':
    case 'ladder_resumed':
    case 'ladder_cancelled':
      nextLadderFlags(
        status,
        noticeLadderFlags(events),
        event.kind === 'ladder_paused'
          ? 'pause'
          : event.kind === 'ladder_resumed'
            ? 'resume'
            : 'cancel',
      );
      break;
    case 'closed':
      if (status !== 'received') needLive();
      break;
  }
  return noticeProgress([...events, event], recipients, completion);
}

/** Decision 12: how a notice closes. "Referred" is split into Rent Control and court. */
export const NOTICE_OUTCOMES = [
  'complied',
  'paid',
  'vacated',
  'disputed',
  'referred_rent_control',
  'referred_court',
  'superseded',
  'withdrawn',
] as const;
export type NoticeOutcome = (typeof NOTICE_OUTCOMES)[number];

export const NOTICE_OUTCOME_LABELS: Record<NoticeOutcome, string> = {
  complied: 'Complied',
  paid: 'Paid',
  vacated: 'Vacated',
  disputed: 'Disputed',
  referred_rent_control: 'Referred to Rent Control',
  referred_court: 'Referred to court',
  superseded: 'Superseded by a correction',
  withdrawn: 'Withdrawn',
};

/** Outcomes staff choose; `superseded` is set only when a correction is issued (plan 4.8). */
export const STAFF_NOTICE_OUTCOMES = [
  'complied',
  'paid',
  'vacated',
  'disputed',
  'referred_rent_control',
  'referred_court',
  'withdrawn',
] as const satisfies readonly Exclude<NoticeOutcome, 'superseded'>[];

export interface NoticeClosure {
  readonly outcome: NoticeOutcome;
  readonly note: string;
  /**
   * Always `none`: closing a notice records an outcome and stops its ladder. It never ends a
   * lease, takes possession or changes a unit, whatever the outcome (Act 220 s.17 and s.27).
   * `vacated` records what the tenant did; move-out is its own flow (M8).
   */
  readonly leaseAction: 'none';
}

/** Checks a close (plan 4.8): a live notice (or one received), an outcome, and a note. */
export function checkNoticeClose(input: {
  readonly status: NoticeStatus;
  readonly outcome: string;
  readonly note: string;
  /** True only when issuing a correction closes the notice it replaces. */
  readonly byCorrection?: boolean;
}): NoticeClosure {
  if (!isLive(input.status) && input.status !== 'received')
    throw new DomainError(
      'notice.close_not_allowed',
      `A notice that is ${NOTICE_STATUS_LABELS[input.status].toLowerCase()} cannot be closed`,
    );
  if (!(NOTICE_OUTCOMES as readonly string[]).includes(input.outcome))
    throw new DomainError('notice.outcome_invalid', `Not an outcome: ${input.outcome}`);
  const outcome = input.outcome as NoticeOutcome;
  if ((outcome === 'superseded') !== !!input.byCorrection)
    throw new DomainError(
      'notice.outcome_invalid',
      outcome === 'superseded'
        ? 'A notice is superseded only by issuing its correction'
        : 'Issuing a correction closes the old notice as superseded',
    );
  const note = input.note.trim();
  if (note.length < 3 || note.length > 2000)
    throw new DomainError(
      'notice.close_note_required',
      'Add a note saying why the notice is closed',
    );
  return { outcome, note, leaseAction: 'none' };
}

/**
 * What stays fixed once a notice is issued (plan 4.8): a database trigger refuses changes to
 * these. Only MUTABLE_AFTER_ISSUE moves, and every move is audited.
 */
export const FROZEN_AFTER_ISSUE = [
  'number',
  'type',
  'subtype',
  'lease',
  'tenant',
  'property',
  'unit',
  'fields',
  'issue_date',
  'effective_date',
  'earliest_lawful_date',
  'rule_versions',
  'electronic_service',
  'recipients',
  'document',
  'document_sha256',
  'corrects_notice',
] as const;
export const MUTABLE_AFTER_ISSUE = [
  'status',
  'ladder_paused',
  'ladder_cancelled',
  'outcome',
  'close_note',
  'closed_by',
  'closed_at',
] as const;

/**
 * Whether a notice's content may change: only a draft. A notice waiting for approval, or
 * approved and not yet issued, goes back to draft first (its approval is cancelled). An issued
 * notice is never edited; a correction is a new notice that references it.
 */
export function checkNoticeEditable(status: NoticeStatus): void {
  if (status === 'draft') return;
  if (status === 'pending_approval' || status === 'approved')
    throw new DomainError(
      'notice.in_approval',
      'Return the notice to draft to change it; its approval is then cancelled',
    );
  if (status === 'cancelled') throw new DomainError('notice.cancelled', 'The notice was discarded');
  throw new DomainError(
    'notice.frozen',
    'An issued notice cannot be changed. Correct it with a new notice that references it',
  );
}

/**
 * Starting a correction (plan 4.8): the original must be issued and open, and the correction is
 * the same type of notice under the same lease (or the same property for a building-wide one).
 */
export function checkNoticeCorrection(input: {
  readonly original: {
    readonly status: NoticeStatus;
    readonly type: NoticeType;
    readonly leaseId: string | null;
    readonly propertyId: string;
  };
  readonly correction: {
    readonly type: NoticeType;
    readonly leaseId: string | null;
    readonly propertyId: string;
  };
}): void {
  const { original, correction } = input;
  if (!isLive(original.status))
    throw new DomainError(
      'notice.correction_not_allowed',
      original.status === 'closed'
        ? 'A closed notice cannot be corrected'
        : 'Only an issued notice is corrected; change the draft instead',
    );
  if (!NOTICE_TYPE_RULES[original.type].issuable)
    throw new DomainError(
      'notice.correction_not_allowed',
      'A notice from the tenant is not corrected',
    );
  if (correction.type !== original.type)
    throw new DomainError('notice.correction_type', 'A correction is the same type of notice');
  if (correction.leaseId !== original.leaseId || correction.propertyId !== original.propertyId)
    throw new DomainError(
      'notice.correction_lease',
      'A correction is for the same lease and property as the notice it replaces',
    );
}

/**
 * When a correction is issued, the notice it replaces closes as superseded and its ladder
 * stops (plan 4.8). Null when that notice has already closed: it keeps its own outcome.
 */
export function supersededClosure(input: {
  readonly originalStatus: NoticeStatus;
  readonly correctionNumber: string;
}): NoticeClosure | null {
  if (input.originalStatus === 'closed') return null;
  return checkNoticeClose({
    status: input.originalStatus,
    outcome: 'superseded',
    note: `Replaced by notice ${input.correctionNumber}`,
    byCorrection: true,
  });
}
