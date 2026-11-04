import { DomainError } from '../errors';

/**
 * Notice numbers (M7 decision 15): gap-free per company, `N-000001`, taken from a counter in the
 * issuing transaction like receipt numbers. Six digits at least; the number grows past 999999.
 */
export function formatNoticeNumber(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1)
    throw new DomainError('notice.number_invalid', 'A notice number is a whole number from 1');
  return `N-${String(n).padStart(6, '0')}`;
}

/** The counter value of a formatted number, or null when the text is not one. */
export function parseNoticeNumber(text: string): number | null {
  const match = /^N-(\d{6,15})$/.exec(text.trim().toUpperCase());
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n) || n < 1 || formatNoticeNumber(n) !== `N-${match[1]}`) return null;
  return n;
}
