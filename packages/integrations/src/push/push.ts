import { z } from 'zod';
import { requestJson } from '../http';
import { unexpectedResponse } from '../validation';

/**
 * Push notifications to the tenant app (CLAUDE.md section 8). Shapes loosely follow Expo's push
 * API; the Expo adapter arrives in M6.
 */
export interface PushMessage {
  /** Expo push tokens, `ExponentPushToken[...]`. */
  readonly tokens: readonly string[];
  readonly title: string;
  readonly body: string;
  /** Delivered to the app with the notification, for example a deep link. */
  readonly data?: Readonly<Record<string, string>>;
}

export type PushErrorCode =
  | 'DeviceNotRegistered'
  | 'MessageTooBig'
  | 'MessageRateExceeded'
  | 'MismatchSenderId'
  | 'InvalidCredentials'
  | 'Unknown';

/** Either the provider accepted the notification for a token, or it refused that token. */
export type PushTicket =
  | { readonly token: string; readonly ticketId: string }
  | { readonly token: string; readonly error: PushErrorCode };

/**
 * `ok`: handed to Apple or Google. `pending`: no receipt yet; Expo publishes receipts within
 * minutes and keeps them for 24 hours, so an id it does not know also reads as pending.
 */
export type PushReceipt =
  | { readonly ticketId: string; readonly status: 'ok' }
  | { readonly ticketId: string; readonly status: 'error'; readonly error: PushErrorCode }
  | { readonly ticketId: string; readonly status: 'pending' };

export interface PushPort {
  readonly provider: string;
  /** One ticket per token, in the order given. One token's error does not fail the others. */
  send(message: PushMessage): Promise<PushTicket[]>;
  /** One receipt per ticket id, in the order given. */
  getReceipts(ticketIds: readonly string[]): Promise<PushReceipt[]>;
}

const EXPO_TOKEN = /^Expo(?:nent)?PushToken\[[^\]\s]+\]$/;
export const isExpoPushToken = (token: string): boolean => EXPO_TOKEN.test(token);

/** Expo refuses a notification whose payload exceeds 4096 bytes. */
export const PUSH_PAYLOAD_LIMIT_BYTES = 4096;
export const pushPayloadBytes = (message: Pick<PushMessage, 'title' | 'body' | 'data'>): number =>
  Buffer.byteLength(
    JSON.stringify({ title: message.title, body: message.body, data: message.data ?? {} }),
  );

const ERROR_CODES: readonly string[] = [
  'DeviceNotRegistered',
  'MessageTooBig',
  'MessageRateExceeded',
  'MismatchSenderId',
  'InvalidCredentials',
];
const toErrorCode = (value: string | undefined): PushErrorCode =>
  value !== undefined && ERROR_CODES.includes(value) ? (value as PushErrorCode) : 'Unknown';

/**
 * Records notifications in memory. Like the HTTP fake, a malformed token is refused with
 * DeviceNotRegistered, and a token containing "unregistered" is accepted but its receipt reports
 * DeviceNotRegistered, as Expo does for an uninstalled app.
 */
export class InMemoryPush implements PushPort {
  readonly provider = 'memory';
  readonly sent: {
    token: string;
    title: string;
    body: string;
    data?: Record<string, string>;
    ticketId: string;
  }[] = [];
  private readonly receipts = new Map<string, PushReceipt>();
  private counter = 0;

  async send(message: PushMessage): Promise<PushTicket[]> {
    const tooBig = pushPayloadBytes(message) > PUSH_PAYLOAD_LIMIT_BYTES;
    return message.tokens.map((token): PushTicket => {
      if (!isExpoPushToken(token)) return { token, error: 'DeviceNotRegistered' };
      if (tooBig) return { token, error: 'MessageTooBig' };
      const ticketId = `mem-push-${++this.counter}`;
      this.sent.push({
        token,
        title: message.title,
        body: message.body,
        ...(message.data === undefined ? {} : { data: { ...message.data } }),
        ticketId,
      });
      this.receipts.set(
        ticketId,
        token.toLowerCase().includes('unregistered')
          ? { ticketId, status: 'error', error: 'DeviceNotRegistered' }
          : { ticketId, status: 'ok' },
      );
      return { token, ticketId };
    });
  }

  async getReceipts(ticketIds: readonly string[]): Promise<PushReceipt[]> {
    return ticketIds.map(
      (ticketId) => this.receipts.get(ticketId) ?? { ticketId, status: 'pending' },
    );
  }
}

// Expo's limits per request.
const SEND_BATCH = 100;
const RECEIPT_BATCH = 1000;

const errorDetails = z.object({ error: z.string().optional() }).optional();
const sendResponse = z.object({
  data: z.array(
    z.union([
      z.object({ status: z.literal('ok'), id: z.string().min(1) }),
      z.object({ status: z.literal('error'), details: errorDetails }),
    ]),
  ),
});
const receiptsResponse = z.object({
  data: z.record(
    z.string(),
    z.union([
      z.object({ status: z.literal('ok') }),
      z.object({ status: z.literal('error'), details: errorDetails }),
    ]),
  ),
});

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

/** Talks to `apps/fake-providers` over HTTP, with the request shapes of Expo's push API. */
export class FakeProvidersPush implements PushPort {
  readonly provider = 'fake-providers';
  constructor(private readonly baseUrl: string) {}

  async send(message: PushMessage): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (const batch of chunks(message.tokens, SEND_BATCH)) {
      const body = batch.map((to) => ({
        to,
        title: message.title,
        body: message.body,
        ...(message.data === undefined ? {} : { data: message.data }),
      }));
      const parsed = sendResponse.safeParse(
        await requestJson<unknown>(this.provider, `${this.baseUrl}/push/send`, { body }),
      );
      if (!parsed.success || parsed.data.data.length !== batch.length) {
        throw unexpectedResponse(this.provider);
      }
      const results = parsed.data.data;
      batch.forEach((token, i) => {
        const result = results[i];
        tickets.push(
          result?.status === 'ok'
            ? { token, ticketId: result.id }
            : { token, error: toErrorCode(result?.details?.error) },
        );
      });
    }
    return tickets;
  }

  async getReceipts(ticketIds: readonly string[]): Promise<PushReceipt[]> {
    const receipts: PushReceipt[] = [];
    for (const ids of chunks(ticketIds, RECEIPT_BATCH)) {
      const parsed = receiptsResponse.safeParse(
        await requestJson<unknown>(this.provider, `${this.baseUrl}/push/getReceipts`, {
          body: { ids },
        }),
      );
      if (!parsed.success) throw unexpectedResponse(this.provider);
      for (const ticketId of ids) {
        const receipt = parsed.data.data[ticketId];
        if (!receipt) receipts.push({ ticketId, status: 'pending' });
        else if (receipt.status === 'ok') receipts.push({ ticketId, status: 'ok' });
        else
          receipts.push({ ticketId, status: 'error', error: toErrorCode(receipt.details?.error) });
      }
    }
    return receipts;
  }
}
