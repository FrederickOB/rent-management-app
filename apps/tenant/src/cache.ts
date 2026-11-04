import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The offline cache (M4b plan 4.10): the last figures the API sent this device, kept per person,
 * so the app can show them, with the time they were fetched, when it cannot reach the API. It is
 * a convenience, never the source of truth: everything here is replaced on the next answer.
 *
 * No link or token is ever stored (a pay link, a signing link or a download link lives only for
 * the tap that opened it); anything that holds a URL is refused. Signing out empties it.
 */
const PREFIX = 'rent.cache.v1';
const ME_KEY = `${PREFIX}:me`;

export interface Cached<T> {
  readonly data: T;
  /** When this device fetched it (ISO 8601, UTC). */
  readonly savedAt: string;
}

const keyFor = (personId: string, name: string) => `${PREFIX}:${personId}:${name}`;

/** Anything shaped like a link: a scheme, or a secure-link path. */
const LINK = /:\/\/|\/[lp]\/[A-Za-z0-9_-]{43}/;

/** Whether a value may be cached: never one that holds a link or a token. */
export function cacheable(json: string): boolean {
  return !LINK.test(json);
}

export async function readCache<T>(personId: string, name: string): Promise<Cached<T> | null> {
  try {
    const text = await AsyncStorage.getItem(keyFor(personId, name));
    if (!text) return null;
    const parsed = JSON.parse(text) as Partial<Cached<T>>;
    return parsed && typeof parsed.savedAt === 'string' && 'data' in parsed
      ? { data: parsed.data as T, savedAt: parsed.savedAt }
      : null;
  } catch {
    return null;
  }
}

export async function writeCache<T>(
  personId: string,
  name: string,
  data: T,
  savedAt: string = new Date().toISOString(),
): Promise<void> {
  try {
    const text = JSON.stringify({ data, savedAt } satisfies Cached<T>);
    if (!cacheable(text)) return;
    await AsyncStorage.setItem(keyFor(personId, name), text);
  } catch {
    // Best effort: a full or unavailable store only means no offline copy.
  }
}

/** The person last signed in on this device, so the app opens offline (src/session.tsx). */
export async function rememberPerson<T extends { readonly personId: string }>(
  me: T,
): Promise<void> {
  try {
    await AsyncStorage.setItem(ME_KEY, JSON.stringify(me));
  } catch {
    // As above.
  }
}

export async function recallPerson<T>(): Promise<T | null> {
  try {
    const text = await AsyncStorage.getItem(ME_KEY);
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

/** Empties everything this app cached, for everyone: on sign-out and when a session ends. */
export async function clearCache(): Promise<void> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(PREFIX));
    if (keys.length > 0) await AsyncStorage.multiRemove(keys);
  } catch {
    // As above.
  }
}
