import { readCache, writeCache } from './cache';

/**
 * Whether the tenant has answered the question about notifications on this phone: on Home (Turn
 * on, Not now) or with a toggle in Profile. Kept per person in the offline cache, so signing out
 * forgets it. Home asks only while it has not been answered.
 */
const KEY = 'push-prompt';

export async function promptAnswered(personId: string): Promise<boolean> {
  return (await readCache<unknown>(personId, KEY)) !== null;
}

export async function markPromptAnswered(personId: string): Promise<void> {
  await writeCache(personId, KEY, { dismissed: true });
}

/** "A", "A and B", "A, B and C": the landlords a notification may come from. */
export function landlordList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
