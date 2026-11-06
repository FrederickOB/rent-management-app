import type { LeaseDetailView, TenantRowView } from '@rent/contracts';
import { SIGNER_ROLE_LABELS, type SignerRole } from '@rent/domain/esign';
import { format, money } from '@rent/domain/money';
import {
  LEASE_STATUS_LABELS,
  RENT_CYCLE_LABELS,
  RENT_CYCLES,
  type BreakParty,
  type LeaseStatus,
  type RentCycle,
} from '@rent/domain/tenancy';
import { summarise } from './audit-summary';
import { formatBusinessDate } from './business-dates';
import { humanise } from './format';

// Display names for the tenancy screens (M3 plan 4.16). What a value means is decided in
// packages/domain; this file only says it in words.

export type IdStatus = TenantRowView['identity']['status'];
export type IdType = NonNullable<TenantRowView['identity']['type']>;
export type ContactKind = 'guarantor' | 'next_of_kin' | 'employer' | 'signatory' | 'finance';
export type TenantKind = TenantRowView['kind'];

export const TENANT_KIND_LABELS: Record<TenantKind, string> = {
  individual: 'Individual',
  company: 'Company',
};

export const ID_TYPE_LABELS: Record<IdType, string> = {
  ghana_card: 'Ghana Card',
  passport: 'Passport',
};

/** TL-02: a Ghana Card is checked biometrically; a passport is recorded, never verified. */
export const ID_STATUS_LABELS: Record<IdStatus, string> = {
  none: 'No ID number',
  not_started: 'Not checked yet',
  pending: 'Check in progress',
  verified: 'Verified',
  not_matched: 'Did not match',
  recorded: 'Recorded, not verified',
};

export const CONTACT_KIND_LABELS: Record<ContactKind, string> = {
  guarantor: 'Guarantor',
  next_of_kin: 'Next of kin',
  employer: 'Employer reference',
  signatory: 'Authorised signatory',
  finance: 'Finance contact',
};

/** Contacts each kind of tenant can have (TL-03 for people, TL-04 for companies). */
export const CONTACT_KINDS_FOR: Record<TenantKind, readonly ContactKind[]> = {
  individual: ['guarantor', 'next_of_kin', 'employer'],
  company: ['signatory', 'finance', 'guarantor'],
};

export const BREAK_PARTY_LABELS: Record<BreakParty, string> = {
  tenant: 'The tenant',
  landlord: 'The landlord',
  either: 'Either party',
};

export type LeaseEndReason = NonNullable<LeaseDetailView['lifecycle']['endReason']>;

/** How a lease ended, after its last day: a move-out, its renewal, or the next lease starting. */
const END_REASON_NOTES: Record<LeaseEndReason, string> = {
  moved_out: '',
  renewed: ', renewed',
  superseded: ', when the next lease on the unit started',
};

/** The "Ended" line on a lease: its last day, and why it ended when that is not a move-out. */
export function endedLabel(endedOn: string, reason: LeaseEndReason | null): string {
  return `${formatBusinessDate(endedOn)}${reason ? END_REASON_NOTES[reason] : ''}`;
}

export const leaseStatusLabel = (status: LeaseStatus): string => LEASE_STATUS_LABELS[status];
export const cycleLabel = (cycle: RentCycle): string => RENT_CYCLE_LABELS[cycle];

/**
 * The billing cycles a lease form offers (TL-06; M4b decision 9): monthly, quarterly, every six
 * months, annually and every two years, in the domain's order. Rent periods stay monthly.
 */
export const CYCLE_OPTIONS: readonly { readonly value: RentCycle; readonly label: string }[] =
  RENT_CYCLES.map((value) => ({ value, label: cycleLabel(value) }));
export const signerRoleLabel = (role: SignerRole): string => SIGNER_ROLE_LABELS[role];

/** Pesewas for people, at the edge only (CLAUDE.md section 4): `GH₵1,500.00`. */
export function formatMinor(amountMinor: number | null | undefined): string {
  if (amountMinor === null || amountMinor === undefined) return 'None';
  return format(money(amountMinor));
}

/** `GH₵1,500.00 a month, billed quarterly`. */
export function rentLabel(monthlyRentMinor: number, cycle: RentCycle): string {
  return `${formatMinor(monthlyRentMinor)} a month, billed ${cycleLabel(cycle).toLowerCase()}`;
}

/** `1 Nov 2026 to 31 Oct 2027`. */
export function termLabel(startDate: string, endDate: string): string {
  return `${formatBusinessDate(startDate)} to ${formatBusinessDate(endDate)}`;
}

/** `in 60 days`, `tomorrow`, `today`, or `12 days ago` for a date that has passed. */
export function daysLeftLabel(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

type Rule = NonNullable<LeaseDetailView['trackers']['stamping']['rule']>;

/**
 * A rule the screen leans on, said plainly (CLAUDE.md section 7): an unverified legal value always
 * carries a visible warning where it is used.
 */
export function ruleNote(rule: Rule | null): { readonly warn: boolean; readonly text: string } {
  if (!rule)
    return { warn: true, text: 'No rule is recorded for this yet, so no deadline is set.' };
  if (rule.verificationStatus === 'verified')
    return { warn: false, text: `From the legal rules: ${rule.source}.` };
  return {
    warn: true,
    text: `This rests on a rule that is not yet verified by counsel: ${rule.source}. Check it before relying on it.`,
  };
}

const RECORD_NOUNS: Record<string, string> = {
  tenant: 'Tenant',
  tenant_contact: 'Contact',
  id_check: 'Identity check',
  consent_event: 'Consent',
  lease: 'Lease',
};

const EVENT_LABELS: Record<string, string> = {
  'tenant.insert': 'Tenant added',
  'tenant.update': 'Tenant details changed',
  'tenant_contact.insert': 'Contact added',
  'tenant_contact.update': 'Contact changed',
  'id_check.insert': 'Identity check started',
  'id_check.update': 'Identity check updated',
  'consent_event.insert': 'Consent recorded',
  'lease.insert': 'Lease drafted',
  'lease.update': 'Lease changed',
  'lease.signed': 'Lease signed',
  'lease.issued': 'Lease issued for signing',
  'lease.recalled': 'Lease recalled from signing',
  'lease.declined': 'A signer declined the lease',
  'lease.moved_out': 'Move-out recorded',
  'lease.cancelled_after_signing': 'Signed lease cancelled, with approval',
  'id_number.revealed': 'ID number shown',
  'tin.revealed': 'TIN shown',
};

/** A timeline or audit action in words: `tenant_contact.insert` is `Contact added`. */
export function timelineLabel(action: string): string {
  const known = EVENT_LABELS[action];
  if (known) return known;
  const [record = '', verb = ''] = action.split('.', 2);
  const noun = RECORD_NOUNS[record] ?? humanise(record);
  if (verb === 'insert') return `${noun} added`;
  if (verb === 'update') return `${noun} changed`;
  return `${noun}: ${humanise(verb)}`;
}

/** The consent text the API records when a changed address resets consent (decision 8). */
const ADDRESS_CHANGED_TEXT = 'address_changed.v1';

const CONSENT_EVENT_CHANNELS: Readonly<Record<string, string>> = {
  sms: 'SMS',
  email: 'Email',
  whatsapp: 'WhatsApp',
  push: 'App notification',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Field names people care about in a timeline, with the bookkeeping columns left out. */
const QUIET_FIELDS = new Set([
  'Id',
  'Company id',
  'Created at',
  'Created by',
  'Updated at',
  'Property id',
  'Unit id',
  'Tenant id',
  'Person id',
  'Advance checked at',
]);

/**
 * One line under a timeline event: what changed, or for consent and reveals what was recorded.
 * Values that are personal (phones, emails, ID numbers) arrive redacted from the database and
 * are only ever named, never shown (CLAUDE.md section 10).
 */
export function timelineDetail(action: string, data: unknown): string | null {
  if (!isRecord(data)) return null;
  if (action === 'consent_event.insert' && isRecord(data.after)) {
    // M6 adds WhatsApp and app notifications (CM-09).
    const channel = CONSENT_EVENT_CHANNELS[String(data.after.channel)] ?? 'SMS';
    const granted = data.after.action === 'grant';
    // Decision 8 (C3): a changed phone or email resets consent; nobody withdrew it.
    const version = data.after.text_version ?? data.after.textVersion;
    if (!granted && version === ADDRESS_CHANGED_TEXT)
      return `${channel}: consent reset because the ${data.after.channel === 'email' ? 'email address' : 'phone number'} changed`;
    return `${channel}: ${granted ? 'agreed to messages' : 'withdrew consent'}`;
  }
  if ((action === 'id_number.revealed' || action === 'tin.revealed') && data.reason)
    return `Reason: ${String(data.reason)}`;
  const summary = summarise(data);
  if (summary.kind !== 'changed') return null;
  const fields = summary.changes.map((c) => c.field).filter((f) => !QUIET_FIELDS.has(f));
  if (fields.length === 0) return null;
  const status = summary.changes.find((c) => c.field === 'Status');
  const statusText =
    status && status.before && status.after
      ? `Status: ${statusWord(status.before)} → ${statusWord(status.after)}. `
      : '';
  const rest = fields.filter((f) => f !== 'Status');
  return `${statusText}${rest.length ? `Changed: ${rest.slice(0, 6).join(', ')}${rest.length > 6 ? '…' : ''}` : ''}`.trim();
}

function statusWord(value: string): string {
  return value in LEASE_STATUS_LABELS ? LEASE_STATUS_LABELS[value as LeaseStatus] : value;
}
