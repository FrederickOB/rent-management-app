import { Temporal } from 'temporal-polyfill';
import { DomainError } from '../errors';

/**
 * Business dates (due dates, periods, effective dates) are calendar dates in the company's
 * time zone. Instants are UTC. All business date arithmetic goes through this module
 * (CLAUDE.md section 11).
 */
export type BusinessDate = Temporal.PlainDate;
export type Instant = Temporal.Instant;
export { Temporal };

export const DEFAULT_TIME_ZONE = 'Africa/Accra';

export function parseBusinessDate(iso: string): BusinessDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new DomainError('date.invalid', `Not a date: ${iso}`);
  try {
    return Temporal.PlainDate.from(iso, { overflow: 'reject' });
  } catch {
    throw new DomainError('date.invalid', `Not a date: ${iso}`);
  }
}

export const toIsoDate = (date: BusinessDate): string => date.toString();

export function instantFrom(value: Date | string | Instant): Instant {
  if (value instanceof Temporal.Instant) return value;
  if (value instanceof Date) return Temporal.Instant.fromEpochMilliseconds(value.getTime());
  return Temporal.Instant.from(value);
}

export const instantToDate = (instant: Instant): Date => new Date(instant.epochMilliseconds);

/** The business date on which `instant` falls in `timeZone`. */
export function businessDateOf(
  instant: Instant,
  timeZone: string = DEFAULT_TIME_ZONE,
): BusinessDate {
  return instant.toZonedDateTimeISO(timeZone).toPlainDate();
}

/** The first instant of `date` in `timeZone`. */
export function startOfDay(date: BusinessDate, timeZone: string = DEFAULT_TIME_ZONE): Instant {
  return date.toZonedDateTime({ timeZone }).toInstant();
}

export const addDays = (date: BusinessDate, days: number): BusinessDate => date.add({ days });

/** Adds calendar months, clamping to the last day of a shorter month (31 Jan + 1 = 28 or 29 Feb). */
export const addMonths = (date: BusinessDate, months: number): BusinessDate =>
  date.add({ months }, { overflow: 'constrain' });

export const daysBetween = (from: BusinessDate, to: BusinessDate): number =>
  from.until(to, { largestUnit: 'days' }).days;

export const compareDates = (a: BusinessDate, b: BusinessDate): -1 | 0 | 1 =>
  Temporal.PlainDate.compare(a, b) as -1 | 0 | 1;

export const addHours = (instant: Instant, hours: number): Instant => instant.add({ hours });

/** Clock minutes after an instant (M6: the inbox's response target, bot timeouts). */
export const addMinutes = (instant: Instant, minutes: number): Instant => instant.add({ minutes });

/** Whole minutes from one instant to another, rounded towards zero; negative when `to` is earlier. */
export const minutesBetween = (from: Instant, to: Instant): number =>
  Math.trunc((to.epochMilliseconds - from.epochMilliseconds) / 60_000);

/**
 * Formats an instant for people, always naming the time zone (DO-04), for example
 * `28 Oct 2026, 14:05 GMT (Africa/Accra)`.
 */
export function formatInstant(
  instant: Instant,
  timeZone: string = DEFAULT_TIME_ZONE,
  locale = 'en-GB',
): string {
  const text = new Intl.DateTimeFormat(locale, {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(instant.epochMilliseconds);
  return `${text} (${timeZone})`;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** A business date for documents and messages, for example `1 November 2026`. */
export function formatBusinessDate(iso: string): string {
  const date = parseBusinessDate(iso);
  return `${date.day} ${MONTH_NAMES[date.month - 1]} ${date.year}`;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    Temporal.Now.instant().toZonedDateTimeISO(timeZone);
    return true;
  } catch {
    return false;
  }
}
