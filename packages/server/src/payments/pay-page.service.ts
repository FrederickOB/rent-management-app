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
import { consumeRateLimit, type RateLimit } from '../core/rate-limit';
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
import { landlordContact } from './landlord-contact';
import { facts, PayLinksService } from './pay-links.service';
import { ProviderPaymentsService } from './provider-payments.service';

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
}

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
      return this.page(tx, companyId, link);
    });
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
      // The page reads Paystack's `trxref` or `reference` on return as "just paid, verifying".
      callbackUrl: this.links.urlFor(token),
    });
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
        // Down or timed out: try the next provider that settles directly.
      }
    }
    const company = await withCompany(this.database, this.context(companyId), (tx) =>
      tx.select().from(schema.company).where(eq(schema.company.id, companyId)),
    );
    const instructions = paymentSettingsOf(
      parseCompanySettings(company[0]?.settings),
    ).manualPaymentInstructions;
    if (!refusal)
      await this.alerts.raise({
        severity: 'critical',
        code: 'payments.provider_unavailable',
        message:
          'No payment provider could take a charge; the tenant was shown manual instructions',
        context: { companyId, intentId: intent.id, tried: options.order.join(',') },
      });
    return this.record(companyId, intent.id, {
      status: 'failed',
      failureReason: refusal ? 'provider_refused' : 'providers_unavailable',
      message:
        refusal ?? (instructions ? `${UNAVAILABLE_MESSAGE} ${instructions}` : UNAVAILABLE_MESSAGE),
    });
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
    };
  }

  /** What the page shows for a link, in the link's company transaction. */
  private async page(tx: Tx, companyId: string, link: LinkRow): Promise<PayPageView> {
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
    const amounts = payLinkAmounts({
      dueNowMinor: due,
      remainingTermMinor: remainingTermMinor({
        lines: state.lines,
        allocations: state.allocations,
        walk,
      }),
    });
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
      latest: latest ? await this.latest(tx, latest) : null,
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
