import { inboxTag } from '@rent/domain/settings';

// Settings → Messaging (CM-06; decisions 3, 9 and 10): the response target and the conversation
// tags. Both are product settings, not law. The API checks the same bounds.

export const FIRST_RESPONSE_MIN = 15;
export const FIRST_RESPONSE_MAX = 7 * 24 * 60;
export const TAGS_MAX = 30;

/** Hours and minutes as typed, as whole minutes; null when they are not whole numbers. */
export function minutesOf(hours: string, minutes: string): number | null {
  const h = hours.trim() === '' ? 0 : Number(hours);
  const m = minutes.trim() === '' ? 0 : Number(minutes);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

export function firstResponseProblem(total: number | null): string | null {
  if (total === null) return 'Use whole hours, and minutes from 0 to 59';
  if (total < FIRST_RESPONSE_MIN) return `Allow at least ${FIRST_RESPONSE_MIN} minutes`;
  if (total > FIRST_RESPONSE_MAX) return 'Allow at most 7 days';
  return null;
}

/** A tag as staff type it, made into the stored form: lower case, spaces as hyphens. */
export function normaliseTag(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '-');
}

export function tagProblem(tag: string, existing: readonly string[]): string | null {
  if (!tag) return 'Type a tag first';
  if (!inboxTag.safeParse(tag).success)
    return 'Use lower case letters, numbers, - or _ (up to 30), starting with a letter or number';
  if (existing.includes(tag)) return 'That tag is already in the list';
  if (existing.length >= TAGS_MAX) return `Keep at most ${TAGS_MAX} tags`;
  return null;
}
