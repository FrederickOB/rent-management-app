import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, schema, withCompany, type Database, type Tx } from '@rent/db';
import {
  chargeReference,
  checkPayAmount,
  invoiceRemainingMinor,
  payLinkAmounts,
  payPageDueMinor,
  remainingTermMinor,
  syntheticCustomerEmail,
  type MomoNetwork,
} from '@rent/domain/payments';
import { advancePaymentCapMinor } from '@rent/domain/billing';
import { parseBusinessDate } from '@rent/domain/dates';
import { DomainError } from '@rent/domain/errors';
import { maskPhone, tryNormalisePhone } from '@rent/domain/phone';
import { paymentSettingsOf, parseCompanySettings } from '@rent/domain/settings';
import { ProviderError, type AlertPort } from '@rent/integrations';
import { v7 as uuidv7 } from 'uuid';
import { BillingEngine } from '../billing/engine';
import { formatInvoiceNumber, formatReceiptNumber } from '../billing/records';
import { destinationForOwner } from '../companies/settlement-destinations';
import type { Clock } from '../core/clock';
import { customerEmailDomainOf, type AppConfig } from '../core/config';
import type { FieldCipher } from '../core/crypto/field-cipher';
import { AppError, conflict, invalid, notFound } from '../core/errors';
import type { PaymentProviders } from '../core/payment-providers';
import { consumeAlertWindow, consumeRateLimit, type RateLimit } from '../core/rate-limit';
import {
  ALERT_PORT,
  CLOCK,
  CONFIG,
  DATABASE,
  FIELD_CIPHER,
  PAYMENT_PROVIDERS,
} from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { SigningHasher } from '../esign/secrets';
import { PolicyService } from '../policy/policy.service';
import { RulesService } from '../rules/rules.service';
import { landlordContact } from './landlord-contact';
import { facts, PayLinksService } from './pay-links.service';
import { ProviderPaymentsService } from './provider-payments.service';

/** One provider-unavailable incident per company and providers tried per window (M11 drill). */
export const PROVIDER_UNAVAILABLE_ALERTS: RateLimit = { count: 1, windowMinutes: 15 };

export type PayScreen = 'pay' | 'paid' | 'settled' | 'expired' | 'revoked' | 'unavailable';
export type IntentStatus = 'initiated' | 'pending' | 'confirmed' | 'failed' | 'abandoned';

export interface PayPageView {
  readonly screen: PayScreen;
  readonly landlord: {
    readonly name: string;
    readonly phone: string | null;
    readonly email: string | null;
    readonly manualInstructions: string | null;
  };
  readonly timeZone: string;
  readonly linkExpiresAt: Date;
  readonly tenantName: string;
  readonly unitCode: string;
  readonly propertyName: string;
  readonly paymentReference: string;
  readonly invoiceNumber: string;
  readonly dueNowMinor: number;
  readonly paidUntil: string | null;
  readonly partial: { readonly monthStart: string; readonly amountMinor: number } | null;
  readonly amounts: {
    readonly prefillMinor: number;
    readonly minMinor: number;
    readonly maxMinor: number;
  };
  readonly methods: ('momo' | 'card')[];
  /**
   * The company's advance rent limit, where its policy is `warn` or `block` and a rule applies
   * (AR-05; M4b review 15): the most that keeps within it. Under `block` the amounts stop there.
   */
  readonly advance: {
    readonly policy: 'warn' | 'block';
    readonly limitMonths: number;
    readonly capMinor: number;
    readonly ruleUnverified: boolean;
  } | null;
  readonly latest: {
    readonly intentId: string;
    readonly status: IntentStatus;
    readonly amountMinor: number;
    readonly receiptNumber: string | null;
    readonly message: string | null;
  } | null;
}

export interface IntentView {
  readonly intentId: string;
  readonly status: IntentStatus;
  readonly amountMinor: number;
  readonly checkoutUrl: string | null;
  readonly message: string | null;
  readonly receiptNumber: string | null;
  /** Why a payment failed, for the page: PROVIDER_* and PROVIDERS_UNAVAILABLE codes. */
  readonly failureCode: string | null;
}

/** What the card return page shows (M4b review 14): no invoice details, no token. */
export interface ReturnView {
  readonly status: IntentStatus;
  readonly receiptNumber: string | null;
  readonly message: string | null;
  readonly failureCode: string | null;
}

/** The intent failure reasons the page is told about, as codes (M4b review 19). */
const FAILURE_CODES: Readonly<Record<string, string>> = {
  provider_refused: 'PROVIDER_REFUSED',
  providers_unavailable: 'PROVIDERS_UNAVAILABLE',
  charge_failed: 'PROVIDER_CHARGE_FAILED',
  step_unsupported: 'PROVIDER_STEP_UNSUPPORTED',
};

const STEP_UNSUPPORTED_MESSAGE =
  'This MoMo network asked for a step we cannot take yet (such as a code sent to your phone). Pay by card or from another network, or pay your landlord directly.';
const CHARGE_FAILED_MESSAGE =
  'The payment did not go through. Check the number and network, and try again.';
const CHECKING_MESSAGE =
  'We could not hear back from the payment provider. We are checking whether the payment went through; this page will update.';

export interface ClientInfo {
  readonly ip: string;
  readonly userAgent: string;
}

/** Rate limits for the pay page (CLAUDE.md section 9): per address and per link. */
export const PAY_LIMITS = {
  // A waiting payment refreshes itself: about 30 opens and 30 status checks in 15 minutes.
  opensPerIp: { count: 120, windowMinutes: 10 },
  opensPerLink: { count: 120, windowMinutes: 60 },
  startsPerLink: { count: 10, windowMinutes: 60 },
  // Generous per address: many tenants share a carrier's address (NAT).
  startsPerIp: { count: 60, windowMinutes: 60 },
  statusPerLink: { count: 240, windowMinutes: 60 },
  // The card return page: one reference per payment, refreshed while it is confirmed.
  returnsPerReference: { count: 60, windowMinutes: 60 },
} as const satisfies Record<string, RateLimit>;

const tooMany = () =>
  new AppError(429, 'rate_limited', 'Too many requests. Wait a few minutes and try again.');

const UNAVAILABLE_MESSAGE =
  'Online payment is not available just now. Try again shortly, or pay your landlord directly.';

type IntentRow = typeof schema.paymentIntent.$inferSelect;
type LinkRow = typeof schema.secureLink.$inferSelect;

/**
 * The pay page's API (BC-04; M4b plan 4.3), called server to server by apps/links with the links
 * key. A token is the only authorisation. The page shows what is due on the lease now (this
 * invoice and anything older), pre-filled, and accepts any amount from GH₵1 to the rent left in
 * the term (decision 7). A charge is created outside any transaction, with failover to a second
 * provider only if it settles directly (D1); a double tap finds the same intent.
 */
@Injectable()
export class PayPageService {
  private readonly hasher: SigningHasher;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProviders,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(BillingEngine) private readonly engine: BillingEngine,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(PayLinksService) private readonly links: PayLinksService,
    @Inject(ProviderPaymentsService) private readonly payments: ProviderPaymentsService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(RulesService) private readonly rules: RulesService,
  ) {
    this.hasher = new SigningHasher(config.BETTER_AUTH_SECRET);
  }

  async open(token: string, client: ClientInfo): Promise<PayPageView> {
    await this.limit(`pay:open:ip:${this.hasher.address(client.ip)}`, PAY_LIMITS.opensPerIp);
    const { companyId, linkId } = await this.links.resolve(token);
    await this.limit(`pay:open:link:${linkId}`, PAY_LIMITS.opensPerLink);
    return withCompany(this.database, this.context(companyId), async (tx) => {
      const link = await this.link(tx, linkId);
      const now = this.clock.now();
      await tx
        .update(schema.secureLink)
        .set({
          firstOpenedAt: link.firstOpenedAt ?? now,
          lastOpenedAt: now,
          openCount: link.openCount + 1,
        })
        .where(eq(schema.secureLink.id, link.id));
      // M11 review R3 F9: a closed link reads nothing of the tenancy.
      if (link.revokedAt || link.expiresAt.getTime() <= now.getTime())
        return this.closedPage(tx, companyId, link);
      const { advanceRuleId: _rule, ...page } = await this.page(tx, companyId, link);
      return page;
    });
  }

  /**
   * M11 review R3 F9: what a revoked or expired link answers: the closed screen and the landlord's
   * contact, and nothing about the tenancy (no name, unit, amounts, reference or payments). The
   * contract's other fields are present and empty, so apps/links needs no change.
   */
  private async closedPage(tx: Tx, companyId: string, link: LinkRow): Promise<PayPageView> {
    const [company] = await tx
      .select({ timeZone: schema.company.timeZone, settings: schema.company.settings })
      .from(schema.company)
      .where(eq(schema.company.id, companyId));
    const landlord = await landlordContact(tx, this.policy, companyId);
    return {
      screen: link.revokedAt ? 'revoked' : 'expired',
      landlord: {
        ...landlord,
        manualInstructions: paymentSettingsOf(parseCompanySettings(company?.settings))
          .manualPaymentInstructions,
      },
      timeZone: company?.timeZone ?? 'Africa/Accra',
      linkExpiresAt: link.expiresAt,
      tenantName: '',
      unitCode: '',
      propertyName: '',
      paymentReference: '',
      invoiceNumber: '',
      dueNowMinor: 0,
      paidUntil: null,
      partial: null,
      amounts: { prefillMinor: 0, minMinor: 0, maxMinor: 0 },
      methods: [],
      advance: null,
      latest: null,
    };
  }

  /** A 5-minute link to the link's invoice PDF (the first reminder carries the invoice, BC-09). */
  async invoiceDocument(token: string, client: ClientInfo): Promise<string> {
    await this.limit(`pay:open:ip:${this.hasher.address(client.ip)}`, PAY_LIMITS.opensPerIp);
    const { companyId, linkId } = await this.links.resolve(token);
    const documentId = await withCompany(this.database, this.context(companyId), async (tx) => {
      const link = await this.usable(tx, linkId);
      const [invoice] = await tx
        .select({ renderRequestId: schema.invoice.renderRequestId })
        .from(schema.invoice)
        .where(eq(schema.invoice.id, link.invoiceId!));
      if (!invoice?.renderRequestId) return null;
      return (
        (await this.documents.renderedDocument(tx, invoice.renderRequestId))?.documentId ?? null
      );
    });
    if (!documentId) throw notFound('Invoice PDF');
    const url = await this.documents.downloadUrl(companyId, documentId);
    if (!url) throw notFound('Invoice PDF');
    return url;
  }

  /**
   * Starts a payment (plan 4.3): the intent is recorded first, keyed on the link and the form's
   * submission id, so a double tap or a resubmitted form finds the same one; then the charge is
   * created with the company's providers in order, outside any transaction.
   */
  async start(
    token: string,
    client: ClientInfo,
    input: {
      readonly amountMinor: number;
      readonly method: 'momo' | 'card';
      readonly momo?: { readonly phone: string; readonly network: MomoNetwork } | null;
      readonly submissionId: string;
    },
  ): Promise<IntentView> {
    await this.limit(`pay:start:ip:${this.hasher.address(client.ip)}`, PAY_LIMITS.startsPerIp);
    const { companyId, linkId } = await this.links.resolve(token);
    await this.limit(`pay:start:link:${linkId}`, PAY_LIMITS.startsPerLink);
    let phone: string | null = null;
    if (input.method === 'momo') {
      if (!input.momo) throw invalid('momo_phone', 'Enter the MoMo number to charge');
      phone = tryNormalisePhone(input.momo.phone);
      if (!phone || !phone.startsWith('+233'))
        throw invalid('momo_phone', 'Enter a Ghana MoMo number, such as 024 123 4567');
    }
    // Sealed before the transaction opens (the cipher may create the company's key in its own).
    const id = uuidv7();
    const payerPhoneEncrypted = phone
      ? await this.cipher.encrypt(
          { companyId, table: 'payment_intent', column: 'payer_phone_encrypted', rowId: id },
          phone,
        )
      : null;
    const prepared = await withCompany(this.database, this.context(companyId), async (tx) => {
      const link = await this.usable(tx, linkId);
      const [existing] = await tx
        .select()
        .from(schema.paymentIntent)
        .where(
          and(
            eq(schema.paymentIntent.secureLinkId, link.id),
            eq(schema.paymentIntent.submissionId, input.submissionId),
          ),
        );
      if (existing) return { intent: existing, fresh: false, order: [], destination: null };
      const page = await this.page(tx, companyId, link);
      // Just paid with something still due (a part payment): the tenant may pay the rest.
      const payable = page.screen === 'pay' || (page.screen === 'paid' && page.dueNowMinor > 0);
      if (!payable)
        throw conflict(
          page.screen === 'unavailable'
            ? 'payments_unavailable'
            : page.screen === 'paid'
              ? 'link_settled'
              : `link_${page.screen}`,
          page.screen === 'settled' || page.screen === 'paid'
            ? 'Nothing is left to pay on this invoice'
            : page.screen === 'unavailable'
              ? 'Online payment is not available for this landlord now'
              : 'This link can no longer be used',
          { screen: page.screen },
        );
      checkPayAmount(input.amountMinor, page.amounts);
      // `warn` accepts an advance over the limit and flags it; `block` capped the amounts above.
      const overLimit =
        page.advance?.policy === 'warn' && input.amountMinor > page.advance.capMinor;
      const invoice = facts(
        (await tx.select().from(schema.invoice).where(eq(schema.invoice.id, link.invoiceId!)))[0]!,
      );
      const state = await this.engine.load(tx, companyId, invoice.leaseId);
      const destination = await destinationForOwner(
        tx,
        state.company,
        invoice.ownerId,
        this.engine.today(state),
      );
      if (destination.kind === 'problem') throw conflict('payments_unavailable', destination.text);
      const settings = paymentSettingsOf(parseCompanySettings(state.company.settings));
      const order = this.providers.order(
        settings.providerOrder,
        new Set(destination.destination.subaccounts.keys()),
      );
      const [intent] = await tx
        .insert(schema.paymentIntent)
        .values({
          id,
          companyId,
          propertyId: invoice.propertyId,
          tenantId: invoice.tenantId,
          leaseId: invoice.leaseId,
          invoiceId: invoice.id,
          secureLinkId: link.id,
          submissionId: input.submissionId,
          amountMinor: input.amountMinor,
          method: input.method,
          momoNetwork: input.method === 'momo' ? input.momo!.network : null,
          payerPhoneEncrypted,
          payerPhoneIndex: phone ? this.cipher.blindIndex(companyId, `phone:${phone}`) : null,
          payerPhoneMasked: phone ? maskPhone(phone) : null,
          reference: chargeReference(id),
          settlementAccountId: destination.destination.accountId,
          advanceOverLimit: overLimit,
          advanceLimitMonths: overLimit ? page.advance!.limitMonths : null,
          advanceRuleId: overLimit ? (page.advanceRuleId ?? null) : null,
        })
        .onConflictDoNothing()
        .returning();
      if (!intent) {
        // A concurrent request with the same submission won: answer with its intent.
        const [winner] = await tx
          .select()
          .from(schema.paymentIntent)
          .where(
            and(
              eq(schema.paymentIntent.secureLinkId, link.id),
              eq(schema.paymentIntent.submissionId, input.submissionId),
            ),
          );
        return { intent: winner!, fresh: false, order: [], destination: null };
      }
      const tenant = await tx
        .select({ email: schema.tenant.email, name: schema.tenant.displayName })
        .from(schema.tenant)
        .where(eq(schema.tenant.id, invoice.tenantId));
      return {
        intent,
        fresh: true,
        order,
        destination: destination.destination,
        tenant: tenant[0] ?? null,
        token,
      };
    });
    if (!prepared.fresh || !prepared.destination) return this.view(companyId, prepared.intent);
    return this.charge(companyId, prepared.intent, {
      order: prepared.order,
      subaccounts: prepared.destination.subaccounts,
      phone,
      email:
        ('tenant' in prepared && prepared.tenant?.email) ||
        syntheticCustomerEmail(prepared.intent.tenantId, customerEmailDomainOf(this.config)),
      customerName: ('tenant' in prepared && prepared.tenant?.name) || undefined,
      // The provider's checkout returns the payer to a page that carries no pay-link token, only
      // the charge's reference (M4b review 14): it shows the payment's status and receipt.
      callbackUrl: returnUrl(this.config.LINKS_ORIGIN, prepared.intent.reference),
    });
  }

  /**
   * The card return page (M4b review 14): `${LINKS_ORIGIN}/p/return?reference=…`. The reference
   * is the charge's, which the provider shows the payer anyway; it reveals only the payment's
   * status and receipt number, never the invoice, the tenant or the pay link. A pending payment
   * is checked with its provider at once.
   */
  async returned(reference: string, client: ClientInfo): Promise<ReturnView> {
    await this.limit(`pay:open:ip:${this.hasher.address(client.ip)}`, PAY_LIMITS.opensPerIp);
    if (!/^pi-[0-9a-f]{32}$/.test(reference)) throw notFound('Payment');
    await this.limit(`pay:return:${reference}`, PAY_LIMITS.returnsPerReference);
    const found = await this.payments.intentByReference(reference);
    if (!found) throw notFound('Payment');
    const ctx = this.context(found.companyId);
    const read = () =>
      withCompany(this.database, ctx, (tx) =>
        tx.select().from(schema.paymentIntent).where(eq(schema.paymentIntent.id, found.intentId)),
      );
    const [intent] = await read();
    if (!intent) throw notFound('Payment');
    if (intent.status === 'pending' && intent.provider) {
      try {
        const verified = await this.providers
          .get(intent.provider)
          .verifyTransaction(intent.reference);
        await this.payments.confirmIntent(found.companyId, intent.id, intent.provider, verified);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
      }
    }
    const [fresh] = await read();
    const view = await this.view(found.companyId, fresh!);
    return {
      status: view.status,
      receiptNumber: view.receiptNumber,
      message: view.message,
      failureCode: view.failureCode,
    };
  }

  /**
   * A payment's status (plan 4.3): a pending one is checked with its provider at once, so the
   * page shows "paid" without waiting for the webhook. Works with a plain refresh.
   */
  async status(token: string, client: ClientInfo, intentId: string): Promise<IntentView> {
    await this.limit(`pay:open:ip:${this.hasher.address(client.ip)}`, PAY_LIMITS.opensPerIp);
    const { companyId, linkId } = await this.links.resolve(token);
    await this.limit(`pay:status:link:${linkId}`, PAY_LIMITS.statusPerLink);
    const intent = await withCompany(this.database, this.context(companyId), async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.paymentIntent)
        .where(
          and(eq(schema.paymentIntent.id, intentId), eq(schema.paymentIntent.secureLinkId, linkId)),
        );
      if (!row) throw notFound('Payment');
      return row;
    });
    if (intent.status === 'pending' && intent.provider) {
      try {
        const verified = await this.providers
          .get(intent.provider)
          .verifyTransaction(intent.reference);
        await this.payments.confirmIntent(companyId, intent.id, intent.provider, verified);
      } catch (error) {
        // The provider could not answer now; the page shows the last status and asks again.
        if (!(error instanceof ProviderError)) throw error;
      }
    }
    const fresh = await withCompany(this.database, this.context(companyId), (tx) =>
      tx.select().from(schema.paymentIntent).where(eq(schema.paymentIntent.id, intentId)),
    );
    return this.view(companyId, fresh[0]!);
  }

  // Internals ---------------------------------------------------------------------------------------

  /**
   * Creates the charge with each provider in turn (plan 4.9): the next is tried only when the
   * one before is down (a retryable failure). A refusal is final. With none left, the intent fails
   * with the landlord's own instructions and an incident alert is raised.
   */
  private async charge(
    companyId: string,
    intent: IntentRow,
    options: {
      readonly order: readonly string[];
      readonly subaccounts: ReadonlyMap<string, string>;
      readonly phone: string | null;
      readonly email: string;
      readonly customerName: string | undefined;
      readonly callbackUrl: string;
    },
  ): Promise<IntentView> {
    let refusal: string | null = null;
    for (const provider of options.order) {
      const subaccountCode = options.subaccounts.get(provider);
      if (!subaccountCode) continue;
      try {
        const result = await this.providers.get(provider).initialiseCharge({
          reference: intent.reference,
          amountMinor: intent.amountMinor,
          currency: 'GHS',
          channel: intent.method as 'momo' | 'card',
          customer: { email: options.email, ...(options.phone ? { phone: options.phone } : {}) },
          subaccountCode,
          metadata: {
            companyId,
            leaseId: intent.leaseId,
            invoiceId: intent.invoiceId,
            intentId: intent.id,
          },
          ...(intent.momoNetwork ? { momoNetwork: intent.momoNetwork as MomoNetwork } : {}),
          ...(options.customerName ? { customerName: options.customerName.slice(0, 100) } : {}),
          ...(intent.method === 'card' ? { callbackUrl: options.callbackUrl } : {}),
        });
        if (result.unsupportedStep)
          // A step we cannot take yet (OQ-01): the charge cannot finish here.
          return this.record(companyId, intent.id, {
            provider,
            providerReference: result.providerReference,
            status: 'failed',
            failureReason: 'step_unsupported',
            message: STEP_UNSUPPORTED_MESSAGE,
          });
        if (result.status === 'failed' || result.status === 'abandoned')
          return this.record(companyId, intent.id, {
            provider,
            providerReference: result.providerReference,
            status: 'failed',
            failureReason: 'charge_failed',
            message: CHARGE_FAILED_MESSAGE,
          });
        return this.record(companyId, intent.id, {
          provider,
          providerReference: result.providerReference,
          status: 'pending',
          checkoutUrl: result.authorizationUrl ?? null,
          message:
            intent.method === 'momo'
              ? 'Approve the payment on your phone'
              : 'Continue to the secure card page',
        });
      } catch (error) {
        if (error instanceof ProviderError && error.status === 409) {
          // The charge exists already (a retry after a lost answer): its status decides.
          return this.status409(companyId, intent, provider);
        }
        if (error instanceof ProviderError && !error.retryable) {
          refusal = 'The payment provider refused this payment. Check the details and try again.';
          break;
        }
        if (!isClearlyDown(error)) {
          // No answer (a timeout or a dropped connection): the charge may exist. Never try another
          // provider before this one says whether it does (M4b review 12).
          const known = await this.askAfterLostAnswer(companyId, intent, provider);
          if (known) return known;
          continue;
        }
        // Down (it said so before taking the request): try the next that settles directly.
      }
    }
    const company = await withCompany(this.database, this.context(companyId), (tx) =>
      tx.select().from(schema.company).where(eq(schema.company.id, companyId)),
    );
    const instructions = paymentSettingsOf(
      parseCompanySettings(company[0]?.settings),
    ).manualPaymentInstructions;
    if (!refusal) {
      // M11 drill: one incident per company and providers tried in 15 minutes, not one per tenant.
      const tried = options.order.join(',');
      const window = await consumeAlertWindow(
        this.database,
        `alert:payments.provider_unavailable:${companyId}:${tried}`,
        PROVIDER_UNAVAILABLE_ALERTS,
        this.clock.now().getTime(),
      );
      if (window.raise)
        await this.alerts.raise({
          severity: 'critical',
          code: 'payments.provider_unavailable',
          message:
            'No payment provider could take a charge; the tenant was shown manual instructions. Further failures for this company in the next 15 minutes are not alerted again.',
          context: {
            companyId,
            intentId: intent.id,
            tried,
            suppressedInLastWindow: window.suppressedBefore,
          },
        });
    }
    return this.record(companyId, intent.id, {
      status: 'failed',
      failureReason: refusal ? 'provider_refused' : 'providers_unavailable',
      message:
        refusal ?? (instructions ? `${UNAVAILABLE_MESSAGE} ${instructions}` : UNAVAILABLE_MESSAGE),
    });
  }

  /**
   * After a charge request got no answer: asks the provider for the charge. It exists: follow it
   * (no failover). It does not (404): another provider may be tried, so null. The provider cannot
   * say either: the intent stays with it, pending a check by verify-pending; no failover.
   */
  private async askAfterLostAnswer(
    companyId: string,
    intent: IntentRow,
    provider: string,
  ): Promise<IntentView | null> {
    try {
      const verified = await this.providers.get(provider).verifyTransaction(intent.reference);
      await this.record(companyId, intent.id, {
        provider,
        status: 'pending',
        message: intent.method === 'momo' ? 'Approve the payment on your phone' : CHECKING_MESSAGE,
      });
      await this.payments.confirmIntent(companyId, intent.id, provider, verified);
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return null;
      if (!(error instanceof ProviderError)) throw error;
      await this.record(companyId, intent.id, { provider, message: CHECKING_MESSAGE });
      await this.alerts.raise({
        severity: 'warning',
        code: 'payments.charge_unknown',
        message:
          'A charge request got no answer and the provider could not say whether it exists; verify-pending will check it',
        context: { companyId, intentId: intent.id, provider },
      });
    }
    const [row] = await withCompany(this.database, this.context(companyId), (tx) =>
      tx.select().from(schema.paymentIntent).where(eq(schema.paymentIntent.id, intent.id)),
    );
    return this.view(companyId, row!);
  }

  private async status409(
    companyId: string,
    intent: IntentRow,
    provider: string,
  ): Promise<IntentView> {
    await this.record(companyId, intent.id, { provider, status: 'pending' });
    const verified = await this.providers.get(provider).verifyTransaction(intent.reference);
    await this.payments.confirmIntent(companyId, intent.id, provider, verified);
    const [row] = await withCompany(this.database, this.context(companyId), (tx) =>
      tx.select().from(schema.paymentIntent).where(eq(schema.paymentIntent.id, intent.id)),
    );
    return this.view(companyId, row!);
  }

  private async record(
    companyId: string,
    intentId: string,
    values: Partial<typeof schema.paymentIntent.$inferInsert>,
  ): Promise<IntentView> {
    const row = await withCompany(this.database, this.context(companyId), async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.paymentIntent)
        .where(eq(schema.paymentIntent.id, intentId))
        .for('update');
      // A webhook may have confirmed it already; a confirmed intent is final.
      if (current!.status === 'confirmed') return current!;
      const [updated] = await tx
        .update(schema.paymentIntent)
        .set({
          ...values,
          ...(current!.provider && values.provider ? { provider: current!.provider } : {}),
          updatedAt: this.clock.now(),
        })
        .where(eq(schema.paymentIntent.id, intentId))
        .returning();
      return updated!;
    });
    return this.view(companyId, row);
  }

  private async view(companyId: string, intent: IntentRow): Promise<IntentView> {
    const receiptNumber = intent.paymentId
      ? await withCompany(this.database, this.context(companyId), async (tx) => {
          const [receipt] = await tx
            .select({ number: schema.receipt.number })
            .from(schema.receipt)
            .where(
              and(
                eq(schema.receipt.paymentId, intent.paymentId!),
                eq(schema.receipt.kind, 'receipt'),
              ),
            );
          return receipt ? formatReceiptNumber(receipt.number) : null;
        })
      : null;
    return {
      intentId: intent.id,
      status: intent.status as IntentStatus,
      amountMinor: intent.amountMinor,
      checkoutUrl: intent.status === 'pending' ? intent.checkoutUrl : null,
      message: intent.message,
      receiptNumber,
      failureCode:
        intent.status === 'failed' && intent.failureReason
          ? (FAILURE_CODES[intent.failureReason] ?? null)
          : null,
    };
  }

  /** What the page shows for a link, in the link's company transaction. */
  private async page(
    tx: Tx,
    companyId: string,
    link: LinkRow,
  ): Promise<PayPageView & { readonly advanceRuleId: string | null }> {
    if (!link.invoiceId || !link.tenantId) throw notFound('Link');
    const [invoiceRow] = await tx
      .select()
      .from(schema.invoice)
      .where(eq(schema.invoice.id, link.invoiceId));
    if (!invoiceRow) throw notFound('Link');
    const invoice = facts(invoiceRow);
    const state = await this.engine.load(tx, companyId, invoice.leaseId);
    const today = this.engine.today(state);
    const walk = this.engine.walk(state);
    const company = state.company;
    const settings = paymentSettingsOf(parseCompanySettings(company.settings));
    const due = payPageDueMinor({
      lines: state.lines,
      allocations: state.allocations,
      walk,
      today,
      invoiceDueDate: invoice.dueDate,
    });
    const limits = payLinkAmounts({
      dueNowMinor: due,
      remainingTermMinor: remainingTermMinor({
        lines: state.lines,
        allocations: state.allocations,
        walk,
      }),
    });
    const advance = await this.advanceLimit(state, walk, today);
    // `block` stops the amounts at the limit; `warn` shows it and flags a payment past it.
    const amounts =
      advance?.policy === 'block'
        ? {
            ...limits,
            maxMinor: Math.max(limits.minMinor, Math.min(limits.maxMinor, advance.capMinor)),
            prefillMinor: Math.min(
              limits.prefillMinor,
              Math.max(limits.minMinor, Math.min(limits.maxMinor, advance.capMinor)),
            ),
          }
        : limits;
    const invoiceLeft = invoiceRemainingMinor({
      invoiceLines: state.lines.filter((l) => l.invoiceId === invoice.id),
      allocations: state.allocations,
      walk,
    });
    const [latest] = await tx
      .select()
      .from(schema.paymentIntent)
      .where(eq(schema.paymentIntent.secureLinkId, link.id))
      .orderBy(desc(schema.paymentIntent.createdAt))
      .limit(1);
    const now = this.clock.now();
    const destination = await destinationForOwner(tx, company, invoice.ownerId, today);
    const methods: ('momo' | 'card')[] = ['momo', 'card'];
    const usableProviders =
      destination.kind === 'ok'
        ? this.providers.order(
            settings.providerOrder,
            new Set(destination.destination.subaccounts.keys()),
          )
        : [];
    // `paid` follows a payment: while nothing is left on the invoice, or for an hour after it.
    const justPaid =
      latest?.status === 'confirmed' &&
      (invoiceLeft <= 0 ||
        now.getTime() - (latest.confirmedAt ?? latest.updatedAt).getTime() < 3_600_000);
    const screen: PayScreen = link.revokedAt
      ? 'revoked'
      : link.expiresAt.getTime() <= now.getTime()
        ? 'expired'
        : justPaid
          ? 'paid'
          : invoiceLeft <= 0
            ? 'settled'
            : usableProviders.length === 0
              ? 'unavailable'
              : 'pay';
    const landlord = await landlordContact(tx, this.policy, companyId);
    return {
      screen,
      landlord: { ...landlord, manualInstructions: settings.manualPaymentInstructions },
      timeZone: company.timeZone,
      linkExpiresAt: link.expiresAt,
      tenantName: state.lease.tenantName,
      unitCode: state.lease.unitCode,
      propertyName: state.lease.propertyName,
      paymentReference: (await this.engine.ensureReference(tx, state.lease)) ?? '',
      invoiceNumber: formatInvoiceNumber(invoice.number),
      dueNowMinor: due,
      paidUntil: walk.paidUntil,
      partial: walk.partial,
      amounts,
      methods,
      advance: advance
        ? {
            policy: advance.policy,
            limitMonths: advance.limitMonths,
            capMinor: advance.capMinor,
            ruleUnverified: advance.ruleUnverified,
          }
        : null,
      advanceRuleId: advance?.ruleId ?? null,
      latest: latest ? await this.latest(tx, latest) : null,
    };
  }

  /**
   * The advance rent limit for this lease under the company's policy (AR-05; M4b review 15):
   * the rule for the term's length (Act 220 s.25(5), unverified) as of today, and the most a
   * payment may be to stay within it. Null under `off`, or where no rule applies (OQ-51).
   */
  private async advanceLimit(
    state: Awaited<ReturnType<BillingEngine['load']>>,
    walk: ReturnType<BillingEngine['walk']>,
    today: string,
  ): Promise<{
    policy: 'warn' | 'block';
    limitMonths: number;
    capMinor: number;
    ruleUnverified: boolean;
    ruleId: string;
  } | null> {
    const policy = parseCompanySettings(state.company.settings).advanceRentPolicy;
    if (policy === 'off') return null;
    const terms = state.lease.terms;
    const key =
      terms.periodCount <= 1
        ? 'advance_rent.max_months.monthly_or_shorter'
        : terms.periodCount > 6
          ? 'advance_rent.max_months.over_six_months'
          : null;
    if (!key) return null;
    let rule: Awaited<ReturnType<RulesService['resolve']>>;
    try {
      rule = await this.rules.resolve(state.company.countryCode, key, parseBusinessDate(today));
    } catch (error) {
      if (error instanceof DomainError && error.code === 'rule.missing') return null;
      throw error;
    }
    const months = (rule.value as { months?: unknown } | null)?.months;
    if (typeof months !== 'number' || !Number.isSafeInteger(months) || months < 0) return null;
    // Review 9: the same function as cash and transfers (`BillingEngine.checkAdvanceCap`), from
    // the walk: what is due, then months of rent up to the limit with their VAT and levies.
    const capMinor = advancePaymentCapMinor({
      lines: state.lines,
      allocations: state.allocations,
      walk,
      valueDate: today,
      limitMonths: months,
    });
    return {
      policy,
      limitMonths: months,
      capMinor,
      ruleUnverified: rule.verificationStatus !== 'verified',
      ruleId: rule.ruleId,
    };
  }

  private async latest(tx: Tx, intent: IntentRow): Promise<NonNullable<PayPageView['latest']>> {
    let receiptNumber: string | null = null;
    if (intent.paymentId) {
      const [receipt] = await tx
        .select({ number: schema.receipt.number })
        .from(schema.receipt)
        .where(
          and(eq(schema.receipt.paymentId, intent.paymentId), eq(schema.receipt.kind, 'receipt')),
        );
      receiptNumber = receipt ? formatReceiptNumber(receipt.number) : null;
    }
    return {
      intentId: intent.id,
      status: intent.status as IntentStatus,
      amountMinor: intent.amountMinor,
      receiptNumber,
      message: intent.message,
    };
  }

  private async link(tx: Tx, linkId: string): Promise<LinkRow> {
    const [link] = await tx
      .select()
      .from(schema.secureLink)
      .where(eq(schema.secureLink.id, linkId));
    if (!link || link.purpose !== 'pay') throw notFound('Link');
    return link;
  }

  /** A pay link that can still be used: not revoked and not expired. */
  private async usable(tx: Tx, linkId: string): Promise<LinkRow> {
    const link = await this.link(tx, linkId);
    if (link.revokedAt)
      throw conflict('link_revoked_not_usable', 'This link has been withdrawn', {
        screen: 'revoked',
      });
    if (link.expiresAt.getTime() <= this.clock.now().getTime())
      throw conflict('link_expired_not_usable', 'This link has expired', { screen: 'expired' });
    return link;
  }

  private context(companyId: string) {
    return { companyId, actorKind: 'link' as const };
  }

  private async limit(key: string, limit: RateLimit): Promise<void> {
    if (!(await consumeRateLimit(this.database, key, limit, this.clock.now().getTime())))
      throw tooMany();
  }
}

/** The card return page's address: the charge's reference only, never a pay-link token. */
export function returnUrl(linksOrigin: string, reference: string): string {
  return `${linksOrigin}/p/return?reference=${encodeURIComponent(reference)}`;
}

/**
 * Whether a failed charge request clearly never reached the provider's books (M4b review 12): it
 * answered that it is unavailable (503) or busy (429). Anything else retryable (a timeout, a
 * dropped connection, another 5xx) may have created the charge, so the provider is asked first.
 */
function isClearlyDown(error: unknown): boolean {
  return error instanceof ProviderError && (error.status === 503 || error.status === 429);
}
