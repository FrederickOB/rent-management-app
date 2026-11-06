import { compareDates, parseBusinessDate } from '@rent/domain/dates';
import { formatBusinessDate } from './business-dates';

// Rent Officer assessments (decision 3; Act 220 s.23). The bar's length is a rule (24 months,
// unverified), read by the API; the screen says what it answered and warns while unverified.

export function assessmentBarText(bar: {
  readonly barredUntil: string;
  readonly months: number;
  readonly ruleStatus: 'verified' | 'from_prd' | 'unverified';
}): { readonly text: string; readonly warn: boolean } {
  const verified = bar.ruleStatus === 'verified';
  return {
    warn: !verified,
    text: `No notice to quit may be issued for this unit until after ${formatBusinessDate(bar.barredUntil)}: ${bar.months} months from the latest assessment (rule notice_to_quit.assessment_bar_months${verified ? '' : ', not yet verified by counsel'}).`,
  };
}

/** The form's problems: a real date not after today, and a reference. */
export function assessmentProblems(
  input: { readonly assessedOn: string; readonly reference: string },
  today: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  try {
    if (compareDates(parseBusinessDate(input.assessedOn), parseBusinessDate(today)) > 0)
      errors.assessedOn = 'An assessment cannot be in the future';
  } catch {
    errors.assessedOn = 'Give the date of the assessment';
  }
  const reference = input.reference.trim();
  if (reference.length < 1) errors.reference = 'Give the Rent Officer’s reference';
  else if (reference.length > 120) errors.reference = 'Use at most 120 characters';
  return errors;
}

export interface BarState {
  readonly tone: 'warning' | 'info' | 'error';
  readonly title: string;
  readonly text: string;
}

/**
 * The unit's s.23 bar as the API answers it (C4): barred until a date while `active`, ended
 * otherwise, and a warning when an assessment is on record but no bar rule is in force (a notice
 * to quit is then refused). Null when no active assessment is on record.
 */
export function assessmentBarState(
  bar: {
    readonly barredUntil: string;
    readonly months: number;
    readonly ruleStatus: 'verified' | 'from_prd' | 'unverified';
    readonly active: boolean;
  } | null,
  ruleMissing: boolean,
): BarState | null {
  if (ruleMissing)
    return {
      tone: 'error',
      title: 'No rule for the assessment bar is in force',
      text: 'An assessment is on record, but no rule for the s.23 bar (notice_to_quit.assessment_bar_months) is in force, so a notice to quit for this unit is refused until one is.',
    };
  if (!bar) return null;
  if (bar.active) {
    const { text, warn } = assessmentBarText(bar);
    return { tone: warn ? 'warning' : 'info', title: 'Notices to quit are barred', text };
  }
  return {
    tone: 'info',
    title: 'The bar has ended',
    text: `The s.23 bar from the latest assessment ended on ${formatBusinessDate(bar.barredUntil)}.`,
  };
}

export const ASSESSMENT_STATUS_LABELS: Record<'active' | 'corrected' | 'voided', string> = {
  active: 'In force',
  corrected: 'Corrected',
  voided: 'Voided',
};

/** A correction or a void needs a reason of 3 to 500 characters (C4). */
export function assessmentReasonProblem(reason: string): string | null {
  const length = reason.trim().length;
  if (length < 3) return 'Give a reason of at least 3 characters';
  if (length > 500) return 'Use at most 500 characters';
  return null;
}
