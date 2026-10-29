import type { LeaseDetailView } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import type { SignerRole } from '@rent/domain/esign';
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

/** Problems with the signers, by party key; `paper` checks the signing dates against `today`. */
export function partyErrors(
  parties: readonly PartyDraft[],
  options: { readonly paper?: boolean; readonly today?: string } = {},
): PartyErrors {
  const errors: Record<string, string> = {};
  for (const p of parties) {
    const name = p.name.trim();
    if (name.length < 2 || name.length > 160) errors[p.key] = 'Enter the signer’s name';
    else if (p.phone.trim() && !e164(p.phone)) errors[p.key] = 'Enter a valid phone number';
    else if (p.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email.trim()))
      errors[p.key] = 'Enter a valid email address';
    else if (options.paper && p.paperSignedOn && !ISO_DATE.test(p.paperSignedOn))
      errors[p.key] = 'Choose the date this person signed';
    else if (options.paper && options.today && p.paperSignedOn > options.today)
      errors[p.key] = 'A signing date cannot be in the future';
  }
  return errors;
}

export function partiesInput(
  parties: readonly PartyDraft[],
  options: { readonly paper?: boolean } = {},
): PartyInput[] {
  return parties.map((p) => ({
    role: p.role,
    name: p.name.trim(),
    phone: p.phone.trim() ? (e164(p.phone) ?? p.phone.trim()) : null,
    email: p.email.trim() || null,
    tenantContactId: p.tenantContactId,
    staffPersonId: p.staffPersonId,
    required: p.required,
    ...(options.paper ? { paperSignedOn: p.paperSignedOn || null } : {}),
  }));
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
