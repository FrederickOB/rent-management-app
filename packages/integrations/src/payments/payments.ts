import { SUBSCRIPTION_REFERENCE_PREFIX } from '@rent/domain/subscription';
import { z } from 'zod';
import { hmacHex, signatureMatches } from '../hmac';
import { ProviderError, requestJson } from '../http';
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
/** `reversed`: refunded or charged back after it succeeded (M4b). */
export type ChargeStatus = 'success' | 'failed' | 'pending' | 'abandoned' | 'reversed';
/** Ghana's MoMo networks, by our names; each adapter maps them to its provider's codes. */
export type MomoNetwork = 'mtn' | 'telecel' | 'at';
export const MOMO_NETWORK_NAMES: readonly MomoNetwork[] = ['mtn', 'telecel', 'at'];

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
  /** A MoMo charge: the network the phone is on (M4b plan 4.3). */
  readonly momoNetwork?: MomoNetwork;
  /** Shown on the provider's checkout (decision 5): the tenant's name, never their phone. */
  readonly customerName?: string;
  /** Where the provider's checkout returns the payer, for a card charge. */
  readonly callbackUrl?: string;
}

export interface ChargeInitialised {
  readonly provider: string;
  readonly providerReference: string;
  /** Where to send the payer, when the provider collects payment details on its own page. */
  readonly authorizationUrl?: string;
  readonly status: ChargeStatus;
  /** What the provider asks the payer to do, such as "Approve the payment on your phone". */
  readonly displayText?: string;
  /**
   * A next step the provider asks for that this product does not support yet, such as a code
   * sent to the payer (`send_otp`); the charge cannot finish here (M4b review 19; OQ-01).
   */
  readonly unsupportedStep?: string;
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
  /** The provider's fee on this charge, when it reports one. */
  readonly feesMinor?: number;
  /** The paying phone (E.164), when the provider reports one. Never logged. */
  readonly payerPhone?: string;
}

export interface ProviderSettlement {
  readonly settlementId: string;
  readonly subaccountCode: string;
  readonly status: 'pending' | 'success' | 'failed';
  readonly currency: string;
  readonly grossMinor: number;
  readonly feesMinor: number;
  /** Chargebacks and refunds taken out of this payout (OQ-41). */
  readonly deductionsMinor: number;
  /** Gross less fees and deductions: what reached the subaccount's bank account. */
  readonly netMinor: number;
  readonly settledAt: string;
  /** References of the charges in this settlement. */
  readonly references: readonly string[];
  /** The charges each deduction was for, where the provider says; may be fewer than the total. */
  readonly deductedReferences: readonly {
    readonly reference: string;
    readonly amountMinor: number;
  }[];
}

export interface RefundRequest {
  /** The charge's reference. */
  readonly reference: string;
  readonly amountMinor: number;
}

export interface RefundResult {
  readonly refundReference: string;
  readonly status: 'pending' | 'processed' | 'failed';
}

/**
 * Money taken back from a successful charge (M4b review items 2 and 17): a refund (ours, or made
 * at the provider) or a chargeback the payer's bank won. `processed` means the money has left.
 */
export interface ProviderReversal {
  readonly kind: 'refund' | 'chargeback';
  /** The provider's id for the refund or dispute. */
  readonly id: string;
  readonly status: 'pending' | 'processed' | 'failed';
  readonly amountMinor: number;
}

/** A refund or chargeback made in a range, with the charge it is about (reconciliation). */
export interface ListedReversal extends ProviderReversal {
  readonly reference: string;
}

/** A bank the provider settles to (ADR-008). */
export interface Bank {
  readonly code: string;
  readonly name: string;
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

/**
 * A charge for the platform's own revenue (M10 decision 9): the subscription. It names no
 * subaccount, so it settles to the platform's own balance at the provider. D1 governs rent, and
 * rent is never charged this way: every rent charge names the landlord's or agency's subaccount.
 * The reference starts `SUB-`, so webhooks and reconciliation route it to subscriptions.
 */
export interface PlatformChargeRequest {
  /** `SUB-…`, unique per charge, in the characters Paystack accepts. */
  readonly reference: string;
  /** Integer pesewas, more than zero. */
  readonly amountMinor: number;
  readonly currency: 'GHS';
  /** The payer's email (Paystack requires one, OQ-06). Never logged. */
  readonly email: string;
  readonly metadata: Readonly<Record<string, string>>;
  /** Where the provider's checkout returns the payer. */
  readonly callbackUrl?: string;
}

/** A platform charge by MoMo: the approval prompt goes straight to the phone. */
export interface PlatformMomoRequest extends Omit<PlatformChargeRequest, 'callbackUrl'> {
  /** E.164. Never logged. */
  readonly phone: string;
  readonly network: MomoNetwork;
}

/** The prefix every platform charge's reference carries (M10 decision 9). */
export const PLATFORM_REFERENCE_PREFIX = SUBSCRIPTION_REFERENCE_PREFIX;

export const isPlatformReference = (reference: string): boolean =>
  reference.startsWith(PLATFORM_REFERENCE_PREFIX);

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
  /**
   * M10 decision 9: a card charge for the platform's own revenue on the provider's checkout, with
   * no subaccount (it settles to the platform's balance). Never used for rent (D1).
   */
  initializePlatform(request: PlatformChargeRequest): Promise<ChargeInitialised>;
  /** As initializePlatform, by MoMo: the approval prompt goes to the phone. */
  chargePlatformMomo(request: PlatformMomoRequest): Promise<ChargeInitialised>;
  /** A non-retryable 404 when the provider does not know the reference. */
  verify(reference: string): Promise<VerifiedCharge>;
  /** As verify, with the subaccount, the fee and the paying phone (M4b: money with no intent). */
  verifyTransaction(reference: string): Promise<ProviderTransaction>;
  /** Charges created in the range. */
  listTransactions(range: InstantRange): Promise<ProviderTransaction[]>;
  /** Settlements paid out in the range. */
  listSettlements(range: InstantRange): Promise<ProviderSettlement[]>;
  createSubaccount(request: SubaccountRequest): Promise<{ subaccountCode: string }>;
  /**
   * Refunds a charge to its payer (P31). Like Paystack, a charge already refunded is refused:
   * ask `reversals` first, never call this blind on a retry.
   */
  refund(request: RefundRequest): Promise<RefundResult>;
  /** Every refund and chargeback against a charge; empty when there is none. */
  reversals(reference: string): Promise<ProviderReversal[]>;
  /** Refunds and chargebacks made in the range, whatever day their charge was paid. */
  listReversals(range: InstantRange): Promise<ListedReversal[]>;
  /** The account's name at the bank, where the provider can check it; null where it cannot. */
  resolveAccount(check: {
    readonly bankCode: string;
    readonly accountNumber: string;
  }): Promise<{ readonly accountName: string } | null>;
  listBanks(): Promise<Bank[]>;
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
  /**
   * M11 (e2e test controls): false marks the charge paid without the provider sending its
   * webhook, as when a webhook is lost; the caller then answers null. Absent: sent as usual.
   */
  readonly webhook?: boolean;
}

export interface PaymentWebhookRequest {
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A payment that reaches a subaccount without our pay page (M4b: the unmatched queue). */
export interface ExternalPayment {
  readonly subaccountCode: string;
  readonly amountMinor: number;
  readonly channel: PaymentChannel;
  readonly payerPhone?: string;
  /** What the payer typed, such as a lease payment reference. */
  readonly narration?: string;
  readonly feesMinor?: number;
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
  /**
   * The payer's bank charges a successful payment back: it becomes `reversed`, the next settlement
   * to its subaccount deducts it, and a signed `charge.dispute.resolve` webhook is returned.
   */
  chargeback(reference: string, amountMinor?: number): Promise<PaymentWebhookRequest>;
  /** A successful payment to a subaccount that did not come from our pay page, with its webhook. */
  payExternal(
    payment: ExternalPayment,
  ): Promise<{ readonly reference: string; readonly webhook: PaymentWebhookRequest }>;
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
  if (request.momoNetwork !== undefined && !MOMO_NETWORK_NAMES.includes(request.momoNetwork)) {
    throw invalidRequest(provider, 'unknown MoMo network');
  }
  const values = Object.values(request.metadata);
  if (values.length > 50 || values.some((v) => typeof v !== 'string' || v.length > 500)) {
    throw invalidRequest(provider, 'metadata must be at most 50 strings of up to 500 characters');
  }
}

/**
 * Refuses what Paystack refuses for a platform charge, and any reference without the platform
 * prefix: a charge with no subaccount is only ever the platform's own (M10 decision 9; D1).
 */
export function checkPlatformChargeRequest(
  provider: string,
  request: PlatformChargeRequest | PlatformMomoRequest,
): void {
  if (!REFERENCE.test(request.reference)) {
    throw invalidRequest(provider, 'reference may hold 1 to 100 letters, digits, -, . and =');
  }
  if (!isPlatformReference(request.reference)) {
    throw invalidRequest(
      provider,
      `a platform charge's reference starts ${PLATFORM_REFERENCE_PREFIX}`,
    );
  }
  if (!isWholePesewas(request.amountMinor)) {
    throw invalidRequest(provider, 'amount must be a positive whole number of pesewas');
  }
  if (request.currency !== 'GHS') throw invalidRequest(provider, 'currency must be GHS');
  if (!isEmailAddress(request.email)) throw invalidRequest(provider, 'customer email required');
  if ('phone' in request) {
    if (!isE164(request.phone)) throw invalidRequest(provider, 'phone must be an E.164 number');
    if (!MOMO_NETWORK_NAMES.includes(request.network))
      throw invalidRequest(provider, 'unknown MoMo network');
  }
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

const id = z.union([z.number().int(), z.string().min(1)]);
const webhookSchema = z.object({
  event: z.string().min(1),
  data: z.object({
    id: id.optional(),
    reference: z.string().min(1).optional(),
    /** Refund events name the charge this way. */
    transaction_reference: z.string().min(1).optional(),
    refund_reference: z.string().min(1).optional(),
    /** Dispute events carry the charge they are about. */
    transaction: z
      .object({ reference: z.string().min(1) })
      .partial()
      .optional(),
  }),
});

/**
 * Paystack events carry no event id; the event name with the object's id identifies one. Charge
 * events name the charge's reference; refund and dispute events name the charge they are about.
 */
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
  const reference = data.reference ?? data.transaction_reference ?? data.transaction?.reference;
  const objectId = data.id ?? data.refund_reference;
  if (reference === undefined || objectId === undefined) return null;
  return { eventId: `${event}:${objectId}`, type: event, reference };
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
  /** Charged back after it was paid: deducted from the next settlement once. */
  chargedBack?: { readonly amountMinor: number; deducted: boolean };
  /** Refunds and disputes against it, oldest first. */
  reversals: {
    kind: 'refund' | 'chargeback';
    id: string;
    status: ProviderReversal['status'];
    amountMinor: number;
    createdAt: string;
  }[];
}

/** Banks the fakes settle to: fictional codes, never a real institution's. */
export const FAKE_BANKS: readonly Bank[] = [
  { code: 'FAKEBANK1', name: 'Test Bank One' },
  { code: 'FAKEBANK2', name: 'Test Bank Two' },
];

/**
 * The name the fakes return for an account check: fictional, from the last four digits, so a
 * test can tell a name came from the provider. An account number ending 0000 cannot be checked.
 */
export const fakeAccountName = (accountNumber: string): string | null =>
  accountNumber.endsWith('0000') ? null : `TEST ACCOUNT ${accountNumber.slice(-4)}`;

/** Keeps charges in memory, for unit and integration tests. A second instance stands in for failover. */
export class InMemoryPayments implements PaymentsPort, PaymentsTestControls {
  private readonly subaccounts = new Map<string, SubaccountRequest>();
  private readonly charges = new Map<string, MemoryCharge>();
  private readonly settlements: ProviderSettlement[] = [];
  private counter = 0;
  /** Set to make initialiseCharge fail as a provider outage would (BC-02 failover tests). */
  failCharges = false;
  /** Set to make refunds wait at the provider (`pending`) until `completeRefund` (Paystack does). */
  pendingRefunds = false;

  constructor(
    private readonly secretKey = 'sk_test_in_memory',
    readonly provider = 'memory',
  ) {}

  async initialiseCharge(request: ChargeRequest): Promise<ChargeInitialised> {
    if (this.failCharges) throw new ProviderError(this.provider, 'HTTP 503', true, 503);
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
      reversals: [],
    });
    // A MoMo charge with a phone sends the approval prompt there; anything else needs a page.
    const prompt = request.channel === 'momo' && request.customer.phone !== undefined;
    return {
      provider: this.provider,
      providerReference: request.reference,
      status: 'pending',
      ...(prompt
        ? { displayText: 'Approve the payment on your phone' }
        : { authorizationUrl: `https://checkout.fake.invalid/${id}` }),
    };
  }

  async initializePlatform(request: PlatformChargeRequest): Promise<ChargeInitialised> {
    if (this.failCharges) throw new ProviderError(this.provider, 'HTTP 503', true, 503);
    checkPlatformChargeRequest(this.provider, request);
    return this.platformCharge(request, 'card');
  }

  async chargePlatformMomo(request: PlatformMomoRequest): Promise<ChargeInitialised> {
    if (this.failCharges) throw new ProviderError(this.provider, 'HTTP 503', true, 503);
    checkPlatformChargeRequest(this.provider, request);
    return this.platformCharge(request, 'momo');
  }

  /** A platform charge: no subaccount, so it settles to the platform's own balance (decision 9). */
  private platformCharge(
    request: PlatformChargeRequest | PlatformMomoRequest,
    channel: 'card' | 'momo',
  ): ChargeInitialised {
    if (this.charges.has(request.reference)) throw conflict(this.provider, 'duplicate reference');
    const id = ++this.counter;
    const phone = 'phone' in request ? request.phone : undefined;
    this.charges.set(request.reference, {
      id,
      request: {
        reference: request.reference,
        amountMinor: request.amountMinor,
        currency: request.currency,
        channel,
        customer: { email: request.email, ...(phone ? { phone } : {}) },
        subaccountCode: '',
        metadata: { ...request.metadata },
        ...('network' in request ? { momoNetwork: request.network } : {}),
      },
      createdAt: new Date().toISOString(),
      status: 'pending',
      amountMinor: request.amountMinor,
      feesMinor: 0,
      settled: false,
      reversals: [],
    });
    return {
      provider: this.provider,
      providerReference: request.reference,
      status: 'pending',
      ...(channel === 'momo'
        ? { displayText: 'Approve the payment on your phone' }
        : { authorizationUrl: `https://checkout.fake.invalid/${id}` }),
    };
  }

  async verify(reference: string): Promise<VerifiedCharge> {
    const charge = this.charges.get(reference);
    if (!charge) throw notFound(this.provider, 'transaction');
    return this.view(charge);
  }

  async verifyTransaction(reference: string): Promise<ProviderTransaction> {
    const charge = this.charges.get(reference);
    if (!charge) throw notFound(this.provider, 'transaction');
    return this.transaction(charge);
  }

  async listTransactions(range: InstantRange): Promise<ProviderTransaction[]> {
    const window = rangeMillis(this.provider, range);
    return [...this.charges.values()]
      .filter((charge) => inRange(charge.createdAt, window))
      .map((charge) => this.transaction(charge));
  }

  async listSettlements(range: InstantRange): Promise<ProviderSettlement[]> {
    const window = rangeMillis(this.provider, range);
    return this.settlements
      .filter((s) => inRange(s.settledAt, window))
      .map((s) => ({
        ...s,
        references: [...s.references],
        deductedReferences: [...s.deductedReferences],
      }));
  }

  async createSubaccount(request: SubaccountRequest): Promise<{ subaccountCode: string }> {
    checkSubaccount(this.provider, request);
    const subaccountCode = `ACCT_${this.provider.replace(/[^a-z0-9]/gi, '')}${++this.counter}`;
    this.subaccounts.set(subaccountCode, { ...request });
    return { subaccountCode };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const charge = this.charges.get(request.reference);
    if (!charge) throw notFound(this.provider, 'transaction');
    // Paystack refuses a second refund of a charge, and one of a charge that is not paid.
    if (charge.reversals.some((r) => r.kind === 'refund' && r.status !== 'failed'))
      throw invalidRequest(this.provider, 'Transaction has been fully reversed');
    if (charge.status !== 'success') throw invalidRequest(this.provider, 'charge not refundable');
    if (!isWholePesewas(request.amountMinor) || request.amountMinor > charge.amountMinor)
      throw invalidRequest(
        this.provider,
        'refund amount must be whole pesewas, at most the charge',
      );
    const refund = {
      kind: 'refund' as const,
      id: `rf-${++this.counter}`,
      status: this.pendingRefunds ? ('pending' as const) : ('processed' as const),
      amountMinor: request.amountMinor,
      createdAt: new Date().toISOString(),
    };
    charge.reversals.push(refund);
    if (refund.status === 'processed') this.takeBack(charge, refund.amountMinor);
    return { refundReference: refund.id, status: refund.status };
  }

  async reversals(reference: string): Promise<ProviderReversal[]> {
    const charge = this.charges.get(reference);
    if (!charge) throw notFound(this.provider, 'transaction');
    return [...charge.reversals].reverse().map(({ createdAt: _at, ...r }) => r);
  }

  async listReversals(range: InstantRange): Promise<ListedReversal[]> {
    const window = rangeMillis(this.provider, range);
    return [...this.charges.values()].flatMap((charge) =>
      charge.reversals
        .filter((r) => inRange(r.createdAt, window))
        .map(({ createdAt: _at, ...r }) => ({ ...r, reference: charge.request.reference })),
    );
  }

  /**
   * Test control: a pending refund finishes at the provider (`processed` or `failed`); returns
   * the signed `refund.processed` or `refund.failed` webhook Paystack would send.
   */
  async completeRefund(
    reference: string,
    status: 'processed' | 'failed',
  ): Promise<PaymentWebhookRequest> {
    const charge = this.charges.get(reference);
    const refund = charge?.reversals.find((r) => r.kind === 'refund' && r.status === 'pending');
    if (!charge || !refund) throw notFound(this.provider, 'refund');
    refund.status = status;
    if (status === 'processed') this.takeBack(charge, refund.amountMinor);
    return this.signed({
      event: `refund.${status}`,
      data: {
        id: refund.id,
        status,
        amount: refund.amountMinor,
        currency: 'GHS',
        transaction_reference: reference,
      },
    });
  }

  /** Money taken back from a paid charge: a whole one is reversed; the next settlement deducts it. */
  private takeBack(charge: MemoryCharge, amountMinor: number): void {
    const waiting =
      charge.chargedBack && !charge.chargedBack.deducted ? charge.chargedBack.amountMinor : 0;
    const taken = charge.reversals
      .filter((r) => r.status === 'processed')
      .reduce((sum, r) => sum + r.amountMinor, 0);
    if (taken >= charge.amountMinor) charge.status = 'reversed';
    charge.chargedBack = { amountMinor: waiting + amountMinor, deducted: false };
  }

  async resolveAccount(check: {
    readonly bankCode: string;
    readonly accountNumber: string;
  }): Promise<{ readonly accountName: string } | null> {
    if (!FAKE_BANKS.some((b) => b.code === check.bankCode))
      throw invalidRequest(this.provider, 'unknown bank');
    if (!/^\d{6,20}$/.test(check.accountNumber))
      throw invalidRequest(this.provider, 'account number must be 6 to 20 digits');
    const accountName = fakeAccountName(check.accountNumber);
    return accountName ? { accountName } : null;
  }

  async listBanks(): Promise<Bank[]> {
    return FAKE_BANKS.map((b) => ({ ...b }));
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
    if (outcome.webhook === false) return null;
    return this.signed({ event: 'charge.success', data: this.paystackView(charge) });
  }

  async chargeback(reference: string, amountMinor?: number): Promise<PaymentWebhookRequest> {
    const charge = this.charges.get(reference);
    if (!charge) throw notFound(this.provider, 'transaction');
    if (charge.status !== 'success')
      throw conflict(this.provider, 'only a paid charge is disputed');
    const amount = amountMinor ?? charge.amountMinor;
    if (!isWholePesewas(amount) || amount > charge.amountMinor)
      throw invalidRequest(this.provider, 'a chargeback is at most the charge');
    const id = String(++this.counter);
    charge.reversals.push({
      kind: 'chargeback',
      id,
      status: 'processed',
      amountMinor: amount,
      createdAt: new Date().toISOString(),
    });
    this.takeBack(charge, amount);
    return this.signed({
      event: 'charge.dispute.resolve',
      data: {
        id: Number(id),
        status: 'resolved',
        resolution: 'merchant-accepted',
        refund_amount: amount,
        currency: 'GHS',
        transaction: { id: charge.id, reference: charge.request.reference },
      },
    });
  }

  async payExternal(
    payment: ExternalPayment,
  ): Promise<{ readonly reference: string; readonly webhook: PaymentWebhookRequest }> {
    if (!this.subaccounts.has(payment.subaccountCode))
      throw invalidRequest(this.provider, 'unknown subaccount');
    const reference = `ext-${++this.counter}-${Date.now().toString(36)}`;
    const id = ++this.counter;
    const charge: MemoryCharge = {
      id,
      request: {
        reference,
        amountMinor: payment.amountMinor,
        currency: 'GHS',
        channel: payment.channel,
        customer: {
          email: `payer-${id}@example.test`,
          ...(payment.payerPhone ? { phone: payment.payerPhone } : {}),
        },
        subaccountCode: payment.subaccountCode,
        metadata: payment.narration ? { narration: payment.narration } : {},
      },
      createdAt: new Date().toISOString(),
      status: 'success',
      amountMinor: payment.amountMinor,
      feesMinor: payment.feesMinor ?? 0,
      paidAt: new Date().toISOString(),
      settled: false,
      reversals: [],
    };
    this.charges.set(reference, charge);
    return {
      reference,
      webhook: this.signed({ event: 'charge.success', data: this.paystackView(charge) }),
    };
  }

  async settle(): Promise<ProviderSettlement[]> {
    const due = new Map<string, { paid: MemoryCharge[]; back: MemoryCharge[] }>();
    const group = (code: string) => {
      const found = due.get(code) ?? { paid: [], back: [] };
      due.set(code, found);
      return found;
    };
    for (const charge of this.charges.values()) {
      const code = charge.request.subaccountCode;
      const waiting = !!charge.chargedBack && !charge.chargedBack.deducted;
      if (waiting && charge.settled) group(code).back.push(charge);
      if (charge.settled) continue;
      // Refunded or charged back before it was paid out: settled and deducted together.
      if (charge.status === 'success' || (charge.status === 'reversed' && charge.chargedBack))
        group(code).paid.push(charge);
      if (waiting) group(code).back.push(charge);
    }
    const settledAt = new Date().toISOString();
    const created = [...due].map(([subaccountCode, { paid, back }]): ProviderSettlement => {
      const grossMinor = paid.reduce((sum, c) => sum + c.amountMinor, 0);
      const feesMinor = paid.reduce((sum, c) => sum + c.feesMinor, 0);
      const deductedReferences = back.map((c) => ({
        reference: c.request.reference,
        amountMinor: c.chargedBack!.amountMinor,
      }));
      const deductionsMinor = deductedReferences.reduce((sum, d) => sum + d.amountMinor, 0);
      for (const c of paid) c.settled = true;
      for (const c of back) c.chargedBack!.deducted = true;
      return {
        settlementId: `${this.provider}-settlement-${++this.counter}`,
        subaccountCode,
        status: 'success',
        currency: 'GHS',
        grossMinor,
        feesMinor,
        deductionsMinor,
        netMinor: grossMinor - feesMinor - deductionsMinor,
        settledAt,
        references: paid.map((c) => c.request.reference),
        deductedReferences,
      };
    });
    this.settlements.push(...created);
    return created;
  }

  private signed(body: unknown): PaymentWebhookRequest {
    const rawBody = JSON.stringify(body);
    return {
      rawBody,
      headers: { [PAYSTACK_SIGNATURE_HEADER]: hmacHex('sha512', this.secretKey, rawBody) },
    };
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

  private transaction(charge: MemoryCharge): ProviderTransaction {
    return {
      ...this.view(charge),
      subaccountCode: charge.request.subaccountCode,
      createdAt: charge.createdAt,
      feesMinor: charge.feesMinor,
      ...(charge.request.customer.phone ? { payerPhone: charge.request.customer.phone } : {}),
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
      // A platform charge names no subaccount (M10 decision 9), as Paystack shows it.
      subaccount: charge.request.subaccountCode
        ? { subaccount_code: charge.request.subaccountCode }
        : {},
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
  'reversed',
  'pending',
  'ongoing',
  'processing',
  'queued',
  'send_otp',
  'pay_offline',
]);
const paystackChannel = z.enum(['mobile_money', 'card', 'bank', 'bank_transfer']);
export const paystackTransaction = z.object({
  id: z.union([z.number().int(), z.string().min(1)]).optional(),
  status: paystackStatus,
  reference: z.string().min(1),
  amount: minor,
  currency: z.string().min(1),
  channel: paystackChannel,
  paid_at: z.string().nullable().optional(),
  created_at: z.string().min(1).optional(),
  createdAt: z.string().min(1).optional(),
  fees: minor.nullable().optional(),
  metadata: z
    .union([z.record(z.string(), z.unknown()), z.string(), z.number()])
    .nullable()
    .optional(),
  customer: z.object({ phone: z.string().nullable().optional() }).partial().nullable().optional(),
  subaccount: z
    .union([z.object({ subaccount_code: z.string().min(1) }).partial(), z.object({})])
    .nullable()
    .optional(),
});
export const paystackEnvelope = <T extends z.ZodType>(data: T) =>
  z.object({ status: z.literal(true), data });

const objectId = z.union([z.number().int(), z.string().min(1)]);
/** A charge as a refund or dispute names it: its id, or the transaction itself. */
const namedTransaction = z.union([
  objectId,
  z.object({ id: objectId.optional(), reference: z.string().min(1).optional() }).loose(),
]);

/**
 * A Paystack refund, as the refund API lists it. `settlement` and `deducted_amount` say which
 * payout it was taken from and how much (documented fields; their use is an assumption, OQ-01).
 */
export const paystackRefund = z
  .object({
    id: objectId,
    transaction: namedTransaction.nullable().optional(),
    dispute: objectId.nullable().optional(),
    amount: minor,
    deducted_amount: minor.nullable().optional(),
    status: z.string().min(1),
    settlement: objectId.nullable().optional(),
  })
  .loose();

/** A Paystack dispute (chargeback request), as the dispute API lists it. */
export const paystackDispute = z
  .object({
    id: objectId,
    refund_amount: minor.nullable().optional(),
    status: z.string().min(1),
    resolution: z.string().nullable().optional(),
    transaction: namedTransaction.nullable().optional(),
  })
  .loose();

/**
 * A charge's refunds and chargebacks from Paystack's refund and dispute lists (M4b review items 2
 * and 17). Refund states map directly. A dispute takes money only once resolved in the payer's
 * favour, which Paystack records as `merchant-accepted` with a refund amount; one the merchant
 * won (`declined`) took nothing. That reading is an assumption until Paystack confirms it (OQ-01).
 */
export function toReversals(
  refunds: readonly z.infer<typeof paystackRefund>[],
  disputes: readonly z.infer<typeof paystackDispute>[],
): ProviderReversal[] {
  const out: ProviderReversal[] = [];
  for (const r of refunds)
    out.push({
      kind: 'refund',
      id: String(r.id),
      status: r.status === 'processed' ? 'processed' : r.status === 'failed' ? 'failed' : 'pending',
      amountMinor: r.amount,
    });
  for (const d of disputes) {
    const resolved = d.status === 'resolved';
    if (resolved && d.resolution !== 'merchant-accepted') continue;
    const amount = d.refund_amount ?? 0;
    if (resolved && amount <= 0) continue;
    out.push({
      kind: 'chargeback',
      id: String(d.id),
      status: resolved ? 'processed' : 'pending',
      amountMinor: amount,
    });
  }
  return out;
}

/** As toReversals, for lists across charges: each names its charge's reference, or is left out. */
export function listedReversals(
  refunds: readonly z.infer<typeof paystackRefund>[],
  disputes: readonly z.infer<typeof paystackDispute>[],
): ListedReversal[] {
  const out: ListedReversal[] = [];
  for (const r of refunds) {
    const reference = namedReference(r.transaction);
    if (reference) out.push({ ...toReversals([r], [])[0]!, reference });
  }
  for (const d of disputes) {
    const reference = namedReference(d.transaction);
    const [reversal] = toReversals([], [d]);
    if (reference && reversal) out.push({ ...reversal, reference });
  }
  return out;
}

/** The reference a refund or dispute names, when it carries the transaction itself. */
export const namedReference = (t: z.infer<typeof namedTransaction> | null | undefined) =>
  t && typeof t === 'object' ? (t.reference ?? null) : null;
/** The transaction id a refund or dispute names. */
export const namedId = (t: z.infer<typeof namedTransaction> | null | undefined) =>
  t === null || t === undefined ? null : typeof t === 'object' ? (t.id ?? null) : t;
const initializeResponse = paystackEnvelope(
  z.object({
    reference: z.string().min(1),
    authorization_url: z.url().optional(),
    status: z.string().optional(),
    display_text: z.string().optional(),
  }),
);
export const paystackSettlement = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  status: z.enum(['success', 'pending', 'processing', 'processed', 'failed']),
  currency: z.string().min(1),
  total_amount: minor,
  total_fees: minor,
  effective_amount: minor,
  deductions: minor.nullable().optional(),
  settlement_date: z.string().min(1),
  subaccount: z
    .object({ subaccount_code: z.string().min(1) })
    .partial()
    .nullable()
    .optional(),
});

export function toSettlement(
  s: z.infer<typeof paystackSettlement>,
  references: readonly string[],
  deductedReferences: readonly { reference: string; amountMinor: number }[] = [],
): ProviderSettlement {
  // Gross less fees less net is what the provider kept back: chargebacks and refunds (OQ-41).
  const deductions =
    s.deductions ?? Math.max(0, s.total_amount - s.total_fees - s.effective_amount);
  return {
    settlementId: String(s.id),
    subaccountCode: s.subaccount?.subaccount_code ?? '',
    status: s.status === 'processing' ? 'pending' : s.status === 'processed' ? 'success' : s.status,
    currency: s.currency,
    grossMinor: s.total_amount,
    feesMinor: s.total_fees,
    deductionsMinor: deductions,
    netMinor: s.effective_amount,
    settledAt: s.settlement_date,
    references: [...references],
    deductedReferences: [...deductedReferences],
  };
}

const metadataOf = (
  value: z.infer<typeof paystackTransaction>['metadata'],
): Readonly<Record<string, string>> => {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) if (typeof v === 'string') out[key] = v;
  return out;
};

export function toCharge(data: z.infer<typeof paystackTransaction>): VerifiedCharge {
  const status: ChargeStatus =
    data.status === 'success' ||
    data.status === 'failed' ||
    data.status === 'abandoned' ||
    data.status === 'reversed'
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
    metadata: metadataOf(data.metadata),
  };
}

export function toTransaction(data: z.infer<typeof paystackTransaction>): ProviderTransaction {
  const phone = data.customer?.phone ?? undefined;
  return {
    ...toCharge(data),
    subaccountCode:
      data.subaccount && 'subaccount_code' in data.subaccount
        ? (data.subaccount.subaccount_code ?? '')
        : '',
    createdAt: data.created_at ?? data.createdAt ?? '',
    ...(data.fees === null || data.fees === undefined ? {} : { feesMinor: data.fees }),
    ...(phone && isE164(phone) ? { payerPhone: phone } : {}),
  };
}

/** Our network names as the fake provider takes them (Paystack's codes, OQ-01 fixture assumption). */
const FAKE_NETWORK_CODES: Record<MomoNetwork, string> = { mtn: 'mtn', telecel: 'vod', at: 'atl' };

/** Talks to `apps/fake-providers` over HTTP, with request shapes like Paystack's. */
export class FakeProvidersPayments implements PaymentsPort, PaymentsTestControls {
  readonly provider = 'fake-providers';
  constructor(
    private readonly baseUrl: string,
    private readonly secretKey: string,
  ) {}

  async initialiseCharge(request: ChargeRequest): Promise<ChargeInitialised> {
    const phone = request.channel === 'momo' ? request.customer.phone : undefined;
    // MoMo goes through Paystack's charge API, straight to the phone; cards through checkout.
    const response =
      phone === undefined
        ? await this.call(initializeResponse, '/transaction/initialize', {
            reference: request.reference,
            amount: request.amountMinor,
            currency: request.currency,
            email: request.customer.email,
            channels: [PAYSTACK_CHANNEL[request.channel]],
            subaccount: request.subaccountCode,
            bearer: 'subaccount',
            metadata: request.metadata,
            ...(request.callbackUrl ? { callback_url: request.callbackUrl } : {}),
          })
        : await this.call(initializeResponse, '/charge', {
            reference: request.reference,
            amount: request.amountMinor,
            currency: request.currency,
            email: request.customer.email,
            subaccount: request.subaccountCode,
            bearer: 'subaccount',
            metadata: request.metadata,
            mobile_money: {
              phone,
              ...(request.momoNetwork ? { provider: FAKE_NETWORK_CODES[request.momoNetwork] } : {}),
            },
          });
    return {
      provider: this.provider,
      providerReference: response.data.reference,
      status: 'pending',
      ...(response.data.authorization_url === undefined
        ? {}
        : { authorizationUrl: response.data.authorization_url }),
      ...(response.data.display_text === undefined
        ? {}
        : { displayText: response.data.display_text }),
    };
  }

  /** As Paystack: the same endpoints as rent, with no subaccount (M10 decision 9). */
  async initializePlatform(request: PlatformChargeRequest): Promise<ChargeInitialised> {
    checkPlatformChargeRequest(this.provider, request);
    const response = await this.call(initializeResponse, '/transaction/initialize', {
      reference: request.reference,
      amount: request.amountMinor,
      currency: request.currency,
      email: request.email,
      channels: [PAYSTACK_CHANNEL.card],
      metadata: request.metadata,
      ...(request.callbackUrl ? { callback_url: request.callbackUrl } : {}),
    });
    return this.initialised(response.data);
  }

  async chargePlatformMomo(request: PlatformMomoRequest): Promise<ChargeInitialised> {
    checkPlatformChargeRequest(this.provider, request);
    const response = await this.call(initializeResponse, '/charge', {
      reference: request.reference,
      amount: request.amountMinor,
      currency: request.currency,
      email: request.email,
      metadata: request.metadata,
      mobile_money: { phone: request.phone, provider: FAKE_NETWORK_CODES[request.network] },
    });
    return this.initialised(response.data);
  }

  private initialised(data: z.infer<typeof initializeResponse>['data']): ChargeInitialised {
    return {
      provider: this.provider,
      providerReference: data.reference,
      status: 'pending',
      ...(data.authorization_url === undefined ? {} : { authorizationUrl: data.authorization_url }),
      ...(data.display_text === undefined ? {} : { displayText: data.display_text }),
    };
  }

  async verify(reference: string): Promise<VerifiedCharge> {
    return toCharge(await this.fetchTransaction(reference));
  }

  async verifyTransaction(reference: string): Promise<ProviderTransaction> {
    return toTransaction(await this.fetchTransaction(reference));
  }

  private async fetchTransaction(reference: string) {
    const response = await this.call(
      paystackEnvelope(paystackTransaction),
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
    return response.data;
  }

  async listTransactions(range: InstantRange): Promise<ProviderTransaction[]> {
    const response = await this.call(
      paystackEnvelope(z.array(paystackTransaction)),
      `/transaction?${new URLSearchParams({ ...range })}`,
    );
    return response.data.map(toTransaction);
  }

  /** As with Paystack, a settlement's charges come from a second call. */
  async listSettlements(range: InstantRange): Promise<ProviderSettlement[]> {
    const response = await this.call(
      paystackEnvelope(
        z.array(
          paystackSettlement.extend({
            deducted: z.array(z.object({ reference: z.string(), amount: minor })).optional(),
          }),
        ),
      ),
      `/settlement?${new URLSearchParams({ ...range })}`,
    );
    const result: ProviderSettlement[] = [];
    for (const s of response.data) {
      const charges = await this.call(
        paystackEnvelope(z.array(paystackTransaction)),
        `/settlement/${encodeURIComponent(String(s.id))}/transactions`,
      );
      result.push(
        toSettlement(
          s,
          charges.data.map((t) => t.reference),
          (s.deducted ?? []).map((d) => ({ reference: d.reference, amountMinor: d.amount })),
        ),
      );
    }
    return result;
  }

  async createSubaccount(request: SubaccountRequest): Promise<{ subaccountCode: string }> {
    const response = await this.call(
      paystackEnvelope(z.object({ subaccount_code: z.string().min(1) })),
      '/subaccount',
      {
        business_name: request.businessName,
        settlement_bank: request.settlementBank,
        account_number: request.accountNumber,
        percentage_charge: 0,
      },
    );
    return { subaccountCode: response.data.subaccount_code };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const response = await this.call(
      paystackEnvelope(
        z.object({
          id: z.union([z.number().int(), z.string().min(1)]),
          status: z.enum(['pending', 'processing', 'processed', 'failed']),
        }),
      ),
      '/refund',
      { transaction: request.reference, amount: request.amountMinor },
    );
    return {
      refundReference: String(response.data.id),
      status:
        response.data.status === 'processing'
          ? 'pending'
          : response.data.status === 'processed'
            ? 'processed'
            : response.data.status,
    };
  }

  async resolveAccount(check: {
    readonly bankCode: string;
    readonly accountNumber: string;
  }): Promise<{ readonly accountName: string } | null> {
    try {
      const response = await this.call(
        paystackEnvelope(z.object({ account_name: z.string().min(1) })),
        `/bank/resolve?${new URLSearchParams({ account_number: check.accountNumber, bank_code: check.bankCode })}`,
      );
      return { accountName: response.data.account_name };
    } catch (error) {
      // The provider cannot check this account: the name is not confirmed, not refused.
      if (error instanceof ProviderError && error.status === 422) return null;
      throw error;
    }
  }

  async listBanks(): Promise<Bank[]> {
    const response = await this.call(
      paystackEnvelope(z.array(z.object({ code: z.string().min(1), name: z.string().min(1) }))),
      '/bank?country=ghana&currency=GHS',
    );
    return response.data.map((b) => ({ code: b.code, name: b.name }));
  }

  /** As Paystack: the charge's refunds and disputes, by its transaction id. */
  async reversals(reference: string): Promise<ProviderReversal[]> {
    const transaction = await this.fetchTransaction(reference);
    if (transaction.id === undefined) return [];
    const query = new URLSearchParams({ transaction: String(transaction.id) });
    const refunds = await this.call(paystackEnvelope(z.array(paystackRefund)), `/refund?${query}`);
    const disputes = await this.call(
      paystackEnvelope(z.array(paystackDispute)),
      `/dispute?${query}`,
    );
    return toReversals(refunds.data, disputes.data);
  }

  async listReversals(range: InstantRange): Promise<ListedReversal[]> {
    const query = new URLSearchParams({ ...range });
    const refunds = await this.call(paystackEnvelope(z.array(paystackRefund)), `/refund?${query}`);
    const disputes = await this.call(
      paystackEnvelope(z.array(paystackDispute)),
      `/dispute?${query}`,
    );
    return listedReversals(refunds.data, disputes.data);
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

  async chargeback(reference: string, amountMinor?: number): Promise<PaymentWebhookRequest> {
    const response = z
      .object({ webhook: z.object({ rawBody: z.string(), signature: z.string() }) })
      .safeParse(
        await requestJson<unknown>(
          this.provider,
          `${this.baseUrl}/payments/_test/chargebacks/${encodeURIComponent(reference)}`,
          { body: amountMinor === undefined ? {} : { amount: amountMinor } },
        ),
      );
    if (!response.success) throw unexpectedResponse(this.provider);
    return {
      rawBody: response.data.webhook.rawBody,
      headers: { [PAYSTACK_SIGNATURE_HEADER]: response.data.webhook.signature },
    };
  }

  async payExternal(
    payment: ExternalPayment,
  ): Promise<{ readonly reference: string; readonly webhook: PaymentWebhookRequest }> {
    const response = z
      .object({
        reference: z.string(),
        webhook: z.object({ rawBody: z.string(), signature: z.string() }),
      })
      .safeParse(
        await requestJson<unknown>(this.provider, `${this.baseUrl}/payments/_test/external`, {
          body: payment,
        }),
      );
    if (!response.success) throw unexpectedResponse(this.provider);
    return {
      reference: response.data.reference,
      webhook: {
        rawBody: response.data.webhook.rawBody,
        headers: { [PAYSTACK_SIGNATURE_HEADER]: response.data.webhook.signature },
      },
    };
  }

  async settle(): Promise<ProviderSettlement[]> {
    const response = z
      .object({
        settlements: z.array(
          paystackSettlement.extend({
            references: z.array(z.string()),
            deducted: z.array(z.object({ reference: z.string(), amount: minor })).optional(),
          }),
        ),
      })
      .safeParse(
        await requestJson<unknown>(this.provider, `${this.baseUrl}/payments/_test/settle`, {
          body: {},
        }),
      );
    if (!response.success) throw unexpectedResponse(this.provider);
    return response.data.settlements.map((s) =>
      toSettlement(
        s,
        s.references,
        (s.deducted ?? []).map((d) => ({ reference: d.reference, amountMinor: d.amount })),
      ),
    );
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
