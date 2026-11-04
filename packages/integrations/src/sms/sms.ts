import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ProviderError, requestJson } from '../http';
import { invalidRequest, isE164, unexpectedResponse } from '../validation';

/**
 * SMS gateway (CLAUDE.md section 8). Hubtel in M6 (decision 1): send from a sender ID, delivery
 * reports to a callback, and inbound replies from a two-way short code once there is one.
 */
export interface SmsMessage {
  /** E.164 number. */
  readonly to: string;
  readonly body: string;
  /** Sender ID registered with the gateway (M6); the gateway default when absent. */
  readonly senderId?: string;
  /** Our idempotency reference, echoed in delivery reports. */
  readonly reference?: string;
}

export interface SmsSendResult {
  readonly provider: string;
  readonly providerMessageId: string;
  /**
   * What the gateway charged, exactly as it says it (CM-12 groundwork; decision 13), for example
   * `0.0246` GHS. Rounding to pesewas happens in the domain's money code, nowhere here.
   */
  readonly cost?: ProviderCost;
}

/** A provider's charge as a decimal string in a currency, never a float. */
export interface ProviderCost {
  readonly decimal: string;
  readonly currency: string;
}

export interface DeliveryReport {
  readonly providerMessageId: string;
  readonly status: 'delivered' | 'failed' | 'sent';
  readonly at: string;
  /** The gateway's own word for a failure (undelivered, rejected, expired). */
  readonly reason?: string;
  readonly cost?: ProviderCost;
}

/** A reply from a phone, through the two-way short code. */
export interface InboundSms {
  readonly providerMessageId: string;
  /** E.164. */
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly at: string;
}

export interface SmsPort {
  readonly provider: string;
  send(message: SmsMessage): Promise<SmsSendResult>;
  parseDeliveryReport(body: unknown): DeliveryReport | null;
  /** An inbound SMS webhook body, or null when the body is not one. */
  parseInbound?(body: unknown): InboundSms | null;
}

/** A provider's decimal charge (a JSON number or string such as 0.0246), kept as its text. */
export function costOf(value: unknown, currency = 'GHS'): ProviderCost | undefined {
  const text =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : null;
  if (text === null || !/^\d{1,9}(?:\.\d{1,12})?$/.test(text)) return undefined;
  return { decimal: text, currency };
}

/** Reads a field whatever its case: Hubtel's callbacks spell keys both ways. */
function field(body: Record<string, unknown>, name: string): unknown {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(body)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

/** A phone number as Ghanaian gateways write it (233XXXXXXXXX), in E.164. */
export function e164FromGateway(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.trim().replace(/^\+/, '');
  const e164 =
    digits.startsWith('0') && digits.length === 10 ? `+233${digits.slice(1)}` : `+${digits}`;
  return isE164(e164) ? e164 : null;
}

/**
 * Hubtel's delivery callback, which carries what "Get a message" returns
 * (code.hubtel.com/docs/api/v1/sms/get-message): its `messageId` and `status` (Delivered,
 * Undelivered, Rejected, Expired). Keys are read in either case.
 */
export function parseHubtelDeliveryReport(body: unknown): DeliveryReport | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const id = field(b, 'messageId');
  const status = field(b, 'status');
  if (typeof id !== 'string' || id.length === 0 || typeof status !== 'string') return null;
  const word = status.toLowerCase();
  const mapped: DeliveryReport['status'] | null =
    word === 'delivered'
      ? 'delivered'
      : ['undelivered', 'rejected', 'expired', 'failed'].includes(word)
        ? 'failed'
        : ['sent', 'submitted', 'pending', 'accepted'].includes(word)
          ? 'sent'
          : null;
  if (!mapped) return null;
  const at = field(b, 'updateTime') ?? field(b, 'time');
  const cost = costOf(field(b, 'rate'));
  return {
    providerMessageId: id,
    status: mapped,
    at:
      typeof at === 'string' && !Number.isNaN(Date.parse(at))
        ? new Date(at).toISOString()
        : new Date().toISOString(),
    ...(mapped === 'failed' ? { reason: word } : {}),
    ...(cost === undefined ? {} : { cost }),
  };
}

/**
 * An inbound SMS from Hubtel's two-way short code: `From`, `To`, `Content` and the message id,
 * keys in either case. Hubtel posts these to the callback the short code is set up with.
 */
export function parseHubtelInbound(body: unknown): InboundSms | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const from = e164FromGateway(field(b, 'from'));
  const text = field(b, 'content') ?? field(b, 'message') ?? field(b, 'text');
  const id = field(b, 'messageId') ?? field(b, 'id');
  const to = field(b, 'to');
  if (!from || typeof text !== 'string' || (typeof id !== 'string' && typeof id !== 'number'))
    return null;
  const at = field(b, 'date') ?? field(b, 'time');
  return {
    providerMessageId: String(id),
    from,
    to: typeof to === 'string' ? to : '',
    text: text.slice(0, 1600),
    at:
      typeof at === 'string' && !Number.isNaN(Date.parse(at))
        ? new Date(at).toISOString()
        : new Date().toISOString(),
  };
}

/**
 * Hubtel and Postmark sign nothing, so their webhooks carry a secret of ours per webhook (plan
 * 4.4): in the URL's `secret` query value or as the Basic password. Compared in constant time.
 */
export function webhookSecretMatches(
  provided: string | undefined | null,
  expected: string | undefined,
): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface HubtelSmsOptions {
  /** Hubtel's API ID and API Key (code.hubtel.com/docs/get-started/keys). */
  readonly clientId: string;
  readonly clientSecret: string;
  /** The approved sender ID (at most 11 characters). */
  readonly senderId: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

const hubtelSendResponse = z.object({
  messageId: z.string().min(1).nullable().optional(),
  status: z.number(),
  rate: z.union([z.number(), z.string()]).nullable().optional(),
});

/** Hubtel's `status` codes that sending again will not fix (code.hubtel.com/docs/api/v1/sms). */
const HUBTEL_PERMANENT = new Set([1, 2, 3, 4, 6, 7, 8, 100]);

/**
 * Hubtel SMS (decision 1; code.hubtel.com/docs/api/v1/sms/send-sms): `POST /v1/messages/send` on
 * sms.hubtel.com with Basic auth. A 2xx can still carry a refusal in `status`, so it is read.
 */
export class HubtelSms implements SmsPort {
  readonly provider = 'hubtel';
  private readonly base: string;

  constructor(private readonly options: HubtelSmsOptions) {
    if (!options.clientId || !options.clientSecret)
      throw new Error('Hubtel keys are not configured');
    if (!/^[A-Za-z0-9 ]{1,11}$/.test(options.senderId))
      throw new Error('HUBTEL_SENDER_ID must be 1 to 11 letters or digits');
    this.base = options.baseUrl ?? 'https://sms.hubtel.com';
  }

  async send(message: SmsMessage): Promise<SmsSendResult> {
    if (!isE164(message.to))
      throw invalidRequest(this.provider, 'recipient must be an E.164 number');
    if (message.body.length === 0 || message.body.length > 1600)
      throw invalidRequest(this.provider, 'text must be 1 to 1600 characters');
    const auth = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString(
      'base64',
    );
    let raw: unknown;
    try {
      raw = await requestJson<unknown>(this.provider, `${this.base}/v1/messages/send`, {
        body: {
          From: message.senderId ?? this.options.senderId,
          To: message.to.slice(1),
          Content: message.body,
          RegisteredDelivery: true,
          ...(message.reference === undefined
            ? {}
            : { ClientReference: message.reference.slice(0, 100) }),
        },
        headers: { authorization: `Basic ${auth}` },
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      });
    } catch (error) {
      // 402 (no credit) is fixed by topping up: worth trying again later. 403: the recipient
      // has refused messages; never retried.
      if (error instanceof ProviderError && error.status === 402)
        throw new ProviderError(this.provider, 'HTTP 402', true, 402);
      throw error;
    }
    const parsed = hubtelSendResponse.safeParse(raw);
    if (!parsed.success) throw unexpectedResponse(this.provider);
    const { status, messageId, rate } = parsed.data;
    if (status !== 0 || !messageId)
      throw new ProviderError(
        this.provider,
        `status ${status}`,
        !HUBTEL_PERMANENT.has(status),
        400,
      );
    const cost = costOf(rate);
    return {
      provider: this.provider,
      providerMessageId: messageId,
      ...(cost === undefined ? {} : { cost }),
    };
  }

  parseDeliveryReport(body: unknown): DeliveryReport | null {
    return parseHubtelDeliveryReport(body);
  }

  parseInbound(body: unknown): InboundSms | null {
    return parseHubtelInbound(body);
  }
}

function parseReport(body: unknown): DeliveryReport | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'string' || typeof b.status !== 'string' || typeof b.at !== 'string')
    return null;
  if (!['delivered', 'failed', 'sent'].includes(b.status)) return null;
  return { providerMessageId: b.id, status: b.status as DeliveryReport['status'], at: b.at };
}

/** Records messages in memory, for unit and integration tests. */
export class InMemorySms implements SmsPort {
  readonly provider = 'memory';
  readonly sent: (SmsMessage & { providerMessageId: string })[] = [];

  send(message: SmsMessage): Promise<SmsSendResult> {
    // Same rule as the gateway and the fake server: E.164 only.
    if (!/^\+[1-9]\d{6,14}$/.test(message.to)) {
      return Promise.reject(
        new ProviderError(this.provider, 'recipient must be an E.164 number', false, 400),
      );
    }
    const providerMessageId = `mem-sms-${this.sent.length + 1}`;
    this.sent.push({ ...message, providerMessageId });
    return Promise.resolve({ provider: this.provider, providerMessageId });
  }

  parseDeliveryReport(body: unknown): DeliveryReport | null {
    return parseReport(body) ?? parseHubtelDeliveryReport(body);
  }

  parseInbound(body: unknown): InboundSms | null {
    return parseHubtelInbound(body);
  }

  lastTo(to: string): SmsMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}

/** Talks to `apps/fake-providers` over HTTP, as a real gateway adapter would. */
export class FakeProvidersSms implements SmsPort {
  readonly provider = 'fake-providers';
  constructor(private readonly baseUrl: string) {}

  async send(message: SmsMessage): Promise<SmsSendResult> {
    const result = await requestJson<{ id: string }>(
      this.provider,
      `${this.baseUrl}/sms/messages`,
      { body: message },
    );
    return { provider: this.provider, providerMessageId: result.id };
  }

  parseDeliveryReport(body: unknown): DeliveryReport | null {
    return parseReport(body) ?? parseHubtelDeliveryReport(body);
  }

  /** The fake's simulated replies use Hubtel's inbound shape. */
  parseInbound(body: unknown): InboundSms | null {
    return parseHubtelInbound(body);
  }
}
