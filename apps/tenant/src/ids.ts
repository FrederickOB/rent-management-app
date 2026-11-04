import { uuid } from 'expo';

/** Formats 16 random bytes as a version 4 UUID. */
export function uuidFromBytes(random: Uint8Array): string {
  const bytes = random.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type WebCrypto = { getRandomValues?: (bytes: Uint8Array) => Uint8Array };

/**
 * A random UUID (version 4) for a message the tenant writes: its `clientMessageId`. It is made
 * once, when the message is written, and sent again unchanged on every retry, so the API makes
 * one message however many times the send is tried (CM-05).
 *
 * The randomness is always the platform's secure source: Web Crypto's getRandomValues where it
 * exists (the web build, on any address; randomUUID works only on https and localhost), and
 * otherwise Expo's native UUID generator (iOS and Android, where Hermes has no Web Crypto).
 */
export function newClientMessageId(
  webCrypto: WebCrypto | undefined = (globalThis as { crypto?: WebCrypto }).crypto,
  native: () => string = uuid.v4,
): string {
  if (webCrypto?.getRandomValues)
    return uuidFromBytes(webCrypto.getRandomValues(new Uint8Array(16)));
  return native().toLowerCase();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value is a UUID, as the API's ids are. */
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
