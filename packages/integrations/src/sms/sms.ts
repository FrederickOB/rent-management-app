import { ProviderError, requestJson } from '../http';

/** SMS gateway (CLAUDE.md section 8). The real gateway adapter arrives in M6. */
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
}

export interface DeliveryReport {
  readonly providerMessageId: string;
  readonly status: 'delivered' | 'failed' | 'sent';
  readonly at: string;
}

export interface SmsPort {
  readonly provider: string;
  send(message: SmsMessage): Promise<SmsSendResult>;
  parseDeliveryReport(body: unknown): DeliveryReport | null;
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
    return parseReport(body);
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
    return parseReport(body);
  }
}
