import type { LeaseDetailView, MembershipRow, TenantDetailView } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { SIGNER_ROLES, type SignerRole } from '@rent/domain/esign';
import { format, money, parseAmount } from '@rent/domain/money';
import {
  checkLeaseTerms,
  rentSchedule,
  type BreakParty,
  type ChargePeriod,
  type LeaseTerms,
  type LeaseUse,
  type RentCycle,
} from '@rent/domain/tenancy';
import { isRecord } from './errors';
import { roleLabel } from './format';
import type { ContactKind, TenantKind } from './tenancy-format';
import { e164 } from './tenant-form';

// The lease forms (TL-06; M3 plan 4.6): the builder, the draft editor and the paper lease. Terms
// are checked by the same domain function the API uses, so the form refuses what the API would.
// Amounts are typed in cedis and sent as integer pesewas (CLAUDE.md section 4).

export type CreateLeaseInput = Parameters<ApiClient['leases']['create']>[0];
export type UpdateLeaseInput = Omit<Parameters<ApiClient['leases']['update']>[0], 'leaseId'>;
export type PaperLeaseInput = Parameters<ApiClient['leases']['recordPaper']>[0];
export type PartyInput = NonNullable<CreateLeaseInput['parties']>[number];
export type TermsInput = Pick<
  CreateLeaseInput,
  | 'startDate'
  | 'endDate'
  | 'monthlyRentMinor'
  | 'cycle'
  | 'initialAdvanceMonths'
  | 'depositMinor'
  | 'serviceChargeMonthlyMinor'
  | 'steps'
  | 'breakClause'
  | 'noticeDays'
  | 'use'
>;

export interface StepDraft {
  readonly key: string;
  readonly effectiveFrom: string;
  readonly monthlyRent: string;
}

export interface BreakDraft {
  readonly fromDate: string;
  readonly party: BreakParty;
  readonly noticeDays: string;
  readonly creditUnusedDays: boolean;
}

export interface TermsDraft {
  readonly startDate: string;
  readonly endDate: string;
  /** In cedis as typed, such as `1500` or `1,500.00`. */
  readonly monthlyRent: string;
  readonly cycle: RentCycle;
  /** Months the first invoice covers; blank for none. */
  readonly initialAdvanceMonths: string;
  readonly deposit: string;
  readonly serviceCharge: string;
  readonly steps: readonly StepDraft[];
  readonly breakClause: BreakDraft | null;
  readonly noticeDays: string;
  /** Blank: from the unit's band, as the API decides. */
  readonly use: LeaseUse | '';
}

export type TermsField = Exclude<keyof TermsDraft, never>;
export type TermsErrors = Partial<Record<TermsField, string>>;

export function emptyTerms(startDate = ''): TermsDraft {
  return {
    startDate,
    endDate: startDate ? endAfterMonths(startDate, 12) : '',
    monthlyRent: '',
    cycle: 'monthly',
    initialAdvanceMonths: '',
    deposit: '',
    serviceCharge: '',
    steps: [],
    breakClause: null,
    noticeDays: '30',
    use: '',
  };
}

let nextKey = 0;
export const newKey = (prefix: string): string => {
  nextKey += 1;
  return `${prefix}-${nextKey}`;
};

/** The last day of a term of `months` months from `start` (1 Jan + 12 months ends 31 Dec). */
export function endAfterMonths(start: string, months: number): string {
  try {
    return toIsoDate(addDays(addMonths(parseBusinessDate(start), months), -1));
  } catch {
    return '';
  }
}

/** Pesewas as a cedi amount for an input box: 150000 becomes `1500.00`. */
export function amountInput(amountMinor: number | null | undefined): string {
  if (amountMinor === null || amountMinor === undefined) return '';
  return format(money(amountMinor)).replace('GH₵', '').replace(/,/g, '');
}

/** A cedi amount typed by a person, in pesewas; null when it is blank; an error when it is not money. */
function minorOf(text: string): { value: number | null; problem: string | null } {
  if (!text.trim()) return { value: null, problem: null };
  try {
    const parsed = parseAmount(text.replace(/^\s*GH₵\s*/i, '')).amountMinor;
    if (parsed < 0) return { value: null, problem: 'Enter an amount of zero or more' };
    return { value: parsed, problem: null };
  } catch {
    return { value: null, problem: 'Enter an amount in cedis, such as 1500 or 1,500.50' };
  }
}

function wholeOf(text: string, min: number, max: number): { value: number | null; ok: boolean } {
  if (!text.trim()) return { value: null, ok: true };
  if (!/^\d{1,4}$/.test(text.trim())) return { value: null, ok: false };
  const value = Number.parseInt(text.trim(), 10);
  return { value, ok: value >= min && value <= max };
}

/** Which field each of the domain's lease-term errors belongs to. */
const ERROR_FIELDS: Record<string, TermsField> = {
  'lease.end_before_start': 'endDate',
  'lease.term_too_long': 'endDate',
  'lease.rent_invalid': 'monthlyRent',
  'lease.cycle_invalid': 'cycle',
  'lease.cycle_longer_than_term': 'cycle',
  'lease.advance_invalid': 'initialAdvanceMonths',
  'lease.deposit_invalid': 'deposit',
  'lease.service_charge_invalid': 'serviceCharge',
  'lease.step_date_invalid': 'steps',
  'lease.step_rent_invalid': 'steps',
  'lease.break_date_invalid': 'breakClause',
  'lease.break_party_invalid': 'breakClause',
  'lease.break_notice_invalid': 'breakClause',
  'lease.notice_invalid': 'noticeDays',
  'lease.use_invalid': 'use',
  'date.invalid': 'startDate',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Terms as the API takes them, or the problems with the draft by field (TL-06). The cross-field
 * rules (end after start, steps on rent periods, advance within the term) come from the domain.
 */
export function termsFromDraft(
  draft: TermsDraft,
  fallbackUse: LeaseUse = 'residential',
): {
  readonly input: TermsInput | null;
  readonly terms: LeaseTerms | null;
  readonly errors: TermsErrors;
} {
  const errors: { -readonly [K in TermsField]?: string } = {};
  if (!ISO_DATE.test(draft.startDate)) errors.startDate = 'Choose the first day of the lease';
  if (!ISO_DATE.test(draft.endDate)) errors.endDate = 'Choose the last day of the lease';
  const rent = minorOf(draft.monthlyRent);
  if (rent.problem) errors.monthlyRent = rent.problem;
  else if (rent.value === null || rent.value === 0) errors.monthlyRent = 'Enter the monthly rent';
  const deposit = minorOf(draft.deposit);
  if (deposit.problem) errors.deposit = deposit.problem;
  const service = minorOf(draft.serviceCharge);
  if (service.problem) errors.serviceCharge = service.problem;
  else if (service.value === 0)
    errors.serviceCharge = 'Leave it blank if there is no service charge';
  const advance = wholeOf(draft.initialAdvanceMonths, 1, 600);
  if (!advance.ok) errors.initialAdvanceMonths = 'Enter a number of months, such as 12';
  const notice = wholeOf(draft.noticeDays, 0, 3650);
  if (!notice.ok || notice.value === null) errors.noticeDays = 'Enter the notice period in days';
  const steps = draft.steps.map((s) => ({ ...s, rent: minorOf(s.monthlyRent) }));
  if (steps.some((s) => !ISO_DATE.test(s.effectiveFrom) || s.rent.problem || !s.rent.value))
    errors.steps = 'Give each rent change a date and a new monthly rent';
  let breakClause: TermsInput['breakClause'] = null;
  if (draft.breakClause) {
    const days = wholeOf(draft.breakClause.noticeDays, 0, 3650);
    if (!ISO_DATE.test(draft.breakClause.fromDate) || !days.ok || days.value === null)
      errors.breakClause = 'Give the break clause a start date and a notice period in days';
    else
      breakClause = {
        fromDate: draft.breakClause.fromDate,
        party: draft.breakClause.party,
        noticeDays: days.value,
        creditUnusedDays: draft.breakClause.creditUnusedDays,
      };
  }
  if (Object.keys(errors).length) return { input: null, terms: null, errors };

  const input: TermsInput = {
    startDate: draft.startDate,
    endDate: draft.endDate,
    monthlyRentMinor: rent.value!,
    cycle: draft.cycle,
    initialAdvanceMonths: advance.value,
    depositMinor: deposit.value,
    serviceChargeMonthlyMinor: service.value,
    steps: steps.map((s) => ({ effectiveFrom: s.effectiveFrom, monthlyRentMinor: s.rent.value! })),
    breakClause,
    noticeDays: notice.value!,
    ...(draft.use ? { use: draft.use } : {}),
  };
  try {
    const terms = checkLeaseTerms({ ...input, use: draft.use || fallbackUse });
    return { input, terms, errors: {} };
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
    const message =
      isRecord(error) && typeof error.message === 'string' ? error.message : 'Check the terms';
    return { input: null, terms: null, errors: { [ERROR_FIELDS[code] ?? 'startDate']: message } };
  }
}

/** A saved lease's terms as a draft, for the draft editor. */
export function termsDraftOf(lease: LeaseDetailView): TermsDraft {
  const t = lease.terms;
  return {
    startDate: t.startDate,
    endDate: t.endDate,
    monthlyRent: amountInput(t.monthlyRentMinor),
    cycle: t.cycle,
    initialAdvanceMonths: t.initialAdvanceMonths === null ? '' : String(t.initialAdvanceMonths),
    deposit: amountInput(t.depositMinor),
    serviceCharge: amountInput(t.serviceChargeMonthlyMinor),
    steps: t.steps.map((s) => ({
      key: newKey('step'),
      effectiveFrom: s.effectiveFrom,
      monthlyRent: amountInput(s.monthlyRentMinor),
    })),
    breakClause: t.breakClause
      ? {
          fromDate: t.breakClause.fromDate,
          party: t.breakClause.party,
          noticeDays: String(t.breakClause.noticeDays),
          creditUnusedDays: t.breakClause.creditUnusedDays,
        }
      : null,
    noticeDays: String(t.noticeDays),
    use: lease.use,
  };
}

/** The rent schedule these terms would make, before anything is saved (TL-06). */
export function projectedSchedule(terms: LeaseTerms | null): ChargePeriod[] {
  return terms ? rentSchedule(terms) : [];
}

// Parties ----------------------------------------------------------------------------------------

export interface PartyDraft {
  readonly key: string;
  readonly role: SignerRole;
  readonly name: string;
  readonly phone: string;
  readonly email: string;
  readonly tenantContactId: string | null;
  readonly staffPersonId: string | null;
  readonly required: boolean;
  /** Paper leases only: when this person signed. Blank takes the lease's signing date. */
  readonly paperSignedOn: string;
}

export type PartyErrors = Readonly<Record<string, string>>;

export function emptyParty(role: SignerRole, name = ''): PartyDraft {
  return {
    key: newKey('party'),
    role,
    name,
    phone: '',
    email: '',
    tenantContactId: null,
    staffPersonId: null,
    required: true,
    paperSignedOn: '',
  };
}

export function partyDraftsOf(lease: LeaseDetailView): PartyDraft[] {
  return lease.parties.map((p) => ({
    key: p.id,
    role: p.role,
    name: p.name,
    phone: p.phone ?? '',
    email: p.email ?? '',
    tenantContactId: p.tenantContactId,
    staffPersonId: p.staffPersonId,
    required: p.required,
    paperSignedOn: p.paperSignedOn ?? '',
  }));
}

/**
 * Whether someone signs the lease in this part, such as the witness. A signer's part in a lease is
 * not anyone's access to the system, which only the policy decides.
 */
export function signsAs(
  parties: readonly { readonly role: SignerRole }[],
  part: SignerRole,
): boolean {
  return parties.map((p) => p.role).includes(part);
}

// Signers and their records (plan 4.8). When a lease is sent, the API takes a signer's phone and
// email from the record they are linked to: the tenant's own record for the tenant, the contact's
// for anyone added from the tenant's contacts (a guarantor, a signatory, someone else who lives
// there), the person's for a member of staff. Only someone not on record signs with what was
// typed for them. Each falls back to the signer's own details where the record has none, as the
// API does.

/** What record a signer's phone and email come from; null for someone not on record. */
export type PartyLink = 'tenant_record' | 'contact' | 'staff' | null;

type Linkable = Pick<PartyDraft, 'role' | 'tenantContactId' | 'staffPersonId'>;

/** The record a signer is linked to, in the order the API looks: contact, staff, the tenant. */
export function partyLink(party: Linkable): PartyLink {
  if (party.tenantContactId) return 'contact';
  if (party.staffPersonId) return 'staff';
  return signsAs([party], 'tenant') ? 'tenant_record' : null;
}

export interface ContactRecord {
  readonly id: string;
  readonly kind: ContactKind;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
}

export interface StaffRecord {
  readonly personId: string;
  readonly name: string;
  readonly email: string | null;
  /** The API lists staff phones masked; the full number stays on their record. */
  readonly phoneMasked: string | null;
  readonly roleLabel: string;
}

/**
 * The records this screen could read, each null when it could not: the lease's tenant, the
 * tenant's contacts that are not archived, and the company's active members (only for people who
 * may list them).
 */
export interface SignerRecords {
  readonly tenant: {
    readonly name: string;
    readonly kind: TenantKind;
    readonly phone: string | null;
    readonly email: string | null;
  } | null;
  readonly contacts: readonly ContactRecord[] | null;
  readonly staff: readonly StaffRecord[] | null;
}

export const NO_RECORDS: SignerRecords = { tenant: null, contacts: null, staff: null };

/** The records from what the API returned; a null input could not be read. */
export function signerRecordsOf(
  tenant: Pick<TenantDetailView, 'displayName' | 'kind' | 'phone' | 'email' | 'contacts'> | null,
  memberships:
    | readonly Pick<
        MembershipRow,
        'personId' | 'name' | 'email' | 'phoneMasked' | 'role' | 'status'
      >[]
    | null,
): SignerRecords {
  return {
    tenant: tenant
      ? { name: tenant.displayName, kind: tenant.kind, phone: tenant.phone, email: tenant.email }
      : null,
    contacts: tenant
      ? tenant.contacts
          .filter((c) => !c.archived)
          .map((c) => ({ id: c.id, kind: c.kind, name: c.name, phone: c.phone, email: c.email }))
      : null,
    staff: memberships
      ? memberships
          .filter((m) => m.status === 'active')
          .map((m) => ({
            personId: m.personId,
            name: m.name,
            email: m.email,
            phoneMasked: m.phoneMasked,
            roleLabel: roleLabel(m.role),
          }))
      : null,
  };
}

/**
 * Where a signer's link and codes will go when the lease is sent:
 * - `record`: from the record they are linked to (its phone and email, else their own);
 * - `typed`: someone not on record, with the phone and email typed for them;
 * - `unknown`: linked to a record this screen could not read; the API reads it when it is sent;
 * - `missing`: linked to a contact who is archived, or a person no longer active in the company.
 */
export type SignerContact =
  | {
      readonly from: 'record' | 'typed';
      readonly phone: string | null;
      readonly email: string | null;
    }
  | { readonly from: 'unknown' }
  | { readonly from: 'missing'; readonly link: 'contact' | 'staff' };

type Contactable = Linkable & {
  readonly phone: string | null;
  readonly email: string | null;
};

export function signerContact(party: Contactable, records: SignerRecords): SignerContact {
  const own = { phone: party.phone || null, email: party.email || null };
  const fromRecord = (phone: string | null, email: string | null): SignerContact => ({
    from: 'record',
    phone: phone ?? own.phone,
    email: email ?? own.email,
  });
  switch (partyLink(party)) {
    case 'contact': {
      if (!records.contacts) return { from: 'unknown' };
      const contact = records.contacts.find((c) => c.id === party.tenantContactId);
      return contact
        ? fromRecord(contact.phone, contact.email)
        : { from: 'missing', link: 'contact' };
    }
    case 'staff': {
      if (!records.staff) return { from: 'unknown' };
      const person = records.staff.find((s) => s.personId === party.staffPersonId);
      return person
        ? fromRecord(person.phoneMasked, person.email)
        : { from: 'missing', link: 'staff' };
    }
    case 'tenant_record':
      return records.tenant
        ? fromRecord(records.tenant.phone, records.tenant.email)
        : { from: 'unknown' };
    case null:
      return { from: 'typed', ...own };
  }
}

/** Where a signer's link and codes go, in words, for the editor and the send confirmation. */
export function signerContactLine(contact: SignerContact): string {
  switch (contact.from) {
    case 'record': {
      const where = [contact.phone, contact.email].filter(Boolean).join(' · ');
      return where ? `${where} (from their record)` : 'No phone or email on their record';
    }
    case 'typed':
      return [contact.phone, contact.email].filter(Boolean).join(' · ') || 'No phone or email';
    case 'unknown':
      return 'The phone and email on their record';
    case 'missing':
      return contact.link === 'contact'
        ? 'No longer one of the tenant’s contacts'
        : 'No longer an active member of your company';
  }
}

/** Signers who always sign before a lease takes effect (the backend enforces it too). */
const ALWAYS_SIGNS: Record<SignerRole, boolean> = {
  tenant: true,
  signatory: true,
  landlord: true,
  guarantor: false,
  witness: false,
};

/**
 * Whether this signer must sign whatever the draft says: the tenant, a signatory, the landlord's
 * signer, and a witness when the lease asks for one.
 */
export function mustSign(party: Pick<PartyDraft, 'role'>, witnessRequired: boolean): boolean {
  return ALWAYS_SIGNS[party.role] || (witnessRequired && signsAs([party], 'witness'));
}

/** The parts a member of staff may sign in: for the landlord, or as a witness. */
const STAFF_PARTS: Record<SignerRole, boolean> = {
  tenant: false,
  signatory: false,
  landlord: true,
  guarantor: false,
  witness: true,
};
export const STAFF_SIGNER_ROLES: readonly SignerRole[] = SIGNER_ROLES.filter((r) => STAFF_PARTS[r]);
export const staffMaySignAs = (role: SignerRole): boolean => STAFF_PARTS[role];

/**
 * The parts someone not on record may be added in. The tenant always signs from their record, so
 * they are added as the tenant, never typed in.
 */
const TYPED_PARTS: Record<SignerRole, boolean> = {
  tenant: false,
  signatory: true,
  landlord: true,
  guarantor: true,
  witness: true,
};
export const TYPED_SIGNER_ROLES: readonly SignerRole[] = SIGNER_ROLES.filter((r) => TYPED_PARTS[r]);

/**
 * The parts a tenant's contact may sign in, by the kind of tenant. Someone else who lives there
 * signs as the tenant from their own contact record, so their link and codes go to their phone.
 */
const CONTACT_PARTS: Record<TenantKind, readonly SignerRole[]> = {
  individual: ['tenant', 'guarantor', 'witness'],
  company: ['signatory', 'guarantor', 'witness'],
};

/** The part a contact usually signs in, by kind; staff can choose another of CONTACT_PARTS. */
const CONTACT_USUAL_PART: Record<ContactKind, SignerRole> = {
  signatory: 'signatory',
  guarantor: 'guarantor',
  next_of_kin: 'witness',
  employer: 'witness',
  finance: 'witness',
};

/** The parts a contact of this tenant may sign in. */
export function contactParts(kind: TenantKind | null): readonly SignerRole[] {
  return kind ? CONTACT_PARTS[kind] : ['guarantor', 'witness'];
}

/** The part a contact is offered first: the usual one for their kind, if this tenant allows it. */
export function usualContactPart(contact: ContactRecord, kind: TenantKind | null): SignerRole {
  const parts = contactParts(kind);
  const usual = CONTACT_USUAL_PART[contact.kind];
  return parts.includes(usual) ? usual : (parts.at(-1) ?? 'witness');
}

export const ONE_TENANT_PROBLEM =
  'Only one signer signs as the tenant from the tenant’s record. Add anyone else who lives there as one of the tenant’s contacts, then add them from the contacts.';
export const STAFF_PART_PROBLEM =
  'A member of your staff signs only for the landlord or as a witness.';

/** Which field a signer's problem belongs to, so the screen can tie it to that input. */
export type PartyField = 'role' | 'name' | 'phone' | 'email' | 'paperSignedOn' | 'record';

export interface PartyProblem {
  readonly field: PartyField;
  readonly message: string;
}

export type PartyProblems = Readonly<Record<string, PartyProblem>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Problems with the signers, by party key, each with the field it belongs to. `paper` checks the
 * signing dates against `today`. Unless it is paper, only one signer may sign as the tenant from
 * the tenant's record, as the API requires when the lease is sent. With `records`, a signer linked
 * to a record that is gone (an archived contact, a person no longer active in the company) is a
 * problem too.
 */
export function partyProblems(
  parties: readonly PartyDraft[],
  options: {
    readonly paper?: boolean;
    readonly today?: string;
    readonly records?: SignerRecords | null;
  } = {},
): PartyProblems {
  const problems: Record<string, PartyProblem> = {};
  let tenantSigns = false;
  for (const p of parties) {
    const name = p.name.trim();
    const asTenantItself = !options.paper && partyLink(p) === 'tenant_record';
    const problem = (field: PartyField, message: string) => {
      problems[p.key] = { field, message };
    };
    if (name.length < 2 || name.length > 160) problem('name', 'Enter the signer’s name');
    else if (p.phone.trim() && !e164(p.phone)) problem('phone', 'Enter a valid phone number');
    else if (p.email.trim() && !EMAIL.test(p.email.trim()))
      problem('email', 'Enter a valid email address');
    else if (options.paper && p.paperSignedOn && !ISO_DATE.test(p.paperSignedOn))
      problem('paperSignedOn', 'Choose the date this person signed');
    else if (options.paper && options.today && p.paperSignedOn > options.today)
      problem('paperSignedOn', 'A signing date cannot be in the future');
    else if (tenantSigns && asTenantItself) problem('role', ONE_TENANT_PROBLEM);
    else if (p.staffPersonId && !STAFF_PARTS[p.role]) problem('role', STAFF_PART_PROBLEM);
    else if (options.records) {
      const contact = signerContact(p, options.records);
      if (contact.from === 'missing')
        problem(
          'record',
          contact.link === 'contact'
            ? `${name} is no longer one of the tenant’s contacts. Remove them, or add them as a contact again.`
            : `${name} is no longer an active member of your company. Remove them, or add someone else.`,
        );
    }
    if (asTenantItself) tenantSigns = true;
  }
  return problems;
}

/** Problems with the signers, by party key, in words. */
export function partyErrors(
  parties: readonly PartyDraft[],
  options: { readonly paper?: boolean; readonly today?: string } = {},
): PartyErrors {
  return Object.fromEntries(
    Object.entries(partyProblems(parties, options)).map(([key, p]) => [key, p.message]),
  );
}

/**
 * The signers as the API takes them. Those who always sign are sent as required whatever the
 * draft says, so an older draft cannot carry one as optional.
 */
export function partiesInput(
  parties: readonly PartyDraft[],
  options: { readonly paper?: boolean; readonly witnessRequired?: boolean } = {},
): PartyInput[] {
  return parties.map((p) => ({
    role: p.role,
    name: p.name.trim(),
    phone: p.phone.trim() ? (e164(p.phone) ?? p.phone.trim()) : null,
    email: p.email.trim() || null,
    tenantContactId: p.tenantContactId,
    staffPersonId: p.staffPersonId,
    required: p.required || mustSign(p, options.witnessRequired ?? false),
    ...(options.paper ? { paperSignedOn: p.paperSignedOn || null } : {}),
  }));
}

/** The tenant signing for themselves, from their record (an individual tenant). */
export function tenantSigner(records: SignerRecords, name: string): PartyDraft {
  return {
    ...emptyParty('tenant', records.tenant?.name ?? name),
    phone: records.tenant?.phone ?? '',
    email: records.tenant?.email ?? '',
  };
}

/** Whether the tenant can be added as a signer: a person, not yet signing. */
export function canAddTenant(kind: TenantKind | null, parties: readonly PartyDraft[]): boolean {
  return kind === 'individual' && !parties.some((p) => partyLink(p) === 'tenant_record');
}

/** The tenant's contacts who are not signing yet. */
export function contactChoices(
  records: SignerRecords,
  parties: readonly PartyDraft[],
): ContactRecord[] {
  return (records.contacts ?? []).filter((c) => !parties.some((p) => p.tenantContactId === c.id));
}

/**
 * One of the tenant's contacts as a signer, in a part a contact of this tenant may take; null for
 * any other part (a contact never signs for the landlord).
 */
export function contactSigner(
  contact: ContactRecord,
  role: SignerRole,
  kind: TenantKind | null,
): PartyDraft | null {
  if (!contactParts(kind).includes(role)) return null;
  return {
    ...emptyParty(role, contact.name),
    phone: contact.phone ?? '',
    email: contact.email ?? '',
    tenantContactId: contact.id,
  };
}

/** Active members of staff who are not signing yet. */
export function staffChoices(
  records: SignerRecords,
  parties: readonly PartyDraft[],
): StaffRecord[] {
  return (records.staff ?? []).filter((s) => !parties.some((p) => p.staffPersonId === s.personId));
}

/**
 * A member of staff as a signer, for the landlord or as a witness. Their phone stays on their
 * record (the API lists it masked), and the API reads it when the lease is sent.
 */
export function staffSigner(person: StaffRecord, role: SignerRole): PartyDraft | null {
  if (!STAFF_PARTS[role]) return null;
  return {
    ...emptyParty(role, person.name),
    email: person.email ?? '',
    staffPersonId: person.personId,
  };
}

/** Phones or emails typed one per line or separated by commas. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The electronic-service contacts (prd-issues 25): the phones and emails the tenant agrees to be
 * served at. Up to five of each; phones go as E.164.
 */
export function serviceContacts(
  phones: string,
  emails: string,
): { readonly phones: string[]; readonly emails: string[]; readonly problem: string | null } {
  const phoneList = splitList(phones);
  const emailList = splitList(emails);
  const bad = phoneList.find((p) => !e164(p));
  if (bad) return { phones: [], emails: [], problem: `${bad} is not a phone number` };
  const badEmail = emailList.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (badEmail) return { phones: [], emails: [], problem: `${badEmail} is not an email address` };
  if (phoneList.length > 5 || emailList.length > 5)
    return { phones: [], emails: [], problem: 'Give at most five phones and five emails' };
  return { phones: phoneList.map((p) => e164(p)!), emails: emailList, problem: null };
}
