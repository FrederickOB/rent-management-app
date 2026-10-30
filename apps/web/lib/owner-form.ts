import type { OwnerRow } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import { DEFAULT_TIME_ZONE, isValidTimeZone } from '@rent/domain/dates';
import { checkOwnerReference, type OwnerKind } from '@rent/domain/portfolio';
import { checkTin } from '@rent/domain/tenancy';
import { changedFields } from './patch';
import { domainProblem } from './register-format';

/** The owner form (AD-02): an agency's client, or the landlord in their own company. */
export interface OwnerDraft {
  readonly kind: OwnerKind;
  readonly displayName: string;
  readonly legalName: string;
  readonly reference: string;
  readonly phone: string;
  readonly email: string;
  /** Two-letter country code (ISO 3166), for owners who live abroad. */
  readonly residenceCountry: string;
  readonly timeZone: string;
  readonly notes: string;
  /** M3 tax fields (plan 4.13): rent tax (OQ-18) and VAT on commercial rent (OQ-20) read them. */
  readonly lettingBusiness: boolean;
  readonly vatRegistered: boolean;
  /** A new TIN to store, encrypted; blank keeps the stored one, which is never shown here. */
  readonly tin: string;
  /** Clears the stored TIN. */
  readonly removeTin: boolean;
}

export type OwnerErrors = Partial<Record<keyof OwnerDraft, string>>;

export type CreateOwnerInput = Parameters<ApiClient['owners']['create']>[0];
export type UpdateOwnerInput = Omit<Parameters<ApiClient['owners']['update']>[0], 'ownerId'>;

export function ownerDraftOf(row?: OwnerRow): OwnerDraft {
  return {
    kind: row?.kind ?? 'individual',
    displayName: row?.displayName ?? '',
    legalName: row?.legalName ?? '',
    reference: row?.reference ?? '',
    phone: row?.phone ?? '',
    email: row?.email ?? '',
    residenceCountry: row?.residenceCountry ?? '',
    timeZone: row?.timeZone ?? DEFAULT_TIME_ZONE,
    notes: row?.notes ?? '',
    lettingBusiness: row?.lettingBusiness ?? false,
    vatRegistered: row?.vatRegistered ?? false,
    tin: '',
    removeTin: false,
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ownerErrors(draft: OwnerDraft): OwnerErrors {
  const errors: { -readonly [K in keyof OwnerDraft]?: string } = {};
  const name = draft.displayName.trim();
  if (name.length < 2 || name.length > 120)
    errors.displayName = 'Enter a name of 2 to 120 characters';
  if (draft.legalName.trim().length > 160) errors.legalName = 'Use at most 160 characters';
  if (draft.reference.trim()) {
    const problem = domainProblem(() => checkOwnerReference(draft.reference));
    if (problem) errors.reference = problem;
  }
  if (draft.phone.trim().length > 20) errors.phone = 'Use at most 20 characters';
  if (draft.email.trim() && !EMAIL.test(draft.email.trim()))
    errors.email = 'Enter an email address such as owner@example.com';
  if (draft.residenceCountry.trim() && !/^[A-Za-z]{2}$/.test(draft.residenceCountry.trim()))
    errors.residenceCountry = 'Use the two-letter country code, such as GH or GB';
  if (!isValidTimeZone(draft.timeZone.trim()))
    errors.timeZone = 'Choose a time zone from the list, such as Africa/Accra';
  if (draft.notes.length > 1000) errors.notes = 'Use at most 1,000 characters';
  if (draft.tin.trim() && !draft.removeTin) {
    const problem = domainProblem(() => checkTin(draft.tin));
    if (problem) errors.tin = problem;
  }
  return errors;
}

const orNull = (value: string) => value.trim() || null;

function values(draft: OwnerDraft) {
  return {
    kind: draft.kind,
    displayName: draft.displayName.trim(),
    legalName: orNull(draft.legalName),
    phone: orNull(draft.phone),
    email: orNull(draft.email),
    residenceCountry: orNull(draft.residenceCountry.toUpperCase()),
    timeZone: draft.timeZone.trim(),
    notes: orNull(draft.notes),
  };
}

/** The tax fields of a new owner, sent only when they say something (plan 4.13). */
function taxValues(draft: OwnerDraft) {
  return {
    ...(draft.lettingBusiness ? { lettingBusiness: true } : {}),
    ...(draft.vatRegistered ? { vatRegistered: true } : {}),
    ...(draft.tin.trim() ? { tin: draft.tin.trim().toUpperCase() } : {}),
  };
}

/** A new owner. An empty reference lets the API give the next free OWN-nn. */
export function ownerCreateInput(draft: OwnerDraft): CreateOwnerInput {
  const reference = draft.reference.trim().toUpperCase();
  return { ...values(draft), ...taxValues(draft), ...(reference ? { reference } : {}) };
}

/** Only what changed, so the audit log shows exactly what someone edited (AD-07). */
export function ownerPatch(row: OwnerRow, draft: OwnerDraft): UpdateOwnerInput {
  const before = values(ownerDraftOf(row));
  const after = values(draft);
  const patch: UpdateOwnerInput = changedFields(before, after);
  const tax: UpdateOwnerInput = {
    ...(draft.lettingBusiness !== (row.lettingBusiness ?? false)
      ? { lettingBusiness: draft.lettingBusiness }
      : {}),
    ...(draft.vatRegistered !== (row.vatRegistered ?? false)
      ? { vatRegistered: draft.vatRegistered }
      : {}),
    ...(draft.removeTin && row.tinMasked
      ? { tin: null }
      : draft.tin.trim() && !draft.removeTin
        ? { tin: draft.tin.trim().toUpperCase() }
        : {}),
  };
  const reference = draft.reference.trim().toUpperCase();
  return reference && reference !== row.reference
    ? { ...patch, ...tax, reference }
    : { ...patch, ...tax };
}

let regionNames: Intl.DisplayNames | null | undefined;

/** `GB` as `United Kingdom (GB)`, where the browser knows the name. */
export function countryLabel(code: string | null): string | null {
  if (!code) return null;
  try {
    regionNames ??= new Intl.DisplayNames(['en-GB'], { type: 'region' });
    const name = regionNames.of(code.toUpperCase());
    return name && name !== code ? `${name} (${code.toUpperCase()})` : code.toUpperCase();
  } catch {
    regionNames = null;
    return code.toUpperCase();
  }
}

/** Time zones for the suggestions list; the API checks the value again. */
export function timeZoneSuggestions(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [DEFAULT_TIME_ZONE, 'Europe/London', 'America/New_York'];
  }
}
