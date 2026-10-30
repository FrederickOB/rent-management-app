import { addMonths, parseBusinessDate, toIsoDate } from '../dates';

/**
 * Period locks and the two dates (CLAUDE.md section 4; AC-04). A month locks when its owner
 * statement is issued (M9). Anything recorded later keeps its true value date but takes an
 * accounting date in the first open day, so a regenerated statement never changes.
 */

/** The month a business date falls in, as `YYYY-MM`. */
export const monthOf = (isoDate: string): string => isoDate.slice(0, 7);

/** The first day of the month after `isoDate`'s. */
export function firstDayOfNextMonth(isoDate: string): string {
  const first = parseBusinessDate(`${monthOf(isoDate)}-01`);
  return toIsoDate(addMonths(first, 1));
}

/**
 * The accounting date for a value date: the value date itself when its month is open, otherwise
 * the first day of the first open month after it. `lockedMonths` holds the locked months of every
 * book the entry touches.
 */
export function accountingDateFor(valueDate: string, lockedMonths: ReadonlySet<string>): string {
  parseBusinessDate(valueDate);
  let date = valueDate;
  while (lockedMonths.has(monthOf(date))) date = firstDayOfNextMonth(date);
  return date;
}
