import { z } from 'zod';
import { ProviderError, requestJson } from '../http';
import { unexpectedResponse } from '../validation';
import {
  checkChargeRequest,
  parsePaystackWebhook,
  paystackEnvelope,
  paystackSettlement,
  paystackTransaction,
  toCharge,
  toSettlement,
  toTransaction,
  verifyPaystackSignature,
  type Bank,
  type ChargeInitialised,
  type ChargeRequest,
  type InstantRange,
  type MomoNetwork,
  type PaymentsPort,
  type PaymentWebhookEvent,
  type ProviderSettlement,
  type ProviderTransaction,
  type RefundRequest,
  type RefundResult,
  type SubaccountRequest,
  type VerifiedCharge,
  type WebhookHeaders,
} from './payments';

/**
 * Paystack (BC-02; M4b plan decisions 1 to 4; D1, D2). Every charge names the landlord's or
 * agency's subaccount, which bears the fee (OQ-07), so rent settles straight to their bank account
 * and never into a platform balance. Cards go through Paystack's checkout; MoMo through its charge
 * API, which sends the approval prompt to the phone.
 *
 * Built from Paystack's API documentation and tested on recorded responses in `fixtures/paystack`
 * (decision 4). Those fixtures follow the documented shapes; they were not recorded from a live
 * account, because no test account exists yet. The optional sandbox smoke test checks them when
 * PAYSTACK_TEST_SECRET_KEY is set.
 *
 * Assumptions to confirm with Paystack in writing (OQ-01; listed in docs/open-questions.md):
 * - Ghana's MoMo provider codes `mtn`, `vod` (Telecel, formerly Vodafone) and `atl` (AT, formerly
 *   AirtelTigo) come from third-party sources, not from Paystack's own documentation.
 * - The charge API accepts `subaccount` and `bearer` as transaction initialisation does.
 * - A settlement object names its subaccount, and its `deductions` field carries chargebacks and
 *   refunds taken out of the payout.
 * - Account-name checks for Ghanaian banks may be unavailable; a 422 is read as "cannot check".
 */
export const PAYSTACK_API = 'https://api.paystack.co';

/** Paystack's mobile-money provider codes for Ghana (fixture assumption, above). */
export const PAYSTACK_MOMO_CODES: Record<MomoNetwork, string> = {
  mtn: 'mtn',
  telecel: 'vod',
  at: 'atl',
};

export interface PaystackOptions {
  readonly secretKey: string;
  /**
   * Live rent collection (decision 3; OQ-03): a live key (`sk_live_…`) is refused unless the
   * deployment says LIVE_RENT_COLLECTION=enabled.
   */
  readonly liveCollection: 'enabled' | 'disabled';
  readonly baseUrl?: string;
  /** The transport, replaced by recorded responses in tests. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class LiveKeyRefused extends Error {
  override readonly name = 'LiveKeyRefused';
  constructor() {
    super(
      'A live Paystack key is set but LIVE_RENT_COLLECTION is not enabled: live rent collection waits for counsel (OQ-03)',
    );
  }
}

/** Whether a key is a live one: the API refuses to start with it unless collection is enabled. */
export const isLivePaystackKey = (key: string): boolean => key.startsWith('sk_live_');

const PAGE_SIZE = 100;
const pageMeta = z
  .object({ page: z.number().int(), pageCount: z.number().int() })
  .partial()
  .optional();

export class PaystackPayments implements PaymentsPort {
  readonly provider = 'paystack';
  private readonly baseUrl: string;

  constructor(private readonly options: PaystackOptions) {
    if (options.secretKey.length === 0) throw new Error('The Paystack secret key is empty');
    if (isLivePaystackKey(options.secretKey) && options.liveCollection !== 'enabled')
      throw new LiveKeyRefused();
    this.baseUrl = (options.baseUrl ?? PAYSTACK_API).replace(/\/$/, '');
  }

  /** Whether this adapter holds a live key (the startup log names it, never the key). */
  get live(): boolean {
    return isLivePaystackKey(this.options.secretKey);
  }

  async initialiseCharge(request: ChargeRequest): Promise<ChargeInitialised> {
    checkChargeRequest(this.provider, request);
    const metadata: Record<string, unknown> = {
      ...request.metadata,
      ...(request.customerName
        ? {
            custom_fields: [
              {
                display_name: 'Tenant',
                variable_name: 'tenant_name',
                value: request.customerName,
              },
            ],
          }
        : {}),
    };
    const common = {
      email: request.customer.email,
      amount: request.amountMinor,
      currency: request.currency,
      reference: request.reference,
      subaccount: request.subaccountCode,
      bearer: 'subaccount',
      metadata,
    };
    const phone = request.channel === 'momo' ? request.customer.phone : undefined;
    if (phone !== undefined) {
      if (!request.momoNetwork)
        throw new ProviderError(this.provider, 'MoMo network required', false, 400);
      const response = await this.call(
        paystackEnvelope(
          z.object({
            reference: z.string().min(1),
            status: z.string().min(1),
            display_text: z.string().optional(),
          }),
        ),
        'POST',
        '/charge',
        {
          ...common,
          mobile_money: { phone, provider: PAYSTACK_MOMO_CODES[request.momoNetwork] },
        },
      );
      const status = response.data.status;
      return {
        provider: this.provider,
        providerReference: response.data.reference,
        status:
          status === 'success' || status === 'failed' || status === 'abandoned'
            ? status
            : 'pending',
        ...(response.data.display_text ? { displayText: response.data.display_text } : {}),
      };
    }
    const response = await this.call(
      paystackEnvelope(
        z.object({
          authorization_url: z.url(),
          access_code: z.string().min(1),
          reference: z.string().min(1),
        }),
      ),
      'POST',
      '/transaction/initialize',
      {
        ...common,
        channels: [request.channel === 'card' ? 'card' : 'bank'],
        ...(request.callbackUrl ? { callback_url: request.callbackUrl } : {}),
      },
    );
    return {
      provider: this.provider,
      providerReference: response.data.reference,
      authorizationUrl: response.data.authorization_url,
      status: 'pending',
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
      'GET',
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
    return response.data;
  }

  async listTransactions(range: InstantRange): Promise<ProviderTransaction[]> {
    const out: ProviderTransaction[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.call(
        paystackEnvelope(z.array(paystackTransaction)).extend({ meta: pageMeta }),
        'GET',
        `/transaction?${new URLSearchParams({ from: range.from, to: range.to, perPage: String(PAGE_SIZE), page: String(page) })}`,
      );
      out.push(...response.data.map(toTransaction));
      const pages = response.meta?.pageCount ?? 1;
      if (page >= pages || response.data.length === 0) return out;
    }
  }

  async listSettlements(range: InstantRange): Promise<ProviderSettlement[]> {
    const out: ProviderSettlement[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.call(
        paystackEnvelope(z.array(paystackSettlement)).extend({ meta: pageMeta }),
        'GET',
        `/settlement?${new URLSearchParams({ from: range.from, to: range.to, perPage: String(PAGE_SIZE), page: String(page) })}`,
      );
      for (const s of response.data) {
        const charges = await this.call(
          paystackEnvelope(z.array(paystackTransaction)),
          'GET',
          `/settlement/${encodeURIComponent(String(s.id))}/transactions`,
        );
        out.push(
          toSettlement(
            s,
            charges.data.map((t) => t.reference),
          ),
        );
      }
      const pages = response.meta?.pageCount ?? 1;
      if (page >= pages || response.data.length === 0) return out;
    }
  }

  async createSubaccount(request: SubaccountRequest): Promise<{ subaccountCode: string }> {
    const response = await this.call(
      paystackEnvelope(z.object({ subaccount_code: z.string().min(1) })),
      'POST',
      '/subaccount',
      {
        business_name: request.businessName,
        settlement_bank: request.settlementBank,
        account_number: request.accountNumber,
        // D1: the platform takes no share of rent; the whole charge settles to the subaccount.
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
          status: z.string().min(1),
        }),
      ),
      'POST',
      '/refund',
      { transaction: request.reference, amount: request.amountMinor },
    );
    const status = response.data.status;
    return {
      refundReference: String(response.data.id),
      status: status === 'processed' ? 'processed' : status === 'failed' ? 'failed' : 'pending',
    };
  }

  async resolveAccount(check: {
    readonly bankCode: string;
    readonly accountNumber: string;
  }): Promise<{ readonly accountName: string } | null> {
    try {
      const response = await this.call(
        paystackEnvelope(z.object({ account_name: z.string().min(1) })),
        'GET',
        `/bank/resolve?${new URLSearchParams({ account_number: check.accountNumber, bank_code: check.bankCode })}`,
      );
      return { accountName: response.data.account_name };
    } catch (error) {
      if (error instanceof ProviderError && error.status === 422) return null;
      throw error;
    }
  }

  async listBanks(): Promise<Bank[]> {
    const response = await this.call(
      paystackEnvelope(
        z.array(z.object({ code: z.string().min(1), name: z.string().min(1) }).loose()),
      ),
      'GET',
      '/bank?country=ghana&currency=GHS',
    );
    return response.data.map((b) => ({ code: b.code, name: b.name }));
  }

  verifyWebhookSignature(rawBody: Buffer | string, headers: WebhookHeaders): boolean {
    return verifyPaystackSignature(this.options.secretKey, rawBody, headers);
  }

  parseWebhook(rawBody: Buffer | string): PaymentWebhookEvent | null {
    return parsePaystackWebhook(rawBody);
  }

  private async call<T extends z.ZodType>(
    schema: T,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<z.infer<T>> {
    const response = await requestJson<unknown>(this.provider, `${this.baseUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { body }),
      headers: { authorization: `Bearer ${this.options.secretKey}` },
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
    });
    const parsed = schema.safeParse(response);
    if (!parsed.success) throw unexpectedResponse(this.provider);
    return parsed.data;
  }
}
