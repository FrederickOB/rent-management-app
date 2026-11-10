import { z } from 'zod';
import { ProviderError, requestJson } from '../http';
import { unexpectedResponse } from '../validation';
import {
  checkChargeRequest,
  checkPlatformChargeRequest,
  listedReversals,
  namedId,
  namedReference,
  parsePaystackWebhook,
  paystackDispute,
  paystackEnvelope,
  paystackRefund,
  paystackSettlement,
  paystackTransaction,
  toCharge,
  toReversals,
  toSettlement,
  toTransaction,
  verifyPaystackSignature,
  type Bank,
  type ChargeInitialised,
  type ChargeRequest,
  type InstantRange,
  type ListedReversal,
  type MomoNetwork,
  type PaymentsPort,
  type PaymentWebhookEvent,
  type PlatformChargeRequest,
  type PlatformMomoRequest,
  type ProviderReversal,
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
 * - What a settlement deducted (M4b review 8): Paystack documents `deductions` on a settlement and
 *   `settlement`, `deducted_amount` and `dispute` on each refund, but not how chargebacks appear.
 *   We read a settlement's deductions from the refunds that name it, and assume a dispute the payer
 *   won is deducted as a refund with `dispute` set. Anything the refunds do not explain is raised
 *   by reconciliation as a difference for a person.
 * - Refunds and disputes are listed for a charge by its transaction id (`transaction` filter).
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
/** How far back a refund deducted from a settlement may have been made. */
const REFUND_LOOKBACK_MS = 90 * 86_400_000;
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
      // `pay_offline`: the approval prompt went to the phone, which is the flow we support. Any
      // other next step (a code, a PIN, a birthday, a page to open) is not built yet (OQ-01).
      const waiting = ['pay_offline', 'pending', 'ongoing', 'processing'].includes(status);
      const final = status === 'success' || status === 'failed' || status === 'abandoned';
      return {
        provider: this.provider,
        providerReference: response.data.reference,
        status: final ? (status as 'success' | 'failed' | 'abandoned') : 'pending',
        ...(response.data.display_text ? { displayText: response.data.display_text } : {}),
        ...(!final && !waiting ? { unsupportedStep: status.slice(0, 40) } : {}),
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

  /**
   * M10 decision 9: the platform's own revenue (the subscription), on checkout, with no subaccount
   * and no bearer, so it settles to the platform's own Paystack balance. D1 governs rent, which
   * never comes this way; the reference starts `SUB-`.
   */
  async initializePlatform(request: PlatformChargeRequest): Promise<ChargeInitialised> {
    checkPlatformChargeRequest(this.provider, request);
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
        email: request.email,
        amount: request.amountMinor,
        currency: request.currency,
        reference: request.reference,
        metadata: { ...request.metadata },
        channels: ['card'],
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

  /** As initializePlatform, by MoMo through the charge API: the prompt goes to the phone. */
  async chargePlatformMomo(request: PlatformMomoRequest): Promise<ChargeInitialised> {
    checkPlatformChargeRequest(this.provider, request);
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
        email: request.email,
        amount: request.amountMinor,
        currency: request.currency,
        reference: request.reference,
        metadata: { ...request.metadata },
        mobile_money: { phone: request.phone, provider: PAYSTACK_MOMO_CODES[request.network] },
      },
    );
    return momoInitialised(this.provider, response.data);
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
    let refunds: Awaited<ReturnType<PaystackPayments['refundsSince']>> | null = null;
    for (let page = 1; ; page += 1) {
      const response = await this.call(
        paystackEnvelope(z.array(paystackSettlement)).extend({ meta: pageMeta }),
        'GET',
        `/settlement?${new URLSearchParams({ from: range.from, to: range.to, perPage: String(PAGE_SIZE), page: String(page) })}`,
      );
      for (const s of response.data) {
        const references = await this.settlementReferences(String(s.id));
        // The refunds (and lost disputes) this payout deducted, by the settlement they name.
        let deducted: { reference: string; amountMinor: number }[] = [];
        if ((s.deductions ?? 0) > 0) {
          refunds ??= await this.refundsSince(range);
          deducted = await this.deductedFrom(String(s.id), refunds);
        }
        out.push(toSettlement(s, references, deducted));
      }
      const pages = response.meta?.pageCount ?? 1;
      if (page >= pages || response.data.length === 0) return out;
    }
  }

  /** Every charge a settlement paid out, over every page. */
  private async settlementReferences(settlementId: string): Promise<string[]> {
    const references: string[] = [];
    for (let page = 1; ; page += 1) {
      const charges = await this.call(
        paystackEnvelope(z.array(paystackTransaction)).extend({ meta: pageMeta }),
        'GET',
        `/settlement/${encodeURIComponent(settlementId)}/transactions?${new URLSearchParams({ perPage: String(PAGE_SIZE), page: String(page) })}`,
      );
      references.push(...charges.data.map((t) => t.reference));
      const pages = charges.meta?.pageCount ?? 1;
      if (page >= pages || charges.data.length === 0) return references;
    }
  }

  /** Refunds made from 90 days before a range to its end, every page. */
  private async refundsSince(range: InstantRange): Promise<z.infer<typeof paystackRefund>[]> {
    const from = new Date(Date.parse(range.from) - REFUND_LOOKBACK_MS).toISOString();
    return this.pages(paystackRefund, '/refund', { from, to: range.to });
  }

  private async deductedFrom(
    settlementId: string,
    refunds: readonly z.infer<typeof paystackRefund>[],
  ): Promise<{ reference: string; amountMinor: number }[]> {
    const out: { reference: string; amountMinor: number }[] = [];
    for (const r of refunds) {
      if (r.settlement === null || r.settlement === undefined) continue;
      if (String(r.settlement) !== settlementId) continue;
      const amountMinor = r.deducted_amount ?? 0;
      if (amountMinor <= 0) continue;
      let reference = namedReference(r.transaction);
      const id = namedId(r.transaction);
      if (!reference && id !== null) {
        const tx = await this.call(
          paystackEnvelope(paystackTransaction),
          'GET',
          `/transaction/${encodeURIComponent(String(id))}`,
        );
        reference = tx.data.reference;
      }
      if (reference) out.push({ reference, amountMinor });
    }
    return out;
  }

  /**
   * Refunds and disputes made in a range, every page (M4b review item 16). A refund or dispute
   * that names its charge only by id is looked up for the charge's reference.
   */
  async listReversals(range: InstantRange): Promise<ListedReversal[]> {
    const refunds = await this.pages(paystackRefund, '/refund', range);
    const disputes = await this.pages(paystackDispute, '/dispute', range);
    for (const item of [...refunds, ...disputes]) {
      if (namedReference(item.transaction)) continue;
      const id = namedId(item.transaction);
      if (id === null) continue;
      const tx = await this.call(
        paystackEnvelope(paystackTransaction),
        'GET',
        `/transaction/${encodeURIComponent(String(id))}`,
      );
      item.transaction = { id, reference: tx.data.reference };
    }
    return listedReversals(refunds, disputes);
  }

  private async pages<T extends z.ZodType>(
    item: T,
    path: string,
    range: InstantRange,
  ): Promise<z.infer<T>[]> {
    const out: z.infer<T>[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.call(
        paystackEnvelope(z.array(item)).extend({ meta: pageMeta }),
        'GET',
        `${path}?${new URLSearchParams({ from: range.from, to: range.to, perPage: String(PAGE_SIZE), page: String(page) })}`,
      );
      out.push(...(response.data as z.infer<T>[]));
      const pages = response.meta?.pageCount ?? 1;
      if (page >= pages || response.data.length === 0) return out;
    }
  }

  async reversals(reference: string): Promise<ProviderReversal[]> {
    const transaction = await this.fetchTransaction(reference);
    if (transaction.id === undefined) return [];
    const query = new URLSearchParams({
      transaction: String(transaction.id),
      perPage: String(PAGE_SIZE),
    });
    const refunds = await this.call(
      paystackEnvelope(z.array(paystackRefund)),
      'GET',
      `/refund?${query}`,
    );
    const disputes = await this.call(
      paystackEnvelope(z.array(paystackDispute)),
      'GET',
      `/dispute?${query}`,
    );
    return toReversals(refunds.data, disputes.data);
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

/**
 * A MoMo charge's first answer (as for rent): `pay_offline` and the like wait for the payer's
 * approval on the phone; any other next step (a code, a PIN, a page) is not built yet (OQ-01).
 */
function momoInitialised(
  provider: string,
  data: { readonly reference: string; readonly status: string; readonly display_text?: string },
): ChargeInitialised {
  const status = data.status;
  const waiting = ['pay_offline', 'pending', 'ongoing', 'processing'].includes(status);
  const final = status === 'success' || status === 'failed' || status === 'abandoned';
  return {
    provider,
    providerReference: data.reference,
    status: final ? (status as 'success' | 'failed' | 'abandoned') : 'pending',
    ...(data.display_text ? { displayText: data.display_text } : {}),
    ...(!final && !waiting ? { unsupportedStep: status.slice(0, 40) } : {}),
  };
}
