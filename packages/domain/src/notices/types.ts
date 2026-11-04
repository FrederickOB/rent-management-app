import { z } from 'zod';
import { compareDates, parseBusinessDate, parseTimeOfDay } from '../dates';
import { DomainError } from '../errors';

/**
 * Notice types, their subtypes and mandatory fields (LN-01; PRD section 8; M7 plan 4.2). The
 * legal wording lives in the templates (decision 1); this holds the facts each notice must carry
 * and the rules that follow from its type. No legal value is held here: periods come from the
 * lease and the rules table (section 4.3).
 */
export const NOTICE_TYPES = [
  'rent_demand',
  'rent_review',
  'notice_to_quit',
  'entry',
  'breach',
  'non_renewal',
  'building_wide',
  'tenant_originated',
] as const;
export type NoticeType = (typeof NOTICE_TYPES)[number];

export const NOTICE_TYPE_LABELS: Record<NoticeType, string> = {
  rent_demand: 'Rent demand and arrears notice',
  rent_review: 'Notice of rent review or increase',
  notice_to_quit: 'Notice to quit',
  entry: 'Notice of entry',
  breach: 'Breach of tenancy notice',
  non_renewal: 'Non-renewal notice',
  building_wide: 'Building-wide notice',
  tenant_originated: 'Notice from the tenant',
};

/** Subtypes: the ground of a notice to quit, the kind of breach, the purpose of entry… */
export const NOTICE_SUBTYPES = {
  rent_demand: [],
  rent_review: [],
  notice_to_quit: ['arrears', 'breach', 'end_of_term', 'own_use', 'other'],
  entry: ['inspection', 'repairs'],
  breach: ['noise', 'unauthorised_occupants', 'sub_letting', 'damage', 'other'],
  non_renewal: [],
  building_wide: ['fire_safety', 'major_works', 'other'],
  tenant_originated: ['intention_to_vacate', 'complaint'],
} as const satisfies Record<NoticeType, readonly string[]>;
export type NoticeSubtype = (typeof NOTICE_SUBTYPES)[NoticeType][number];

export const NOTICE_SUBTYPE_LABELS: Record<NoticeSubtype, string> = {
  arrears: 'Rent arrears',
  breach: 'Breach of the tenancy',
  end_of_term: 'End of the term',
  own_use: 'Landlord’s own use',
  other: 'Other',
  inspection: 'Inspection',
  repairs: 'Repairs',
  noise: 'Noise',
  unauthorised_occupants: 'Unauthorised occupants',
  sub_letting: 'Sub-letting',
  damage: 'Damage',
  fire_safety: 'Fire safety',
  major_works: 'Major works',
  intention_to_vacate: 'Intention to vacate',
  complaint: 'Formal complaint',
};

/** What the subtype is called on each type's form. */
export const NOTICE_SUBTYPE_FIELD_LABELS: Partial<Record<NoticeType, string>> = {
  notice_to_quit: 'Ground',
  entry: 'Purpose',
  breach: 'Kind of breach',
  building_wide: 'Kind',
  tenant_originated: 'Kind',
};

/**
 * Where a type's notice period comes from (plan 4.2):
 * - `none`: no period; the link works for the company's no-period days (LN-02, prd-issues 27).
 * - `contractual`: the lease's notice days.
 * - `contractual_or_statutory`: the larger of the lease's days and the statutory minimum once
 *   the rules table holds one (D7, OQ-09).
 * - `contractual_before_lease_end`: the lease's days, and never before the lease ends.
 * - `not_recorded`: none is recorded; the composer warns.
 * - `recorded_only`: the tenant's own notice, recorded by staff (decision 13).
 */
export type NoticePeriodKind =
  | 'none'
  | 'contractual'
  | 'contractual_or_statutory'
  | 'contractual_before_lease_end'
  | 'not_recorded'
  | 'recorded_only';

/** `full`: reminders, the in-person step and escalation. `reminders_only` stops after reminders. */
export type NoticeLadderKind = 'full' | 'reminders_only' | 'none';

export interface NoticeTypeRules {
  readonly period: NoticePeriodKind;
  /** The lease's notice days apply (plan 4.3). */
  readonly usesContractualPeriod: boolean;
  /** The statutory minimum from the rules table applies, by the lease's use. */
  readonly usesStatutoryMinimum: boolean;
  /** The notice period ends on the effective date, so links expire then (LN-02). */
  readonly hasPeriod: boolean;
  /** The composer warns that no period is recorded for this type (plan 4.2). */
  readonly warnsNoPeriod: boolean;
  readonly ladder: NoticeLadderKind;
  /** Decision 10: a "post on the premises" task at issue, whether or not the tenant signs. */
  readonly postOnPremises: boolean;
  /** Decision 8: two people approve (a notice to quit); otherwise one issuer with authority. */
  readonly twoPersonApproval: boolean;
  /** OQ-16: the company's acknowledgement of the risk must be in force. */
  readonly needsQuitAcknowledgement: boolean;
  /** Act 220 s.23 (decision 3): refused inside the bar after a Rent Officer assessment. */
  readonly checksAssessmentBar: boolean;
  /** Issued and tracked; a tenant-originated notice is only recorded (decision 13). */
  readonly issuable: boolean;
  /** Addressed to a lease's tenant; a building-wide notice goes to a property's tenants. */
  readonly needsLease: boolean;
  /** The field the earliest lawful date is checked against, if any. */
  readonly keyDateField: NoticeDateField | null;
}

export type NoticeDateField = 'payBy' | 'effectiveDate' | 'entryDate' | 'remedyBy';

const rules = (r: Partial<NoticeTypeRules> & Pick<NoticeTypeRules, 'period'>): NoticeTypeRules => ({
  usesContractualPeriod: false,
  usesStatutoryMinimum: false,
  hasPeriod: false,
  warnsNoPeriod: false,
  ladder: 'full',
  postOnPremises: false,
  twoPersonApproval: false,
  needsQuitAcknowledgement: false,
  checksAssessmentBar: false,
  issuable: true,
  needsLease: true,
  keyDateField: null,
  ...r,
});

export const NOTICE_TYPE_RULES: Readonly<Record<NoticeType, NoticeTypeRules>> = {
  rent_demand: rules({ period: 'none', keyDateField: 'payBy' }),
  rent_review: rules({
    period: 'contractual',
    usesContractualPeriod: true,
    hasPeriod: true,
    keyDateField: 'effectiveDate',
  }),
  notice_to_quit: rules({
    period: 'contractual_or_statutory',
    usesContractualPeriod: true,
    usesStatutoryMinimum: true,
    hasPeriod: true,
    postOnPremises: true,
    twoPersonApproval: true,
    needsQuitAcknowledgement: true,
    checksAssessmentBar: true,
    keyDateField: 'effectiveDate',
  }),
  entry: rules({
    period: 'not_recorded',
    warnsNoPeriod: true,
    ladder: 'reminders_only',
    keyDateField: 'entryDate',
  }),
  breach: rules({ period: 'not_recorded', warnsNoPeriod: true, keyDateField: 'remedyBy' }),
  non_renewal: rules({
    period: 'contractual_before_lease_end',
    usesContractualPeriod: true,
    hasPeriod: true,
    keyDateField: 'effectiveDate',
  }),
  building_wide: rules({ period: 'none', ladder: 'reminders_only', needsLease: false }),
  tenant_originated: rules({ period: 'recorded_only', ladder: 'none', issuable: false }),
};

export const noticeTypeRules = (type: NoticeType): NoticeTypeRules => NOTICE_TYPE_RULES[type];

/** The types a company may give its own ladder: every type that has one (a test keeps it so). */
export const LADDER_NOTICE_TYPES = [
  'rent_demand',
  'rent_review',
  'notice_to_quit',
  'entry',
  'breach',
  'non_renewal',
  'building_wide',
] as const satisfies readonly NoticeType[];
export type LadderNoticeType = (typeof LADDER_NOTICE_TYPES)[number];

/** How a tenant-originated notice reached the landlord (decision 13). */
export const RECEIVED_VIA = ['in_person', 'post', 'email', 'whatsapp', 'sms', 'other'] as const;
export type ReceivedVia = (typeof RECEIVED_VIA)[number];

// Field schemas. Amounts are integer pesewas in fields ending `Minor` (CLAUDE.md section 4);
// dates are business dates (`YYYY-MM-DD`); times of day are `HH:MM`, company time.

const isoDate = z.string().refine((value) => {
  try {
    parseBusinessDate(value);
    return true;
  } catch {
    return false;
  }
}, 'Use a date such as 2026-11-30');

const timeOfDay = z.string().refine((value) => {
  try {
    parseTimeOfDay(value);
    return true;
  } catch {
    return false;
  }
}, 'Use a time such as 09:00');

const text = (max: number) => z.string().trim().min(1).max(max);
const minor = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const id = z.string().trim().min(1).max(64);
/** Decision 1: an optional paragraph for details on every template. */
const details = z.string().trim().max(2000).nullable().optional();

export const NOTICE_FIELD_SCHEMAS = {
  rent_demand: z
    .object({
      arrearsMinor: minor,
      arrearsAsOf: isoDate,
      invoiceIds: z.array(id).min(1).max(500),
      payBy: isoDate,
      details,
    })
    .strict(),
  rent_review: z
    .object({
      currentRentMinor: minor,
      newRentMinor: minor,
      effectiveDate: isoDate,
      reason: text(1000),
      details,
    })
    .strict(),
  notice_to_quit: z.object({ particulars: text(4000), effectiveDate: isoDate, details }).strict(),
  entry: z
    .object({ entryDate: isoDate, windowFrom: timeOfDay, windowTo: timeOfDay, details })
    .strict(),
  breach: z.object({ particulars: text(4000), remedyBy: isoDate, details }).strict(),
  non_renewal: z.object({ leaseEndDate: isoDate, effectiveDate: isoDate, details }).strict(),
  building_wide: z
    .object({
      propertyId: id,
      blockIds: z.array(id).max(100).optional(),
      title: text(160),
      particulars: text(4000),
      startDate: isoDate,
      endDate: isoDate.nullable().optional(),
      details,
    })
    .strict(),
  tenant_originated: z
    .object({
      receivedOn: isoDate,
      receivedVia: z.enum(RECEIVED_VIA),
      documentId: id,
      details,
    })
    .strict(),
} as const satisfies Record<NoticeType, z.ZodType>;

export type NoticeFieldsOf<T extends NoticeType> = z.infer<(typeof NOTICE_FIELD_SCHEMAS)[T]>;
export type NoticeFields = { [T in NoticeType]: NoticeFieldsOf<T> }[NoticeType];

/** The mandatory fields per type (plan 4.2), in the order the composer shows them. */
export const NOTICE_REQUIRED_FIELDS: Readonly<Record<NoticeType, readonly string[]>> = {
  rent_demand: ['arrearsMinor', 'arrearsAsOf', 'invoiceIds', 'payBy'],
  rent_review: ['currentRentMinor', 'newRentMinor', 'effectiveDate', 'reason'],
  notice_to_quit: ['particulars', 'effectiveDate'],
  entry: ['entryDate', 'windowFrom', 'windowTo'],
  breach: ['particulars', 'remedyBy'],
  non_renewal: ['leaseEndDate', 'effectiveDate'],
  building_wide: ['propertyId', 'title', 'particulars', 'startDate'],
  tenant_originated: ['receivedOn', 'receivedVia', 'documentId'],
};

export const NOTICE_FIELD_LABELS: Readonly<Record<string, string>> = {
  arrearsMinor: 'The arrears',
  arrearsAsOf: 'The date the arrears are counted to',
  invoiceIds: 'The invoices covered',
  payBy: 'The pay-by date',
  currentRentMinor: 'The current rent',
  newRentMinor: 'The new rent',
  effectiveDate: 'The effective date',
  reason: 'The reason',
  particulars: 'The particulars',
  entryDate: 'The date of entry',
  windowFrom: 'The start of the time window',
  windowTo: 'The end of the time window',
  remedyBy: 'The remedy-by date',
  leaseEndDate: 'The lease’s end date',
  propertyId: 'The property',
  blockIds: 'The blocks',
  title: 'The title',
  startDate: 'The start date',
  endDate: 'The end date',
  receivedOn: 'The date received',
  receivedVia: 'How it arrived',
  documentId: 'The document',
  details: 'The details',
};

/** A field-level refusal; `field` names the field for the composer. */
export class NoticeFieldError extends DomainError {
  constructor(
    code: string,
    readonly field: string,
    message: string,
  ) {
    super(code, message);
    this.name = 'NoticeFieldError';
  }
}

const labelOf = (field: string) => NOTICE_FIELD_LABELS[field] ?? field;
const isBlank = (value: unknown) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

/** Checks a subtype against its type: required where the type has subtypes, absent otherwise. */
export function checkNoticeSubtype(
  type: NoticeType,
  subtype: string | null | undefined,
): NoticeSubtype | null {
  const allowed: readonly string[] = NOTICE_SUBTYPES[type];
  if (allowed.length === 0) {
    if (subtype)
      throw new DomainError(
        'notice.subtype_invalid',
        `A ${NOTICE_TYPE_LABELS[type].toLowerCase()} has no subtype`,
      );
    return null;
  }
  const label = NOTICE_SUBTYPE_FIELD_LABELS[type] ?? 'Kind';
  if (!subtype)
    throw new DomainError('notice.subtype_required', `Choose the ${label.toLowerCase()}`);
  if (!allowed.includes(subtype))
    throw new DomainError('notice.subtype_invalid', `Not a ${label.toLowerCase()}: ${subtype}`);
  return subtype as NoticeSubtype;
}

/**
 * Checks a notice's fields for its type (LN-01): every mandatory field present, each in its
 * format, nothing unknown, and the dates in order. Returns the fields trimmed. Dates are checked
 * against the service date by checkEffectiveDate, not here.
 */
export function checkNoticeFields<T extends NoticeType>(
  type: T,
  fields: Record<string, unknown>,
): NoticeFieldsOf<T> {
  for (const field of NOTICE_REQUIRED_FIELDS[type]) {
    if (isBlank(fields[field]))
      throw new NoticeFieldError('notice.field_required', field, `${labelOf(field)} is required`);
  }
  const result = NOTICE_FIELD_SCHEMAS[type].safeParse(fields);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const field = String(issue.path[0] ?? '');
    if (issue.code === 'unrecognized_keys') {
      const unknown = (issue as { keys?: string[] }).keys?.join(', ') ?? '';
      throw new NoticeFieldError(
        'notice.field_unknown',
        unknown,
        `A ${NOTICE_TYPE_LABELS[type].toLowerCase()} has no field ${unknown}`,
      );
    }
    throw new NoticeFieldError(
      'notice.field_invalid',
      field,
      `${labelOf(field)} is not valid: ${issue.message}`,
    );
  }
  const data = result.data as Record<string, unknown>;
  const before = (a: string, b: string) =>
    compareDates(parseBusinessDate(a), parseBusinessDate(b)) < 0;
  if (type === 'rent_demand' && before(data.payBy as string, data.arrearsAsOf as string))
    throw new NoticeFieldError(
      'notice.field_invalid',
      'payBy',
      'The pay-by date cannot be before the date the arrears are counted to',
    );
  if (
    type === 'entry' &&
    parseTimeOfDay(data.windowTo as string) <= parseTimeOfDay(data.windowFrom as string)
  )
    throw new NoticeFieldError(
      'notice.field_invalid',
      'windowTo',
      'The time window must end after it starts',
    );
  if (
    type === 'building_wide' &&
    data.endDate &&
    before(data.endDate as string, data.startDate as string)
  )
    throw new NoticeFieldError(
      'notice.field_invalid',
      'endDate',
      'The end date cannot be before the start date',
    );
  return result.data as NoticeFieldsOf<T>;
}

/** The date a notice's earliest lawful date is checked against, or null for a type with none. */
export function noticeKeyDate(type: NoticeType, fields: Record<string, unknown>): string | null {
  const field = NOTICE_TYPE_RULES[type].keyDateField;
  if (!field) return null;
  const value = fields[field];
  return typeof value === 'string' ? value : null;
}
