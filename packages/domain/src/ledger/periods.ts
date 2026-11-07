import { addDays, addMonths, parseBusinessDate, toIsoDate } from '../dates';

/**
 * Period locks and the two dates (CLAUDE.md section 4; AC-04). A month locks when its owner
 * statement is issued (M9). Anything recorded later keeps its true value date but takes an
 * accounting date in the first open day, so a regenerated statement never changes.
 *
 * F1 (founder, 2026-11-06): issuing an owner statement for month M locks M and every month before
 * it in the owner's book. A book therefore has a lock date, the last day of the latest month an
 * issued statement locked, and any value date on or before it is reported on the day after it.
 * A month locked by hand (`manual`, M4a; no screen creates one) still locks that month alone.
 */

/** The month a business date falls in, as `YYYY-MM`. */
export const monthOf = (isoDate: string): string => isoDate.slice(0, 7);

/** The first day of the month after `isoDate`'s. */
export function firstDayOfNextMonth(isoDate: string): string {
  const first = parseBusinessDate(`${monthOf(isoDate)}-01`);
  return toIsoDate(addMonths(first, 1));
}

/** The last day of `isoDate`'s month (a month `YYYY-MM` is read as its first day). */
export function lastDayOfMonth(isoDate: string): string {
  const day = isoDate.length === 7 ? `${isoDate}-01` : isoDate;
  return toIsoDate(addDays(parseBusinessDate(firstDayOfNextMonth(day)), -1));
}

/**
 * F1: a book's lock date from the months its issued statements locked: the last day of the latest
 * of them, or null when none is locked. Months may be given as `YYYY-MM` or as any date in them.
 */
export function lockDateOf(statementMonths: Iterable<string>): string | null {
  let latest: string | null = null;
  for (const m of statementMonths) {
    const month = monthOf(m);
    parseBusinessDate(`${month}-01`);
    if (latest === null || month > latest) latest = month;
  }
  return latest === null ? null : lastDayOfMonth(latest);
}

/**
 * The accounting date for a value date. With a lock date (F1), a value date on or before it moves
 * to the day after it, the first open day. Then, while the month it falls in is locked by hand
 * (`lockedMonths`, each month on its own), it moves to the first day of the next month. `lockDate`
 * and `lockedMonths` cover every book the entry touches. Without a lock date, a locked month in
 * `lockedMonths` stands alone, as M4a built it.
 */
export function accountingDateFor(
  valueDate: string,
  lockedMonths: ReadonlySet<string>,
  lockDate: string | null = null,
): string {
  parseBusinessDate(valueDate);
  let date = valueDate;
  if (lockDate !== null) {
    parseBusinessDate(lockDate);
    if (date <= lockDate) date = toIsoDate(addDays(parseBusinessDate(lockDate), 1));
  }
  while (lockedMonths.has(monthOf(date))) date = firstDayOfNextMonth(date);
  return date;
}

/** Whether a date is reported in a locked period: on or before the lock date, or in a month locked by hand. */
export function isLockedDate(
  date: string,
  lockedMonths: ReadonlySet<string>,
  lockDate: string | null = null,
): boolean {
  parseBusinessDate(date);
  return (lockDate !== null && date <= lockDate) || lockedMonths.has(monthOf(date));
}
