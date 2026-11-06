import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  formatBusinessDate,
  parseBusinessDate,
  toIsoDate,
  type BusinessDate,
} from '../dates';
import { DomainError } from '../errors';
import { needsWarning, parseRuleValue, verificationWarning, type RuleRow } from '../rules';
import { MAX_NOTICE_DAYS, type LeaseUse } from '../tenancy/lease-terms';
import {
  NOTICE_FIELD_LABELS,
  NOTICE_TYPE_LABELS,
  NOTICE_TYPE_RULES,
  type NoticeType,
} from './types';

/**
 * The earliest lawful effective date (LN-01; M7 plan 4.3, decision 2) and the s.23 bar
 * (decision 3). Pure: the caller resolves the rule rows in force on the issue date and records
 * the versions this returns with the notice (CLAUDE.md section 7). No legal value lives here.
 */

/** A rule row as a calculation reads it; its id is the version recorded with the notice. */
export type NoticeRuleInput = Pick<RuleRow, 'id' | 'key' | 'value' | 'verificationStatus'>;

export interface NoticeRuleUsed {
  readonly key: string;
  readonly ruleId: string;
  readonly value: unknown;
  readonly verificationStatus: RuleRow['verificationStatus'];
}

/** `notice_to_quit.statutory_min_days.residential` or `.commercial` (D7, OQ-09). */
export const statutoryMinimumKey = (use: LeaseUse): string =>
  `notice_to_quit.statutory_min_days.${use}`;

/** Act 220 s.23 (decision 3): months after a Rent Officer assessment. */
export const ASSESSMENT_BAR_KEY = 'notice_to_quit.assessment_bar_months';

export type NoticeWarningCode =
  /** The statutory minimum's rule row is not verified (from_prd or unverified). */
  | 'statutory_minimum_unverified'
  /** The statutory minimum is null: only the lease's own period is enforced. */
  | 'statutory_minimum_not_set'
  /** No statutory-minimum row is in force on the date: treated as not set. */
  | 'statutory_rule_missing'
  /** The s.23 bar's rule row is not verified. */
  | 'assessment_bar_unverified'
  /** Decision 4: no electronic-service clause, so service is physical. */
  | 'no_electronic_service_clause'
  /** Decision 5: every channel the clause names is withheld after an opt-out. */
  | 'electronic_service_withheld'
  /** Decision 1: counsel has not reviewed the template version's wording. */
  | 'counsel_wording_outstanding'
  /** Plan 4.2: no notice period is recorded for this type. */
  | 'no_period_enforced'
  /** Review note: a notice to quit on a lease whose own notice period is 0 days. */
  | 'lease_notice_days_zero'
  /** Review note (s.23): a notice to quit with no Rent Officer assessment on record. */
  | 'no_assessment_on_record';

export interface NoticeWarning {
  readonly code: NoticeWarningCode;
  readonly message: string;
  /** The rule the warning names, where it is about one. */
  readonly ruleKey: string | null;
}

/** The lease facts the calculation reads. */
export interface NoticeLeaseFacts {
  readonly use: LeaseUse;
  /** The lease's contractual notice days. */
  readonly noticeDays: number;
  /** The lease's end date (non-renewal). */
  readonly endDate: string;
  /** The lease has the electronic-service clause (prd-issues 25; CLAUDE.md section 8). */
  readonly electronicServiceClause: boolean;
}

export interface EarliestDateInput {
  readonly type: NoticeType;
  /** Null only for a type addressed to a property (building-wide), where no date depends on service. */
  readonly lease: NoticeLeaseFacts | null;
  /** Decision 5: every channel the clause names is withheld because of an opt-out. */
  readonly electronicChannelsWithheld?: boolean;
  /** The issue date in the company's time zone: planned in the composer, actual at issue. */
  readonly issueDate: string;
  /** The date physical service was recorded, once it has been. */
  readonly physicalServiceDate?: string | null;
  /**
   * The statutory-minimum row in force on the issue date for `statutoryMinimumKey(lease.use)`,
   * or null when no row is in force. Read only by types that use it.
   */
  readonly statutoryRule?: NoticeRuleInput | null;
  /** Decision 1: counsel has reviewed the template version's wording. */
  readonly wordingReviewed: boolean;
}

/**
 * Where the service date came from: the issue date with electronic service, the recorded
 * physical service, the planned issue date while physical service is still to come, or the issue
 * date for a notice with no lease (nothing depends on it).
 */
export type ServiceDateBasis = 'electronic_issue' | 'physical_service' | 'planned_issue' | 'issue';

export interface EarliestLawfulDate {
  readonly earliestDate: string;
  readonly serviceDate: string;
  readonly serviceDateBasis: ServiceDateBasis;
  readonly periodDays: number;
  /** Which period set the date; `contractual` wins a tie. */
  readonly periodSource: 'none' | 'contractual' | 'statutory';
  readonly contractualDays: number | null;
  readonly statutoryDays: number | null;
  /** Non-renewal: the lease's end date is later than service plus the period. */
  readonly leaseEndApplied: boolean;
  readonly rulesUsed: readonly NoticeRuleUsed[];
  readonly warnings: readonly NoticeWarning[];
}

const later = (a: BusinessDate, b: BusinessDate) => (compareDates(a, b) >= 0 ? a : b);
const fmt = (iso: string) => formatBusinessDate(iso);

function servesElectronically(input: EarliestDateInput): boolean {
  return !!input.lease?.electronicServiceClause && !input.electronicChannelsWithheld;
}

function serviceOf(input: EarliestDateInput): { date: BusinessDate; basis: ServiceDateBasis } {
  const issue = parseBusinessDate(input.issueDate);
  if (!input.lease) return { date: issue, basis: 'issue' };
  if (servesElectronically(input)) return { date: issue, basis: 'electronic_issue' };
  if (input.physicalServiceDate) {
    const served = parseBusinessDate(input.physicalServiceDate);
    if (compareDates(served, issue) < 0)
      throw new DomainError(
        'notice.service_before_issue',
        'A notice cannot be served before the day it is issued',
      );
    return { date: served, basis: 'physical_service' };
  }
  return { date: issue, basis: 'planned_issue' };
}

function serviceWarnings(input: EarliestDateInput, basis: ServiceDateBasis): NoticeWarning[] {
  if (!input.lease || basis === 'electronic_issue') return [];
  const counted =
    basis === 'physical_service'
      ? `The period is counted from physical service on ${fmt(input.physicalServiceDate!)}.`
      : 'The date is counted from the planned issue date, but the period runs from the day it is served; the tracker checks again when service is recorded.';
  if (!input.lease.electronicServiceClause)
    return [
      {
        code: 'no_electronic_service_clause',
        message: `The lease has no electronic-service clause, so this notice must be served physically. ${counted}`,
        ruleKey: null,
      },
    ];
  return [
    {
      code: 'electronic_service_withheld',
      message: `Every channel the lease names for service is withheld because the tenant opted out, so this notice must be served physically. ${counted}`,
      ruleKey: null,
    },
  ];
}

/**
 * The earliest lawful effective date (plan 4.3):
 * - service date: the issue date with the electronic-service clause and a channel to use;
 *   otherwise the recorded physical service, or the planned issue date until there is one;
 * - period: the larger of the lease's notice days (types that use them) and the statutory
 *   minimum (types that use it, when its value is not null);
 * - earliest: service date plus the period; a non-renewal never before the lease ends.
 * Returns the rule versions it read and every warning the composer must show.
 */
export function earliestLawfulDate(input: EarliestDateInput): EarliestLawfulDate {
  const typeRules = NOTICE_TYPE_RULES[input.type];
  if (typeRules.needsLease && !input.lease)
    throw new DomainError(
      'notice.lease_required',
      `A ${NOTICE_TYPE_LABELS[input.type].toLowerCase()} is served under a lease`,
    );
  const lease = input.lease;
  if (
    lease &&
    (!Number.isInteger(lease.noticeDays) ||
      lease.noticeDays < 0 ||
      lease.noticeDays > MAX_NOTICE_DAYS)
  )
    throw new DomainError(
      'notice.lease_notice_days_invalid',
      `The lease's notice period must be 0 to ${MAX_NOTICE_DAYS} days`,
    );

  const service = serviceOf(input);
  const warnings: NoticeWarning[] = [];
  const rulesUsed: NoticeRuleUsed[] = [];

  const contractualDays = typeRules.usesContractualPeriod && lease ? lease.noticeDays : null;

  let statutoryDays: number | null = null;
  if (typeRules.usesStatutoryMinimum && lease) {
    const key = statutoryMinimumKey(lease.use);
    const rule = input.statutoryRule ?? null;
    if (!rule) {
      warnings.push({
        code: 'statutory_rule_missing',
        message: `No statutory minimum notice period is in force for this lease (${key}), so only the lease's own period is enforced. Counsel to confirm.`,
        ruleKey: key,
      });
    } else {
      if (rule.key !== key)
        throw new DomainError(
          'notice.rule_mismatch',
          `The calculation needs rule ${key}, not ${rule.key}`,
        );
      const value = parseRuleValue(key, rule.value) as { days: number } | null;
      statutoryDays = value?.days ?? null;
      rulesUsed.push({
        key,
        ruleId: rule.id,
        value: rule.value,
        verificationStatus: rule.verificationStatus,
      });
      const status = verificationWarning(rule.verificationStatus);
      if (needsWarning(rule) && status)
        warnings.push({
          code: 'statutory_minimum_unverified',
          message: `The statutory minimum notice period (${key}) is ${status}.`,
          ruleKey: key,
        });
      if (statutoryDays === null)
        warnings.push({
          code: 'statutory_minimum_not_set',
          message: `No statutory minimum notice period has been entered (${key}), so only the lease's ${lease.noticeDays}-day period is enforced.`,
          ruleKey: key,
        });
    }
  }

  const periodDays = Math.max(contractualDays ?? 0, statutoryDays ?? 0);
  const periodSource =
    statutoryDays !== null && statutoryDays > (contractualDays ?? 0)
      ? 'statutory'
      : contractualDays !== null
        ? 'contractual'
        : 'none';

  let earliest = addDays(service.date, periodDays);
  let leaseEndApplied = false;
  if (input.type === 'non_renewal' && lease) {
    const end = parseBusinessDate(lease.endDate);
    leaseEndApplied = compareDates(end, earliest) > 0;
    earliest = later(earliest, end);
  }

  warnings.push(...serviceWarnings(input, service.basis));
  if (typeRules.warnsNoPeriod)
    warnings.push({
      code: 'no_period_enforced',
      message:
        'No notice period is recorded for this type of notice, so none is enforced. Check the lease and counsel’s advice before relying on the date.',
      ruleKey: null,
    });
  if (!input.wordingReviewed)
    warnings.push({
      code: 'counsel_wording_outstanding',
      message:
        'Counsel has not reviewed this template’s wording yet. Do not send it to real tenants until they have.',
      ruleKey: null,
    });

  return {
    earliestDate: toIsoDate(earliest),
    serviceDate: toIsoDate(service.date),
    serviceDateBasis: service.basis,
    periodDays,
    periodSource,
    contractualDays,
    statutoryDays,
    leaseEndApplied,
    rulesUsed,
    warnings,
  };
}

export interface EffectiveDateCheck {
  /** The date holds; always true for a type with no date to check. */
  readonly ok: boolean;
  readonly effectiveDate: string | null;
  readonly earliest: EarliestLawfulDate;
  /** Days the date falls short of the earliest date, or 0. */
  readonly shortByDays: number;
  /** Why it does not hold, for the composer or the draft it returns to (plan 4.3). */
  readonly reason: string | null;
}

function explain(e: EarliestLawfulDate): string {
  if (e.leaseEndApplied) return `the lease ends on ${fmt(e.earliestDate)}`;
  const from =
    e.serviceDateBasis === 'physical_service'
      ? `from physical service on ${fmt(e.serviceDate)}`
      : `from ${fmt(e.serviceDate)}, the day it is served`;
  if (e.periodSource === 'statutory')
    return `the statutory minimum of ${e.periodDays} days, counted ${from}`;
  return `the lease's ${e.periodDays}-day notice period, counted ${from}`;
}

/**
 * Checks a notice's date against the earliest lawful date (plan 4.3). The composer calls it as
 * the date is chosen; NoticesService.issue calls it again with the actual issue date and the
 * rules in force that day, because approval may take days. Never throws for a date that does not
 * hold: `ok` is false and `reason` says why. `effectiveDate` is the type's key date (noticeKeyDate).
 */
export function checkEffectiveDate(
  input: EarliestDateInput & { readonly effectiveDate: string | null },
): EffectiveDateCheck {
  const earliest = earliestLawfulDate(input);
  const field = NOTICE_TYPE_RULES[input.type].keyDateField;
  if (!field) return { ok: true, effectiveDate: null, earliest, shortByDays: 0, reason: null };
  if (!input.effectiveDate)
    throw new DomainError(
      'notice.effective_date_required',
      `${NOTICE_FIELD_LABELS[field] ?? 'The date'} is required`,
    );
  const date = parseBusinessDate(input.effectiveDate);
  const min = parseBusinessDate(earliest.earliestDate);
  if (compareDates(date, min) >= 0)
    return { ok: true, effectiveDate: input.effectiveDate, earliest, shortByDays: 0, reason: null };
  const reason = NOTICE_TYPE_RULES[input.type].hasPeriod
    ? `The effective date must be on or after ${fmt(earliest.earliestDate)}: ${explain(earliest)}.`
    : `${NOTICE_FIELD_LABELS[field] ?? 'The date'} cannot be before ${fmt(earliest.earliestDate)}, the day the notice is served.`;
  return {
    ok: false,
    effectiveDate: input.effectiveDate,
    earliest,
    shortByDays: daysBetween(date, min),
    reason,
  };
}

/** checkEffectiveDate, refusing a date that does not hold (`notice.effective_date_too_early`). */
export function assertEffectiveDate(
  input: EarliestDateInput & { readonly effectiveDate: string | null },
): EffectiveDateCheck {
  const check = checkEffectiveDate(input);
  if (!check.ok) throw new DomainError('notice.effective_date_too_early', check.reason!);
  return check;
}

export interface LateServiceCheck {
  /** Plan 4.3: the period from the service date ends after the stated date. */
  readonly tooLate: boolean;
  readonly earliestFromService: string;
  readonly shortByDays: number;
  readonly reason: string | null;
}

/**
 * Late physical service (plan 4.3): once service is recorded, the period runs from that day. If
 * it then ends after the stated date, the notice is flagged "served too late for its date" and
 * the tracker offers a correction (4.8). A notice served electronically counts from its issue
 * date, so recording physical service as well never makes it late.
 */
export function servedTooLate(
  input: EarliestDateInput & {
    readonly effectiveDate: string | null;
    readonly physicalServiceDate: string;
  },
): LateServiceCheck {
  const check = checkEffectiveDate(input);
  return {
    tooLate: !check.ok,
    earliestFromService: check.earliest.earliestDate,
    shortByDays: check.shortByDays,
    reason: check.ok ? null : `Served too late for its date. ${check.reason}`,
  };
}

/** A Rent Officer assessment on the unit (decision 3). */
export interface RentAssessmentFact {
  readonly date: string;
}

function latestOf(assessments: readonly RentAssessmentFact[]): string {
  return toIsoDate(
    assessments
      .map((a) => parseBusinessDate(a.date))
      .reduce((a, b) => (compareDates(a, b) >= 0 ? a : b)),
  );
}

/**
 * The last day of the s.23 bar: the latest assessment plus `barMonths` (a month-end clamps). A
 * notice to quit issued on or before this day is barred: the anniversary itself counts as inside
 * the bar, the cautious reading until counsel confirms. Null with no assessment on record.
 */
export function quitBarredUntil(
  assessments: readonly RentAssessmentFact[],
  barMonths: number,
): string | null {
  if (!Number.isInteger(barMonths) || barMonths < 0)
    throw new DomainError('notice.quit_bar_invalid', 'The bar must be a whole number of months');
  if (assessments.length === 0) return null;
  return toIsoDate(addMonths(parseBusinessDate(latestOf(assessments)), barMonths));
}

export interface QuitBarCheck {
  readonly barred: boolean;
  readonly barredUntil: string | null;
  readonly latestAssessment: string | null;
  /** The bar's rule version, when an assessment made the calculation read it. */
  readonly ruleUsed: NoticeRuleUsed | null;
  readonly warnings: readonly NoticeWarning[];
  readonly reason: string | null;
}

/**
 * The s.23 bar (decision 3; Act 220 s.23, unverified): a notice to quit is refused when its issue
 * date is inside the bar after the latest Rent Officer assessment on the unit. Other types are
 * never barred. With an assessment on record and no bar rule in force, it refuses to guess.
 */
export function checkQuitBar(input: {
  readonly type: NoticeType;
  readonly issueDate: string;
  readonly assessments: readonly RentAssessmentFact[];
  /** The `notice_to_quit.assessment_bar_months` row in force on the issue date. */
  readonly rule: NoticeRuleInput | null;
}): QuitBarCheck {
  const none: QuitBarCheck = {
    barred: false,
    barredUntil: null,
    latestAssessment: null,
    ruleUsed: null,
    warnings: [],
    reason: null,
  };
  if (!NOTICE_TYPE_RULES[input.type].checksAssessmentBar || input.assessments.length === 0)
    return none;
  const rule = input.rule;
  if (!rule)
    throw new DomainError(
      'notice.quit_bar_rule_missing',
      `No rule ${ASSESSMENT_BAR_KEY} is in force, so the Rent Officer assessment bar cannot be checked`,
    );
  if (rule.key !== ASSESSMENT_BAR_KEY)
    throw new DomainError(
      'notice.rule_mismatch',
      `The calculation needs rule ${ASSESSMENT_BAR_KEY}, not ${rule.key}`,
    );
  const { months } = parseRuleValue(ASSESSMENT_BAR_KEY, rule.value) as { months: number };
  const barredUntil = quitBarredUntil(input.assessments, months)!;
  const latestAssessment = latestOf(input.assessments);
  const barred =
    compareDates(parseBusinessDate(input.issueDate), parseBusinessDate(barredUntil)) <= 0;
  const status = verificationWarning(rule.verificationStatus);
  const warnings: NoticeWarning[] =
    needsWarning(rule) && status
      ? [
          {
            code: 'assessment_bar_unverified',
            message: `The bar on notices to quit after a Rent Officer assessment (${ASSESSMENT_BAR_KEY}) is ${status}.`,
            ruleKey: ASSESSMENT_BAR_KEY,
          },
        ]
      : [];
  return {
    barred,
    barredUntil,
    latestAssessment,
    ruleUsed: {
      key: ASSESSMENT_BAR_KEY,
      ruleId: rule.id,
      value: rule.value,
      verificationStatus: rule.verificationStatus,
    },
    warnings,
    reason: barred
      ? `A notice to quit cannot be issued until after ${fmt(barredUntil)}: a Rent Officer assessed the unit on ${fmt(latestAssessment)} (Act 220 s.23, ${months} months).`
      : null,
  };
}

/** checkQuitBar, refusing a barred notice (`notice.quit_barred`). */
export function assertNotQuitBarred(input: Parameters<typeof checkQuitBar>[0]): QuitBarCheck {
  const check = checkQuitBar(input);
  if (check.barred) throw new DomainError('notice.quit_barred', check.reason!);
  return check;
}
