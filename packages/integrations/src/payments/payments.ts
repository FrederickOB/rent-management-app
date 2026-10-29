import { z } from 'zod';
import { hmacHex, signatureMatches } from '../hmac';
import { requestJson } from '../http';
import {
  conflict,
  invalidRequest,
  isE164,
  isEmailAddress,
  notFound,
  unexpectedResponse,
} from '../validation';

/**
 * MoMo, card and bank payments (CLAUDE.md section 8). Paystack is the first real adapter (M4b);
 * these shapes follow it loosely and stay minimal until then. Amounts are integer pesewas.
 *
 * Settlement (D1): every charge names the landlord's or agency's subaccount, so rent settles there
 * directly and never into a platform balance.
 */
export type PaymentChannel = 'momo' | 'card' | 'bank';
export type ChargeStatus = 'success' | 'failed' | 'pending' | 'abandoned';

export interface ChargeRequest {
  /** Our reference, unique per charge: letters, digits, `-`, `.` and `=` (Paystack's rule, OQ-05). */
  readonly reference: string;
  /** Integer pesewas, more than zero. */
  readonly amountMinor: number;
  readonly currency: 'GHS';
  readonly channel: PaymentChannel;
  /** Paystack requires an email (OQ-06). A MoMo phone means the approval prompt goes to it. */
  readonly customer: { readonly email: string; readonly phone?: string };
  readonly subaccountCode: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ChargeInitialised {
  readonly provider: string;
  readonly providerReference: string;
  /** Where to send the payer, when the provider collects payment details on its own page. */
  readonly authorizationUrl?: string;
  readonly status: ChargeStatus;
}

/**
 * What the provider says about a charge. Callers compare amount, currency, status and reference
 * with their own record exactly (CLAUDE.md section 8), so nothing here is narrowed or coerced.
 */
export interface VerifiedCharge {
  readonly status: ChargeStatus;
  /** The amount the provider reports, in minor units: what was actually paid once successful. */
  readonly amountMinor: number;
  readonly currency: string;
  readonly reference: string;
  readonly paidAt?: string;
  readonly channel: PaymentChannel;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ProviderTransaction extends VerifiedCharge {
  readonly subaccountCode: string;
  readonly createdAt: string;
}

export interface ProviderSettlement {
  readonly settlementId: string;
  readonly subaccountCode: string;
  readonly status: 'pending' | 'success' | 'failed';
  readonly currency: string;
  readonly grossMinor: number;
  readonly feesMinor: number;
  /** Gross less fees: what reached the subaccount's bank account. */
  readonly netMinor: number;
  readonly settledAt: string;
  /** References of the charges in this settlement. */
  readonly references: readonly string[];
}

/** A half-open range of instants, ISO 8601 with an offset: `from` inclusive, `to` exclusive. */
export interface InstantRange {
  readonly from: string;
  readonly to: string;
}

export interface SubaccountRequest {
  readonly businessName: string;
  /** The provider's bank (or MoMo network) code. */
  readonly settlementBank: string;
  readonly accountNumber: string;
}

/** The only facts taken from a webhook body. Money is never posted from it (CLAUDE.md section 8). */
export interface PaymentWebhookEvent {
  /** Unique per event, for `webhook_inbox`. */
  readonly eventId: string;
  readonly type: string;
  readonly reference: string;
}

export type WebhookHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface PaymentsPort {
  readonly provider: string;
  initialiseCharge(request: ChargeRequest): Promise<ChargeInitialised>;
  /** A non-retryable 404 when the provider does not know the reference. */
  verify(reference: string): Promise<VerifiedCharge>;
  /** Charges created in the range. */
  listTransactions(range: InstantRange): Promise<ProviderTransaction[]>;
  /** Settlements paid out in the range. */
  listSettlements(range: InstantRange): Promise<ProviderSettlement[]>;
  createSubaccount(request: SubaccountRequest): Promise<{ subaccountCode: string }>;
  /** HMAC-SHA512 of the raw body with the secret key, as Paystack signs webhooks. */
  verifyWebhookSignature(rawBody: Buffer | string, headers: WebhookHeaders): boolean;
  parseWebhook(rawBody: Buffer | string): PaymentWebhookEvent | null;
}

/** How a fake completes a charge: what the payer did, and optionally a different amount paid. */
export interface ChargeOutcome {
  readonly status: 'success' | 'failed' | 'abandoned';
  /** The amount actually paid, when it differs from the amount asked. */
  readonly amountMinor?: number;
  /** The provider's fee, deducted at settlement. */
  readonly feesMinor?: number;
}

export interface PaymentWebhookRequest {
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Test controls both fakes offer; not part of the port. */
export interface PaymentsTestControls {
  /**
   * The payer approves or declines. Like Paystack, only a successful charge sends a webhook
   * (`charge.success`); failed and abandoned ones are found by `verify`. Returns that webhook.
   */
  completeCharge(reference: string, outcome: ChargeOutcome): Promise<PaymentWebhookRequest | null>;
  /** Pays out every successful charge not yet settled, one settlement per subaccount. */
  settle(): Promise<ProviderSettlement[]>;
}

export const PAYSTACK_SIGNATURE_HEADER = 'x-paystack-signature';
const REFERENCE = /^[A-Za-z0-9.=-]{1,100}$/;
const CHANNELS: readonly string[] = ['momo', 'card', 'bank'];

export const isWholePesewas = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/** Refuses what Paystack refuses, so the in-memory fake fails where the provider would. */
export function checkChargeRequest(provider: string, request: ChargeRequest): void {
  if (!REFERENCE.test(request.reference)) {
    throw invalidRequest(provider, 'reference may hold 1 to 100 letters, digits, -, . and =');
  }
  if (!isWholePesewas(request.amountMinor)) {
    throw invalidRequest(provider, 'amount must be a positive whole number of pesewas');
  }
  if (request.currency !== 'GHS') throw invalidRequest(provider, 'currency must be GHS');
  if (!CHANNELS.includes(request.channel)) throw invalidRequest(provider, 'unknown channel');
  if (!isEmailAddress(request.customer.email)) {
    throw invalidRequest(provider, 'customer email required');
  }
  if (request.customer.phone !== undefined && !isE164(request.customer.phone)) {
    throw invalidRequest(provider, 'customer phone must be an E.164 number');
  }
  if (request.subaccountCode.length === 0) throw invalidRequest(provider, 'subaccount required');
  const values = Object.values(request.metadata);
  if (values.length > 50 || values.some((v) => typeof v !== 'string' || v.length > 500)) {
    throw invalidRequest(provider, 'metadata must be at most 50 strings of up to 500 characters');
  }
}

function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  const value = matches.length === 1 ? matches[0]?.[1] : undefined;
  return typeof value === 'string' ? value : undefined;
}

export function verifyPaystackSignature(
  secretKey: string,
  rawBody: Buffer | string,
  headers: WebhookHeaders,
): boolean {
  if (secretKey.length === 0) throw new Error('payments secret key is not configured');
  const signature = headerValue(headers, PAYSTACK_SIGNATURE_HEADER);
  return signature !== undefined && signatureMatches('sha512', secretKey, rawBody, signature);
}

const webhookSchema = z.object({
  event: z.string().min(1),
  data: z.object({
    id: z.union([z.number().int(), z.string().min(1)]),
    reference: z.string().min(1),
  }),
});

/** Paystack events carry no event id; the event name with the object's id identifies one. */
export function parsePaystackWebhook(rawBody: Buffer | string): PaymentWebhookEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
  } catch {
    return null;
  }
  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success) return null;
  const { event, data } = parsed.data;
  return { eventId: `${event}:${data.id}`, type: event, reference: data.reference };
}

const instant = z.iso.datetime({ offset: true });

function rangeMillis(provider: string, range: InstantRange): { from: number; to: number } {
  if (!instant.safeParse(range.from).success || !instant.safeParse(range.to).success) {
    throw invalidRequest(provider, 'range must be ISO 8601 instants with an offset');
  }
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  if (from > to) throw invalidRequest(provider, 'range starts after it ends');
  return { from, to };
}

const inRange = (at: string, range: { from: number; to: number }) => {
  const t = Date.parse(at);
  return t >= range.from && t < range.to;
};

// Paystack's channel names.
const PAYSTACK_CHANNEL: Record<PaymentChannel, string> = {
  momo: 'mobile_money',
  card: 'card',
  bank: 'bank',
};

interface MemoryCharge {
  readonly id: number;
  readonly request: ChargeRequest;
  readonly createdAt: string;
  status: ChargeStatus;
  amountMinor: number;
  feesMinor: number;
  paidAt?: string;
  settled: boolean;
}

/** Keeps charges in memory, for unit and integration tests. */
export class InMemoryPayments implements PaymentsPort, PaymentsTestControls {
  readonly provider = 'memory';
  private readonly subaccounts = new Map<string, SubaccountRequest>();
  private readonly charges = new Map<string, MemoryCharge>();
  private readonly settlements: ProviderSettlement[] = [];
  private counter = 0;

  constructor(private readonly secretKey = 'sk_test_in_memory') {}

  async initialiseCharge(request: ChargeRequest): Promise<ChargeInitialised> {
    checkChargeRequest(this.provider, request);
    if (!this.subaccounts.has(request.subaccountCode)) {
      throw invalidRequest(this.provider, 'unknown subaccount');
    }
    if (this.charges.has(request.reference)) throw conflict(this.provider, 'duplicate reference');
    const id = ++this.counter;
    this.charges.set(request.reference, {
      id,
      request: { ...request, customer: { ...request.customer }, metadata: { ...request.metadata } },
      createdAt: new Date().toISOString(),
      status: 'pending',
      amountMinor: request.amountMinor,
      feesMinor: 0,
      settled: false,
    });
    // A MoMo charge with a phone sends the approval prompt there; anything else needs a page.
    const prompt = request.channel === 'momo' && request.customer.phone !== undefined;
    return {
      provider: this.provider,
      providerReference: request.reference,
      status: 'pending',
      ...(prompt ? {} : { authorizationUrl: `https://checkout.fake.invalid/${id}` }),
    };
  }

  async verify(reference: string): Promise<VerifiedCharge> {
    const charge = this.charges.get(reference);
    if (!charge) throw notFound(this.provider, 'transaction');
    return this.view(charge);
  }

  async listTransactions(range: InstantRange): Promise<ProviderTransaction[]> {
    const window = rangeMillis(this.provider, range);
    return [...this.charges.values()]
      .filter((charge) => inRange(charge.createdAt, window))
      .map((charge) => ({
        ...this.view(charge),
        subaccountCode: charge.request.subaccountCode,
        createdAt: charge.createdAt,
      }));
  }

  async listSettlements(range: InstantRange): Promise<ProviderSettlement[]> {
    const window = rangeMillis(this.provider, range);
    return this.settlements
      .filter((s) => inRange(s.settledAt, window))
      .map((s) => ({ ...s, references: [...s.references] }));
  }

  async createSubaccount(request: SubaccountRequest): Promise<{ subaccountCode: string }> {
    checkSubaccount(this.provider, request);
    const subaccountCode = `ACCT_mem${++this.counter}`;
    this.subaccounts.set(subaccountCode, { ...request });
    return { subaccountCode };
  }

  verifyWebhookSignature(rawBody: Buffer | string, headers: WebhookHeaders): boolean {
    return verifyPaystackSignature(this.secretKey, rawBody, headers);
  }

  parseWebhook(rawBody: Buffer | string): PaymentWebhookEvent | null {
    return parsePaystackWebhook(rawBody);
  }

  async completeCharge(
    reference: string,
    outcome: ChargeOutcome,
  ): Promise<PaymentWebhookRequest | null> {
    const charge = this.charges.get(reference);
    if (!charge) throw notFound(this.provider, 'transaction');
    if (charge.status !== 'pending') throw conflict(this.provider, 'charge already completed');
    const amountMinor = outcome.amountMinor ?? charge.request.amountMinor;
    const feesMinor = outcome.feesMinor ?? 0;
    if (!isWholePesewas(amountMinor)) {
      throw invalidRequest(this.provider, 'amount must be whole pesewas');
    }
    if (!Number.isSafeInteger(feesMinor) || feesMinor < 0 || feesMinor > amountMinor) {
      throw invalidRequest(this.provider, 'fees must be whole pesewas, at most the amount');
    }
    charge.status = outcome.status;
    if (outcome.status !== 'success') return null;
    charge.amountMinor = amountMinor;
    charge.feesMinor = feesMinor;
    charge.paidAt = new Date().toISOString();
    const rawBody = JSON.stringify({ event: 'charge.success', data: this.paystackView(charge) });
    return {
      rawBody,
      headers: { [PAYSTACK_SIGNATURE_HEADER]: hmacHex('sha512', this.secretKey, rawBody) },
    };
  }

  async settle(): Promise<ProviderSettlement[]> {
    const due = new Map<string, MemoryCharge[]>();
    for (const charge of this.charges.values()) {
      if (charge.status !== 'success' || charge.settled) continue;
      const list = due.get(charge.request.subaccountCode) ?? [];
      list.push(charge);
      due.set(charge.request.subaccountCode, list);
    }
    const settledAt = new Date().toISOString();
    const created = [...due].map(([subaccountCode, charges]): ProviderSettlement => {
      const grossMinor = charges.reduce((sum, c) => sum + c.amountMinor, 0);
      const feesMinor = charges.reduce((sum, c) => sum + c.feesMinor, 0);
      for (const c of charges) c.settled = true;
      return {
        settlementId: `mem-settlement-${++this.counter}`,
        subaccountCode,
        status: 'success',
        currency: 'GHS',
        grossMinor,
        feesMinor,
        netMinor: grossMinor - feesMinor,
        settledAt,
        references: charges.map((c) => c.request.reference),
      };
    });
    this.settlements.push(...created);
    return created;
  }

  private view(charge: MemoryCharge): VerifiedCharge {
    return {
      status: charge.status,
      amountMinor: charge.amountMinor,
      currency: charge.request.currency,
      reference: charge.request.reference,
      ...(charge.paidAt === undefined ? {} : { paidAt: charge.paidAt }),
      channel: charge.request.channel,
      metadata: { ...charge.request.metadata },
    };
  }

  private paystackView(charge: MemoryCharge) {
    return {
      id: charge.id,
      status: charge.status,
      reference: charge.request.reference,
      amount: charge.amountMinor,
      currency: charge.request.currency,
      channel: PAYSTACK_CHANNEL[charge.request.channel],
      paid_at: charge.paidAt ?? null,
      created_at: charge.createdAt,
      metadata: charge.request.metadata,
      subaccount: { subaccount_code: charge.request.subaccountCode },
    };
  }
}

function checkSubaccount(provider: string, request: SubaccountRequest): void {
  if (request.businessName.trim().length === 0 || request.businessName.length > 100) {
    throw invalidRequest(provider, 'business name must be 1 to 100 characters');
  }
  if (request.settlementBank.trim().length === 0) {
    throw invalidRequest(provider, 'settlement bank required');
  }
  if (!/^\d{6,20}$/.test(request.accountNumber)) {
    throw invalidRequest(provider, 'account number must be 6 to 20 digits');
  }
}

const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const paystackStatus = z.enum([
  'success',
  'failed',
  'abandoned',
  'pending',
  'ongoing',
  'processing',
  'queued',
]);
const paystackChannel = z.enum(['mobile_money', 'card', 'bank', 'bank_transfer']);
const transaction = z.object({
  status: paystackStatus,
  reference: z.string().min(1),
  amount: minor,
  currency: z.string().min(1),
  channel: paystackChannel,
  paid_at: z.string().nullable().optional(),
  created_at: z.string().min(1),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  subaccount: z.object({ subaccount_code: z.string().min(1) }),
});
const envelope = <T extends z.ZodType>(data: T) => z.object({ status: z.literal(true), data });
const initializeResponse = envelope(
  z.object({ reference: z.string().min(1), authorization_url: z.url().optional() }),
);
const settlement = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  status: z.enum(['success', 'pending', 'processing', 'failed']),
  currency: z.string().min(1),
  total_amount: minor,
  total_fees: minor,
  effective_amount: minor,
  settlement_date: z.string().min(1),
  subaccount: z.object({ subaccount_code: z.string().min(1) }),
});

function toSettlement(
  s: z.infer<typeof settlement>,
  references: readonly string[],
): ProviderSettlement {
  return {
    settlementId: String(s.id),
    subaccountCode: s.subaccount.subaccount_code,
    status: s.status === 'processing' ? 'pending' : s.status,
    currency: s.currency,
    grossMinor: s.total_amount,
    feesMinor: s.total_fees,
    netMinor: s.effective_amount,
    settledAt: s.settlement_date,
    references: [...references],
  };
}

function toCharge(data: z.infer<typeof transaction>): VerifiedCharge {
  const status: ChargeStatus =
    data.status === 'success' || data.status === 'failed' || data.status === 'abandoned'
      ? data.status
      : 'pending';
  const channel: PaymentChannel =
    data.channel === 'mobile_money' ? 'momo' : data.channel === 'card' ? 'card' : 'bank';
  return {
    status,
    amountMinor: data.amount,
    currency: data.currency,
    reference: data.reference,
    ...(data.paid_at ? { paidAt: data.paid_at } : {}),
    channel,
    metadata: data.metadata ?? {},
  };
}

/** Talks to `apps/fake-providers` over HTTP, with request shapes like Paystack's. */
export class FakeProvidersPayments implements PaymentsPort, PaymentsTestControls {
  readonly provider = 'fake-providers';
  constructor(
    private readonly baseUrl: string,
    private readonly secretKey: string,
  ) {}

  async initialiseCharge(request: ChargeRequest): Promise<ChargeInitialised> {
    const phone = request.channel === 'momo' ? request.customer.phone : undefined;
    const response = await this.call(initializeResponse, '/transaction/initialize', {
      reference: request.reference,
      amount: request.amountMinor,
      currency: request.currency,
      email: request.customer.email,
      channels: [PAYSTACK_CHANNEL[request.channel]],
      subaccount: request.subaccountCode,
      metadata: request.metadata,
      ...(phone === undefined ? {} : { mobile_money: { phone } }),
    });
    return {
      provider: this.provider,
      providerReference: response.data.reference,
      status: 'pending',
      ...(response.data.authorization_url === undefined
        ? {}
        : { authorizationUrl: response.data.authorization_url }),
    };
  }

  async verify(reference: string): Promise<VerifiedCharge> {
    const response = await this.call(
      envelope(transaction),
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
    return toCharge(response.data);
  }

  async listTransactions(range: InstantRange): Promise<ProviderTransaction[]> {
    const response = await this.call(
      envelope(z.array(transaction)),
      `/transaction?${new URLSearchParams({ ...range })}`,
    );
    return response.data.map((t) => ({
      ...toCharge(t),
      subaccountCode: t.subaccount.subaccount_code,
      createdAt: t.created_at,
    }));
  }

  /** As with Paystack, a settlement's charges come from a second call. */
  async listSettlements(range: InstantRange): Promise<ProviderSettlement[]> {
    const response = await this.call(
      envelope(z.array(settlement)),
      `/settlement?${new URLSearchParams({ ...range })}`,
    );
    const result: ProviderSettlement[] = [];
    for (const s of response.data) {
      const charges = await this.call(
        envelope(z.array(transaction)),
        `/settlement/${encodeURIComponent(String(s.id))}/transactions`,
      );
      result.push(
        toSettlement(
          s,
          charges.data.map((t) => t.reference),
        ),
      );
    }
    return result;
  }

  async createSubaccount(request: SubaccountRequest): Promise<{ subaccountCode: string }> {
    const response = await this.call(
      envelope(z.object({ subaccount_code: z.string().min(1) })),
      '/subaccount',
      {
        business_name: request.businessName,
        settlement_bank: request.settlementBank,
        account_number: request.accountNumber,
      },
    );
    return { subaccountCode: response.data.subaccount_code };
  }

  verifyWebhookSignature(rawBody: Buffer | string, headers: WebhookHeaders): boolean {
    return verifyPaystackSignature(this.secretKey, rawBody, headers);
  }

  parseWebhook(rawBody: Buffer | string): PaymentWebhookEvent | null {
    return parsePaystackWebhook(rawBody);
  }

  async completeCharge(
    reference: string,
    outcome: ChargeOutcome,
  ): Promise<PaymentWebhookRequest | null> {
    const response = z
      .object({ webhook: z.object({ rawBody: z.string(), signature: z.string() }).nullable() })
      .safeParse(
        await requestJson<unknown>(
          this.provider,
          `${this.baseUrl}/payments/_test/charges/${encodeURIComponent(reference)}`,
          { body: outcome },
        ),
      );
    if (!response.success) throw unexpectedResponse(this.provider);
    const webhook = response.data.webhook;
    return (
      webhook && {
        rawBody: webhook.rawBody,
        headers: { [PAYSTACK_SIGNATURE_HEADER]: webhook.signature },
      }
    );
  }

  async settle(): Promise<ProviderSettlement[]> {
    const response = z
      .object({ settlements: z.array(settlement.extend({ references: z.array(z.string()) })) })
      .safeParse(
        await requestJson<unknown>(this.provider, `${this.baseUrl}/payments/_test/settle`, {
          body: {},
        }),
      );
    if (!response.success) throw unexpectedResponse(this.provider);
    return response.data.settlements.map((s) => toSettlement(s, s.references));
  }

  private async call<T extends z.ZodType>(
    schema: T,
    path: string,
    body?: unknown,
  ): Promise<z.infer<T>> {
    const response = await requestJson<unknown>(this.provider, `${this.baseUrl}/payments${path}`, {
      ...(body === undefined ? {} : { body }),
      headers: { authorization: `Bearer ${this.secretKey}` },
    });
    const parsed = schema.safeParse(response);
    if (!parsed.success) throw unexpectedResponse(this.provider);
    return parsed.data;
  }
}
