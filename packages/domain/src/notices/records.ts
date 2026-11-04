import { NOTICE_EVENT_KINDS } from './states';
import type { NoticeWarningCode } from './effective-date';
import type { NoticeChannel } from './ladder';

/**
 * What the M7 backend records about a notice beyond its state machine (plan 4.6 to 4.9): every
 * kind of `notice_event`, how physical service was done, how each recipient's channels were
 * planned (decisions 4 and 5), and the OQ-16 statement (decision 9). Pure, like the rest.
 */

/** Every warning code the composer and the notice can carry (effective-date.ts). */
export const NOTICE_WARNING_CODES = [
  'statutory_minimum_unverified',
  'statutory_minimum_not_set',
  'statutory_rule_missing',
  'assessment_bar_unverified',
  'no_electronic_service_clause',
  'electronic_service_withheld',
  'counsel_wording_outstanding',
  'no_period_enforced',
] as const satisfies readonly NoticeWarningCode[];

/**
 * Every kind a `notice_event` row may have: the state machine's kinds, then records that move no
 * status (a channel withheld, a ladder step skipped, the manager alerted, a task created, the
 * service pack or the frozen document ready, a late service flagged, a link handed over).
 */
export const NOTICE_RECORD_KINDS = [
  ...NOTICE_EVENT_KINDS,
  'channel_withheld',
  'step_skipped',
  'manager_alerted',
  'task_created',
  'document_ready',
  'service_pack_ready',
  'served_too_late',
  'link_issued',
] as const;
export type NoticeRecordKind = (typeof NOTICE_RECORD_KINDS)[number];

/** How a notice was physically served (plan 4.7). */
export const SERVICE_METHODS = [
  'handed_to_tenant',
  'posted_on_premises',
  'left_with_adult_occupant',
  'registered_post',
  'courier',
] as const;
export type ServiceMethod = (typeof SERVICE_METHODS)[number];

export const SERVICE_METHOD_LABELS: Record<ServiceMethod, string> = {
  handed_to_tenant: 'Handed to the tenant',
  posted_on_premises: 'Posted on the premises',
  left_with_adult_occupant: 'Left with an adult occupant',
  registered_post: 'Registered post',
  courier: 'Courier',
};

/** Who a recipient is (decision 7): a tenant, or an authorised signatory of a company tenant. */
export const NOTICE_RECIPIENT_KINDS = ['tenant', 'signatory'] as const;
export type NoticeRecipientKind = (typeof NOTICE_RECIPIENT_KINDS)[number];

/**
 * How a notice goes on one channel to one recipient (decisions 4 and 5):
 * - `service`: an address the lease's electronic-service clause names;
 * - `courtesy`: a copy on a channel with ordinary consent, marked as a courtesy copy;
 * - `withheld`: not sent, with the reason recorded on the notice.
 */
export const NOTICE_CHANNEL_MODES = ['service', 'courtesy', 'withheld'] as const;
export type NoticeChannelMode = (typeof NOTICE_CHANNEL_MODES)[number];

/** Why a channel was withheld: no address, no consent and no clause, or an opt-out (STOP). */
export const NOTICE_WITHHELD_REASONS = ['no_address', 'no_consent', 'opted_out'] as const;
export type NoticeWithheldReason = (typeof NOTICE_WITHHELD_REASONS)[number];

export const NOTICE_WITHHELD_REASON_LABELS: Record<NoticeWithheldReason, string> = {
  no_address: 'No address on record',
  no_consent: 'No consent, and the lease does not name this address for service',
  opted_out: 'The tenant opted out (STOP or unsubscribe)',
};

export interface NoticeChannelPlan {
  readonly channel: NoticeChannel;
  readonly mode: NoticeChannelMode;
  readonly reason: NoticeWithheldReason | null;
}

/** Consent on a channel as the plan reads it: the latest event, or none on record. */
export type NoticeConsentState = 'granted' | 'withdrawn' | 'none';

/**
 * One recipient's channels (decisions 4 and 5). No address withholds the channel. A withdrawal of
 * consent on it (STOP, an unsubscribe, or one staff recorded for the tenant) withholds it too:
 * opt-outs are honoured for notices as well, and counsel is asked whether the clause should
 * override one (open question). Otherwise an address the clause names is served on, and any
 * other address gets a courtesy copy only with consent.
 */
export function noticeChannelPlan(input: {
  readonly addresses: Readonly<Record<NoticeChannel, string | null>>;
  /** Whether the lease's electronic-service clause names this channel's address. */
  readonly namedInClause: Readonly<Record<NoticeChannel, boolean>>;
  readonly consent: Readonly<Record<NoticeChannel, NoticeConsentState>>;
}): NoticeChannelPlan[] {
  return (['whatsapp', 'sms', 'email'] as const).map((channel) => {
    if (!input.addresses[channel]) return { channel, mode: 'withheld', reason: 'no_address' };
    if (input.consent[channel] === 'withdrawn')
      return { channel, mode: 'withheld', reason: 'opted_out' };
    if (input.namedInClause[channel]) return { channel, mode: 'service', reason: null };
    if (input.consent[channel] === 'granted') return { channel, mode: 'courtesy', reason: null };
    return { channel, mode: 'withheld', reason: 'no_consent' };
  });
}

/** Whether a recipient can be served electronically: one channel in `service` mode. */
export const servedElectronicallyBy = (plan: readonly NoticeChannelPlan[]): boolean =>
  plan.some((c) => c.mode === 'service');

/**
 * The OQ-16 statement a company admin types their name to accept (decision 9), by version. The
 * version and the text's hash are kept with each acknowledgement. It names what is unverified
 * and what a notice to quit does not do; it states no notice period.
 */
export const QUIT_ACK_STATEMENTS: Readonly<Record<string, string>> = {
  'quit_ack.v1':
    'I understand that the statutory minimum notice periods for notices to quit have not been ' +
    'verified by counsel. Until they are, the earliest date of a notice to quit is worked out from ' +
    'the notice period in the lease, and the product shows a warning that the statutory minimum is ' +
    'unverified. I understand that the wording of the notice templates has not yet been supplied ' +
    'by counsel. I understand that a notice to quit never ends a tenancy by itself: possession ' +
    'needs a court or Rent Control order, and the product never supports lockouts, utility ' +
    'cut-offs or other pressure on a tenant to leave. Each notice to quit needs a second person’s ' +
    'approval. I accept the risk of issuing notices to quit on these terms for this company.',
};
export const CURRENT_QUIT_ACK = 'quit_ack.v1';

/** Decision 1: every legal sentence in a notice template reads this until counsel supplies it. */
export const COUNSEL_WORDING_PLACEHOLDER = 'Wording to be supplied by your lawyer.';
