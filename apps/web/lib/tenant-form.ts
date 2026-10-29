import type { ContactRow, TenantDetailView } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import { CURRENT_CONSENT_TEXT, consentText, type MessageChannel } from '@rent/domain/messaging';
import { tryNormalisePhone } from '@rent/domain/phone';
import { checkGhanaCard, checkPassport, checkTin } from '@rent/domain/tenancy';
import { changedFields } from './patch';
import { domainProblem } from './register-format';
import type { ContactKind, IdType, TenantKind } from './tenancy-format';

// The tenant forms (TL-01 to TL-04; M3 plan 4.3 and 4.4, decision 2). The API checks everything
// again; these checks only answer sooner. ID numbers and TINs are typed, sent once and never
// shown again except through an audited reveal.

export type CreateTenantInput = Parameters<ApiClient['tenants']['create']>[0];
export type UpdateTenantInput = Omit<Parameters<ApiClient['tenants']['update']>[0], 'tenantId'>;
export type ContactInput = NonNullable<CreateTenantInput['contacts']>[number];
export type ContactPatch = Omit<
  Parameters<ApiClient['tenants']['updateContact']>[0],
  'tenantId' | 'contactId'
>;

/** What staff record a person agreed to, by channel, in the words stored with it (decision 2). */
export function consentWording(channel: MessageChannel): string {
  return consentText(CURRENT_CONSENT_TEXT, channel);
}
export const CONSENT_VERSION = CURRENT_CONSENT_TEXT;

export interface ConsentDraft {
  readonly sms: boolean;
  readonly email: boolean;
}

export interface ContactDraft {
  /** A key for the list on screen only. */
  readonly key: string;
  readonly kind: ContactKind;
  readonly name: string;
  readonly phone: string;
  readonly email: string;
  readonly relationship: string;
  readonly organisation: string;
  readonly position: string;
  readonly consent: ConsentDraft;
}

export interface TenantDraft {
  readonly kind: TenantKind;
  readonly displayName: string;
  readonly legalName: string;
  readonly phone: string;
  readonly whatsappPhone: string;
  readonly email: string;
  readonly occupation: string;
  readonly businessType: string;
  readonly registrationNumber: string;
  readonly notes: string;
  /** '' records no ID number. Individuals only. */
  readonly idType: IdType | '';
  readonly idNumber: string;
  /** Two letters, for a passport. */
  readonly idCountry: string;
  /** Companies only; an individual's TIN is their Ghana Card number. */
  readonly tin: string;
  readonly consent: ConsentDraft;
  readonly contacts: readonly ContactDraft[];
}

export type TenantErrors = Partial<Record<Exclude<keyof TenantDraft, 'contacts'>, string>> & {
  readonly contacts?: Readonly<Record<string, Partial<Record<keyof ContactDraft, string>>>>;
};

const NO_CONSENT: ConsentDraft = { sms: false, email: false };

export function emptyTenantDraft(kind: TenantKind = 'individual'): TenantDraft {
  return {
    kind,
    displayName: '',
    legalName: '',
    phone: '',
    whatsappPhone: '',
    email: '',
    occupation: '',
    businessType: '',
    registrationNumber: '',
    notes: '',
    idType: '',
    idNumber: '',
    idCountry: '',
    tin: '',
    consent: NO_CONSENT,
    contacts: [],
  };
}

let nextKey = 0;
export function emptyContact(kind: ContactKind): ContactDraft {
  nextKey += 1;
  return {
    key: `contact-${nextKey}`,
    kind,
    name: '',
    phone: '',
    email: '',
    relationship: '',
    organisation: '',
    position: '',
    consent: NO_CONSENT,
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A phone as the API stores it (E.164, +233…), or null when it is not a phone number. */
export const e164 = (text: string): string | null => tryNormalisePhone(text);

function phoneProblem(text: string): string | null {
  if (!text.trim()) return null;
  return e164(text) ? null : 'Enter a phone number such as 024 412 3456 or +233 24 412 3456';
}

function emailProblem(text: string): string | null {
  if (!text.trim()) return null;
  return EMAIL.test(text.trim()) && text.trim().length <= 254
    ? null
    : 'Enter an email address such as name@example.com';
}

function nameProblem(text: string, what: string): string | null {
  const length = text.trim().length;
  return length < 2 || length > 160 ? `Enter ${what} of 2 to 160 characters` : null;
}

/**
 * The ID number's problem, if any (TL-02): a Ghana Card is GHA- plus 9 digits and a check digit;
 * a passport needs its issuing country.
 */
export function idNumberProblem(type: IdType | '', number: string, country: string): string | null {
  if (!type) return number.trim() ? 'Choose the type of ID first' : null;
  if (!number.trim()) return null;
  return type === 'ghana_card'
    ? domainProblem(() => checkGhanaCard(number))
    : domainProblem(() => checkPassport(number, country));
}

function contactErrors(contact: ContactDraft): Partial<Record<keyof ContactDraft, string>> {
  const errors: { -readonly [K in keyof ContactDraft]?: string } = {};
  const name = nameProblem(contact.name, 'a name');
  if (name) errors.name = name;
  const phone = phoneProblem(contact.phone);
  if (phone) errors.phone = phone;
  const email = emailProblem(contact.email);
  if (email) errors.email = email;
  if (contact.consent.sms && !contact.phone.trim())
    errors.phone = 'Add a phone number, or untick SMS consent';
  if (contact.consent.email && !contact.email.trim())
    errors.email = 'Add an email address, or untick email consent';
  return errors;
}

/**
 * Problems with a tenant draft. A blank ID number or TIN is never a problem: on a new tenant it
 * records none, and when editing it keeps what is stored.
 */
export function tenantErrors(draft: TenantDraft): TenantErrors {
  const errors: { -readonly [K in Exclude<keyof TenantDraft, 'contacts'>]?: string } = {};
  const name = nameProblem(draft.displayName, 'a name');
  if (name) errors.displayName = name;
  for (const key of ['phone', 'whatsappPhone'] as const) {
    const problem = phoneProblem(draft[key]);
    if (problem) errors[key] = problem;
  }
  const email = emailProblem(draft.email);
  if (email) errors.email = email;
  if (draft.consent.sms && !draft.phone.trim())
    errors.phone = 'Add a phone number, or untick SMS consent';
  if (draft.consent.email && !draft.email.trim())
    errors.email = 'Add an email address, or untick email consent';
  if (draft.kind === 'individual') {
    const id = idNumberProblem(draft.idType, draft.idNumber, draft.idCountry);
    if (id) errors.idNumber = id;
    if (draft.idType === 'passport' && draft.idNumber.trim() && !draft.idCountry.trim())
      errors.idCountry = 'Give the issuing country as two letters, such as NG';
  } else if (draft.tin.trim()) {
    const tin = domainProblem(() => checkTin(draft.tin));
    if (tin) errors.tin = tin;
  }
  if (draft.notes.length > 2000) errors.notes = 'Use at most 2,000 characters';
  const contacts: Record<string, Partial<Record<keyof ContactDraft, string>>> = {};
  for (const contact of draft.contacts) {
    const found = contactErrors(contact);
    if (Object.keys(found).length) contacts[contact.key] = found;
  }
  return Object.keys(contacts).length ? { ...errors, contacts } : errors;
}

export const hasErrors = (errors: TenantErrors): boolean => Object.keys(errors).length > 0;

const orNull = (value: string) => value.trim() || null;
const phoneOrNull = (value: string) => (value.trim() ? (e164(value) ?? value.trim()) : null);

function contactInput(contact: ContactDraft): ContactInput {
  return {
    kind: contact.kind,
    name: contact.name.trim(),
    phone: phoneOrNull(contact.phone),
    email: orNull(contact.email),
    relationship: orNull(contact.relationship),
    organisation: orNull(contact.organisation),
    position: orNull(contact.position),
    consent: { sms: contact.consent.sms, email: contact.consent.email },
  };
}

function detailsOf(draft: TenantDraft) {
  const company = draft.kind === 'company';
  return {
    displayName: draft.displayName.trim(),
    phone: phoneOrNull(draft.phone),
    whatsappPhone: phoneOrNull(draft.whatsappPhone),
    email: orNull(draft.email),
    occupation: orNull(draft.occupation),
    notes: orNull(draft.notes),
    // Registration details are for companies only; the API refuses them on a person.
    ...(company
      ? {
          legalName: orNull(draft.legalName),
          businessType: orNull(draft.businessType),
          registrationNumber: orNull(draft.registrationNumber),
        }
      : {}),
  };
}

/** A new tenant with contacts and consent per channel, as the API takes it (TL-01 to TL-04). */
export function tenantCreateInput(draft: TenantDraft): CreateTenantInput {
  const individual = draft.kind === 'individual';
  const id =
    individual && draft.idType && draft.idNumber.trim()
      ? {
          idType: draft.idType,
          idNumber: draft.idNumber.trim(),
          ...(draft.idType === 'passport'
            ? { idCountry: draft.idCountry.trim().toUpperCase() }
            : {}),
        }
      : {};
  return {
    kind: draft.kind,
    ...detailsOf(draft),
    ...id,
    ...(!individual && draft.tin.trim() ? { tin: draft.tin.trim() } : {}),
    consent: { sms: draft.consent.sms, email: draft.consent.email },
    contacts: draft.contacts.map(contactInput),
  };
}

/** A draft from a saved tenant, for editing. ID numbers and TINs start blank: blank keeps them. */
export function tenantDraftOf(tenant: TenantDetailView): TenantDraft {
  return {
    ...emptyTenantDraft(tenant.kind),
    displayName: tenant.displayName,
    legalName: tenant.legalName ?? '',
    phone: tenant.phone ?? '',
    whatsappPhone: tenant.whatsappPhone ?? '',
    email: tenant.email ?? '',
    occupation: tenant.occupation ?? '',
    businessType: tenant.businessType ?? '',
    registrationNumber: tenant.registrationNumber ?? '',
    notes: tenant.notes ?? '',
    idType: tenant.identity.type ?? '',
    consent: tenant.consent,
  };
}

/**
 * Only what changed, so the audit log shows exactly what someone edited (AD-07). A typed ID
 * number or TIN replaces the stored one; `removeId` and `removeTin` clear them.
 */
export function tenantPatch(
  tenant: TenantDetailView,
  draft: TenantDraft,
  options: { readonly removeId?: boolean; readonly removeTin?: boolean } = {},
): UpdateTenantInput {
  const before = detailsOf(tenantDraftOf(tenant));
  const after = detailsOf(draft);
  const patch: UpdateTenantInput = changedFields(before, after);
  if (tenant.kind === 'individual') {
    if (options.removeId) return { ...patch, idType: null, idNumber: null };
    if (draft.idType && draft.idNumber.trim())
      return {
        ...patch,
        idType: draft.idType,
        idNumber: draft.idNumber.trim(),
        ...(draft.idType === 'passport' ? { idCountry: draft.idCountry.trim().toUpperCase() } : {}),
      };
    return patch;
  }
  if (options.removeTin) return { ...patch, tin: null };
  return draft.tin.trim() ? { ...patch, tin: draft.tin.trim() } : patch;
}

/** A contact as a draft, for its edit form. */
export function contactDraftOf(row: ContactRow): ContactDraft {
  return {
    key: row.id,
    kind: row.kind,
    name: row.name,
    phone: row.phone ?? '',
    email: row.email ?? '',
    relationship: row.relationship ?? '',
    organisation: row.organisation ?? '',
    position: row.position ?? '',
    consent: row.consent,
  };
}

export const contactProblems = contactErrors;

/** A new contact for an existing tenant, with the consent the person gave. */
export function contactCreateInput(contact: ContactDraft): ContactInput {
  return contactInput(contact);
}

/** The fields of a contact that changed. Consent changes go through their own endpoint. */
export function contactPatch(row: ContactRow, draft: ContactDraft): ContactPatch {
  const { kind: _kind, consent: _consent, ...before } = contactInput(contactDraftOf(row));
  const { kind: _k, consent: _c, ...after } = contactInput(draft);
  return changedFields(before, after);
}

/** The channels whose consent differs between what is stored and the draft, as API calls. */
export function consentChanges(
  before: ConsentDraft,
  after: ConsentDraft,
): { readonly channel: MessageChannel; readonly action: 'grant' | 'withdraw' }[] {
  return (['sms', 'email'] as const)
    .filter((channel) => before[channel] !== after[channel])
    .map((channel) => ({ channel, action: after[channel] ? 'grant' : 'withdraw' }));
}

/** `SMS and email`, `SMS`, or `No channel` for a consent state. */
export function consentSummary(consent: ConsentDraft): string {
  const channels = [consent.sms ? 'SMS' : null, consent.email ? 'email' : null].filter(Boolean);
  return channels.length ? channels.join(' and ') : 'No channel';
}

/** The reveal reason the API asks for (`reason`, at least 10 characters), checked sooner here. */
export const REVEAL_REASON_MIN = 10;
export function revealReasonProblem(reason: string): string | null {
  return reason.trim().length < REVEAL_REASON_MIN
    ? `Give a reason of at least ${REVEAL_REASON_MIN} characters, such as "checking the tenant's ID for the lease"`
    : null;
}
