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
