import {
  addDays,
  businessDateOf,
  compareDates,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';

// Business dates on the register screens. Date arithmetic goes through packages/domain/dates
// only (CLAUDE.md section 11); these helpers wrap it for the forms.

/** Today's business date in the company's time zone (CLAUDE.md section 11). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return toIsoDate(businessDateOf(instantFrom(now), timeZone));
}

/**
 * The first date a new owner can take over a property (AD-02): today, or the day after the
 * latest change if that is later, because ownership dates only move forward.
 */
export function earliestOwnerChange(effectiveDates: readonly string[], today: string): string {
  let earliest = parseBusinessDate(today);
  for (const date of effectiveDates) {
    const next = addDays(parseBusinessDate(date), 1);
    if (compareDates(next, earliest) > 0) earliest = next;
  }
  return toIsoDate(earliest);
}

/** True when `iso` is a valid date on or after `earliest`. */
export function notBefore(iso: string, earliest: string): boolean {
  try {
    return compareDates(parseBusinessDate(iso), parseBusinessDate(earliest)) >= 0;
  } catch {
    return false;
  }
}

/** A business date for people, such as `29 Oct 2026`. */
export function formatBusinessDate(iso: string): string {
  try {
    return parseBusinessDate(iso).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}
