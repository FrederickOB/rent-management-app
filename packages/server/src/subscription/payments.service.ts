import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { subscriptionReceiptV1, type SubscriptionReceiptDocumentData } from '@rent/documents';
import { businessDateOf, instantFrom, toIsoDate } from '@rent/domain/dates';
import {
  allocateSubscriptionPayment,
  settlementLines,
  subscriptionPaymentLines,
  subscriptionPaymentReversalLines,
  subscriptionPostingKeys,
  type SubscriptionAllocation,
} from '@rent/domain/ledger';
import { format, money } from '@rent/domain/money';
import { compareVerified, reconcileTransactions } from '@rent/domain/payments';
import { tryNormalisePhone } from '@rent/domain/phone';
import type { Actor } from '@rent/domain/policy';
import type { SubscriptionTier } from '@rent/domain/settings';
import {
  annualPrice,
  annualTerm,
  billableUnits,
  compareMonths,
  countsByBand,
  isBillingBand,
  monthBounds,
  monthOf,
  monthlyBill,
  previousMonth,
  type BandCounts,
  type SnapshotUnitInput,
  type SubscriptionPaymentChannel,
  type SubscriptionPaymentPurpose,
  type SubscriptionPaymentStatus,
} from '@rent/domain/subscription';
import {
  ProviderError,
  type AlertPort,
  type ChargeInitialised,
  type ListedReversal,
  type MomoNetwork,
  type ProviderSettlement,
  type ProviderTransaction,
  type VerifiedCharge,
} from '@rent/integrations';
import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';
import { companyRecord, staffActor } from '../companies/companies.service';
import type { Clock } from '../core/clock';
import type { AppConfig } from '../core/config';
import { customerEmailDomainOf } from '../core/config';
import { AppError, conflict, invalid, notFound } from '../core/errors';
import type { IdempotencyClaim } from '../core/idempotency';
import type { AppLogger } from '../core/logging/logger';
import { queueMessage } from '../core/messages';
import type { PaymentProviders } from '../core/payment-providers';
import { ALERT_PORT, CLOCK, CONFIG, DATABASE, LOGGER, PAYMENT_PROVIDERS } from '../core/tokens';
import { DocumentsService } from '../documents/documents.service';
import { personContact } from '../identity/person-directory';
import { PostingService } from '../ledger/posting.service';
import type { PlatformCharges } from '../payments/platform-charges';
import { membersWhoCan } from '../policy/members';
import { PolicyService, staffContext } from '../policy/policy.service';
import { RulesService } from '../rules/rules.service';
import { priceListsAsOf, subscriptionVatAsOf, termsAsOf } from './catalogue';
import { SubscriptionCoreService } from './core.service';
import { nextSubscriptionNumber } from './numbering';
import { lockSubscription, platformBookId, platformCompanyId, withPlatform } from './platform';

/**
 * The platform's own provider account (M10 decision 9): the deployment's Paystack, charged with no
 * subaccount, so subscription money settles to the platform's balance. D1 governs rent, not this.
 */
export const PLATFORM_PAYMENT_PROVIDER = 'paystack';

export const SUBSCRIPTION_RECEIPT_TEMPLATE = {
  key: subscriptionReceiptV1.key,
  version: subscriptionReceiptV1.version,
} as const;

/** Ids of the staff notices about a payment: one per person and event, so a retry sends none. */
const NOTICE_NAMESPACE = '6b1f2a7c-3d4e-5f60-8a9b-0c1d2e3f4a5b';
/** Ids of the platform's settlements (P26): one per provider and settlement. */
const SETTLEMENT_NAMESPACE = 'a3c9e2d4-7b15-5e8f-9c6a-1d2b3e4f5a60';

const DOWNLOAD_MS = 5 * 60_000;
/** A charge still waiting after this long is checked with the provider (lost webhooks). */
const VERIFY_AFTER_MS = 5 * 60_000;
/** A charge the provider never heard of is abandoned after this long. */
const ABANDON_AFTER_MS = 60 * 60_000;

/** What a verification failure is recorded as: refused for good, never posted. */
const VERIFICATION_PREFIX = 'verification_';

const NETWORKS: Record<'mtn' | 'vodafone' | 'airteltigo', MomoNetwork> = {
  mtn: 'mtn',
  vodafone: 'telecel',
  airteltigo: 'at',
};

/** Matches the contract's `subscriptionPaymentSchema`. */
export interface SubscriptionPaymentView {
  readonly id: string;
  /** `SUB-…`: routed to subscriptions, never to rent (decision 9). */
  readonly reference: string;
  readonly purpose: SubscriptionPaymentPurpose;
  readonly channel: SubscriptionPaymentChannel;
  readonly amountMinor: number;
  readonly status: SubscriptionPaymentStatus;
  readonly checkoutUrl: string | null;
  readonly message: string | null;
  readonly receiptId: string | null;
}

/** Matches the contract's `subscriptionReceiptSchema`. */
export interface SubscriptionReceiptView {
  readonly id: string;
  readonly number: string;
  readonly paidOn: string;
  readonly amountMinor: number;
  readonly channel: SubscriptionPaymentChannel;
  readonly purpose: SubscriptionPaymentPurpose;
  readonly invoiceNumbers: string[];
  readonly hasDocument: boolean;
}

export interface PayInput {
  readonly purpose: SubscriptionPaymentPurpose;
  readonly channel: SubscriptionPaymentChannel;
  /** For MoMo: the wallet's phone (E.164, or a Ghanaian number) and its network. Never logged. */
  readonly momoPhone?: string;
  readonly momoProvider?: 'mtn' | 'vodafone' | 'airteltigo';
}

/** How a verified charge was dealt with, for the webhook inbox and reconciliation. */
export type SubscriptionChargeOutcome =
  'posted' | 'already_posted' | 'pending' | 'failed' | 'rejected' | 'unknown';

/** How money taken back at the provider was dealt with. */
export type SubscriptionReversalOutcome = 'reversed' | 'ignored' | 'partial' | 'needs_review';

type PaymentRow = typeof schema.subscriptionPayment.$inferSelect;

const view = (row: PaymentRow, receiptId: string | null): SubscriptionPaymentView => ({
  id: row.id,
  reference: row.reference,
  purpose: row.purpose as SubscriptionPaymentPurpose,
  channel: row.channel as SubscriptionPaymentChannel,
  amountMinor: row.amountMinor,
  status: row.status as SubscriptionPaymentStatus,
  checkoutUrl: row.checkoutUrl,
  message: row.message,
  receiptId,
});

const sumOf = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/**
 * Paying the subscription (M10: PB-07, AD-08; plan 4.4; decisions 7, 9 and 11). A subscriber pays
 * its open invoices, or 12 months up front, by card on the provider's checkout or by a MoMo prompt,
 * into the platform's own account (no subaccount). The reference starts `SUB-`, so webhook
 * processing and the daily reconciliation hand it here and never to rent.
 *
 * Money is posted only from the provider's verify answer, compared exactly with the payment
 * (amount, currency, status and reference; CLAUDE.md section 8): never from a webhook body. In the
 * platform company's context and under the subscription's lock, a verified payment posts P26 in
 * the platform book, is allocated to open invoices oldest first (the rest is prepaid credit, 2020;
 * an annual payment is all credit), settles the invoices it pays in full, gets a gap-free receipt
 * (`SUBR-2026-000001`) with its PDF, and refreshes the subscription, so paying in full restores
 * full access at once (decision 11). Replays post nothing new.
 */
@Injectable()
export class SubscriptionPaymentsService implements PlatformCharges {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProviders,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(SubscriptionCoreService) private readonly core: SubscriptionCoreService,
    @Inject(PostingService) private readonly posting: PostingService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  // Paying -------------------------------------------------------------------------------------

  /**
   * Starts a payment: every open invoice's outstanding (409 NOTHING_TO_PAY when nothing is open),
   * or 12 months up front (decision 7). Card answers the provider's checkout address; MoMo a
   * plain message while the prompt is on the phone. Works while the company is read-only.
   *
   * With an Idempotency-Key, the claim is taken once the payment is recorded and before the
   * provider is called, so a retried request never starts a second charge; its stored answer is
   * the payment's id (render it again with `payment()` for the live status).
   */
  async pay(
    actor: Actor | null,
    input: PayInput,
    claim?: IdempotencyClaim | null,
  ): Promise<SubscriptionPaymentView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'subscription.manage');
    let phone: string | null = null;
    let network: MomoNetwork | null = null;
    if (input.channel === 'momo') {
      phone = input.momoPhone ? tryNormalisePhone(input.momoPhone) : null;
      if (!phone) throw invalid('momo_phone', 'Enter the mobile money number to charge');
      if (!input.momoProvider) throw invalid('momo_provider', 'Choose the mobile money network');
      network = NETWORKS[input.momoProvider];
    }
    if (!this.providers.has(PLATFORM_PAYMENT_PROVIDER))
      throw new AppError(
        503,
        'payments_unavailable',
        'Payments are not available just now. Try again later.',
      );
    const port = this.providers.get(PLATFORM_PAYMENT_PROVIDER);

    // What the subscriber pays with: the payer's own email, else one in the payments domain.
    const { email, liveUnits } = await withCompany(
      this.database,
      staffContext(staff),
      async (tx) => ({
        email: (await personContact(tx, staff.personId))?.email ?? null,
        liveUnits: input.purpose === 'annual' ? await this.unitsForEstimate(tx) : null,
      }),
      { accessMode: 'read only' },
    );

    const paymentId = uuidv7();
    const reference = `SUB-${paymentId.replace(/-/g, '')}`;
    const created = await withPlatform(
      this.database,
      { personId: staff.personId },
      async (tx, platformId) => {
        const company = await this.core.subscriberCompany(tx, staff.companyId);
        if (!company) throw notFound('Subscription');
        const sub = await this.core.ensure(tx, platformId, company, { personId: staff.personId });
        const today = this.core.todayIn(company.timeZone);
        let amountMinor: number;
        let annual: { firstMonth: string; lastMonth: string; discountBps: number } | null = null;
        if (input.purpose === 'invoices') {
          const open = await this.core.openInvoices(tx, company.id);
          amountMinor = sumOf(open.map((i) => Math.max(0, i.outstandingMinor)));
          if (amountMinor <= 0)
            throw conflict('nothing_to_pay', 'Nothing is owed on the subscription just now');
        } else {
          if (sub.status === 'cancelled' || sub.status === 'cancel_scheduled')
            throw conflict(
              'subscription_cancelled',
              'The subscription is ending, so it cannot be paid a year ahead',
            );
          const quote = await this.annualQuote(tx, sub, today, liveUnits);
          amountMinor = quote.totalMinor;
          annual = quote;
        }
        const [row] = await tx
          .insert(schema.subscriptionPayment)
          .values({
            id: paymentId,
            companyId: platformId,
            subscriptionId: sub.id,
            subscriberCompanyId: company.id,
            reference,
            purpose: input.purpose,
            channel: input.channel,
            amountMinor,
            status: 'initiated',
            provider: PLATFORM_PAYMENT_PROVIDER,
            annualFirstMonth: annual?.firstMonth ?? null,
            annualLastMonth: annual?.lastMonth ?? null,
            annualDiscountBps: annual?.discountBps ?? null,
            initiatedBy: staff.personId,
          })
          .returning();
        return row!;
      },
    );

    if (claim) {
      try {
        await withCompany(this.database, staffContext(staff), async (tx) => {
          await claim.claim(tx);
          await claim.done(tx, view(created, null));
        });
      } catch (error) {
        // Another request under the same key got there first: this one never reaches the provider.
        await this.record(created.id, {
          status: 'failed',
          failedAt: this.clock.now(),
          failureReason: 'superseded',
        });
        throw error;
      }
    }

    // The provider is called outside any transaction (CLAUDE.md section 8).
    const metadata = {
      purpose: input.purpose,
      paymentId: created.id,
      subscriberCompanyId: staff.companyId,
    };
    const payerEmail =
      email ??
      `subscriber-${staff.companyId.replace(/-/g, '')}@${customerEmailDomainOf(this.config)}`;
    let result: ChargeInitialised;
    try {
      result =
        input.channel === 'card'
          ? await port.initializePlatform({
              reference,
              amountMinor: created.amountMinor,
              currency: 'GHS',
              email: payerEmail,
              metadata,
              callbackUrl: `${this.config.WEB_ORIGIN.replace(/\/$/, '')}/settings/subscription`,
            })
          : await port.chargePlatformMomo({
              reference,
              amountMinor: created.amountMinor,
              currency: 'GHS',
              email: payerEmail,
              phone: phone!,
              network: network!,
              metadata,
            });
    } catch (error) {
      this.logger.warn(
        {
          paymentId: created.id,
          provider: PLATFORM_PAYMENT_PROVIDER,
          status: error instanceof ProviderError ? error.status : null,
        },
        'a subscription payment could not be started with the provider',
      );
      return view(
        await this.record(created.id, {
          status: 'failed',
          failedAt: this.clock.now(),
          failureReason:
            error instanceof ProviderError && !error.retryable
              ? 'provider_refused'
              : 'provider_unavailable',
          message: 'The payment could not be started. Nothing was charged; try again.',
        }),
        null,
      );
    }
    if (result.unsupportedStep || result.status === 'failed' || result.status === 'abandoned')
      return view(
        await this.record(created.id, {
          status: 'failed',
          failedAt: this.clock.now(),
          providerReference: result.providerReference,
          failureReason: result.unsupportedStep ? 'step_unsupported' : 'charge_failed',
          message: result.unsupportedStep
            ? 'This wallet asks for a step we cannot take here yet. Try another number, or pay by card.'
            : 'The payment did not go through. You can try again.',
        }),
        null,
      );
    return view(
      await this.record(created.id, {
        status: 'pending',
        providerReference: result.providerReference,
        checkoutUrl: result.authorizationUrl ?? null,
        message:
          input.channel === 'momo'
            ? (result.displayText ?? 'Approve the payment on your phone')
            : null,
      }),
      null,
    );
  }

  /** A payment's status, for the page that polls it (`subscription.read`). */
  async payment(actor: Actor | null, paymentId: string): Promise<SubscriptionPaymentView> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'subscription.read');
    // The subscriber reads its own (decision 1: the select-only policy on its rows).
    return withCompany(
      this.database,
      staffContext(staff),
      async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.subscriptionPayment)
          .where(
            and(
              eq(schema.subscriptionPayment.id, paymentId),
              eq(schema.subscriptionPayment.subscriberCompanyId, staff.companyId),
            ),
          );
        if (!row) throw notFound('Payment');
        const [receipt] = await tx
          .select({ id: schema.subscriptionReceipt.id })
          .from(schema.subscriptionReceipt)
          .where(eq(schema.subscriptionReceipt.paymentId, row.id));
        return view(row, receipt?.id ?? null);
      },
      { accessMode: 'read only' },
    );
  }

  /** The subscriber's receipts, newest first (`subscription.read`). */
  async receipts(actor: Actor | null): Promise<SubscriptionReceiptView[]> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'subscription.read');
    const rows = await withCompany(
      this.database,
      staffContext(staff),
      (tx) =>
        tx.execute<{
          id: string;
          number: string;
          paid_on: string;
          amount_minor: string | number;
          channel: SubscriptionPaymentChannel;
          purpose: SubscriptionPaymentPurpose;
          has_document: boolean;
          invoice_numbers: string[] | null;
        }>(
          sql`select r.id, r.number, r.paid_on::text, r.amount_minor, p.channel, p.purpose,
                r.document_id is not null as has_document,
                array(select i.number from subscription_allocation a
                      join subscription_invoice i on i.company_id = a.company_id and i.id = a.invoice_id
                      where a.company_id = r.company_id and a.payment_id = r.payment_id
                      order by i.issued_on, i.number) as invoice_numbers
              from subscription_receipt r
              join subscription_payment p on p.company_id = r.company_id and p.id = r.payment_id
              where r.subscriber_company_id = ${staff.companyId}::uuid
              order by r.issued_at desc, r.number desc`,
        ),
      { accessMode: 'read only' },
    );
    return rows.rows.map((r) => ({
      id: r.id,
      number: r.number,
      paidOn: r.paid_on,
      amountMinor: Number(r.amount_minor),
      channel: r.channel,
      purpose: r.purpose,
      invoiceNumbers: r.invoice_numbers ?? [],
      hasDocument: r.has_document,
    }));
  }

  /** A 5-minute link to a receipt's PDF; 409 DOCUMENT_RENDERING while it renders. */
  async receiptDocument(
    actor: Actor | null,
    receiptId: string,
  ): Promise<{ readonly url: string; readonly expiresAt: Date }> {
    const staff = staffActor(actor);
    this.policy.assert(staff, 'subscription.read');
    const [receipt] = await withCompany(
      this.database,
      staffContext(staff),
      (tx) =>
        tx
          .select()
          .from(schema.subscriptionReceipt)
          .where(
            and(
              eq(schema.subscriptionReceipt.id, receiptId),
              eq(schema.subscriptionReceipt.subscriberCompanyId, staff.companyId),
            ),
          ),
      { accessMode: 'read only' },
    );
    if (!receipt) throw notFound('Receipt');
    const platformId = await platformCompanyId(this.database);
    let documentId = receipt.documentId;
    if (!documentId && receipt.renderRequestId) {
      const rendered = await withPlatform(
        this.database,
        {},
        (tx) => this.documents.renderedDocument(tx, receipt.renderRequestId!),
        { accessMode: 'read only' },
      );
      if (rendered?.status === 'rendered') documentId = rendered.documentId;
    }
    if (!documentId)
      throw conflict('document_rendering', 'The PDF is still being made. Try again in a moment.');
    const url = await this.documents.downloadUrl(
      platformId,
      documentId,
      `subscription-receipt-${receipt.number}.pdf`,
    );
    if (!url) throw notFound('Receipt PDF');
    return { url, expiresAt: new Date(this.clock.now().getTime() + DOWNLOAD_MS) };
  }

  // The webhook path ---------------------------------------------------------------------------

  /** `PlatformCharges.paid`: a paid event for a `SUB-` reference. */
  paid(provider: string, reference: string): Promise<string> {
    return this.processReference(provider, reference);
  }

  /** `PlatformCharges.reversed`: a refund or chargeback event for a `SUB-` reference. */
  reversed(provider: string, reference: string): Promise<string> {
    return this.recordReversal(provider, reference);
  }

  /**
   * Verifies a reference with the provider (outside any transaction) and posts what it says:
   * the webhook processor, reconciliation and verify-pending all come here.
   */
  async processReference(provider: string, reference: string): Promise<SubscriptionChargeOutcome> {
    if (!this.providers.has(provider)) return 'unknown';
    let verified: ProviderTransaction;
    try {
      verified = await this.providers.get(provider).verifyTransaction(reference);
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return 'unknown';
      throw error;
    }
    return this.onVerifiedCharge(provider, reference, verified);
  }

  /**
   * Posts a payment from what its provider verified (plan 4.4). Amount, currency, status and
   * reference are compared exactly with the payment; any difference, or a charge paid to a
   * subaccount, is refused: nothing posts and a security alert goes. A succeeded payment is final,
   * so a second verification (a replayed webhook, reconciliation) posts nothing new.
   */
  async onVerifiedCharge(
    provider: string,
    reference: string,
    verified: VerifiedCharge & { readonly subaccountCode?: string },
  ): Promise<SubscriptionChargeOutcome> {
    const done = await withPlatform(this.database, {}, async (tx, platformId) => {
      const [found] = await tx
        .select({
          id: schema.subscriptionPayment.id,
          subscriberCompanyId: schema.subscriptionPayment.subscriberCompanyId,
        })
        .from(schema.subscriptionPayment)
        .where(eq(schema.subscriptionPayment.reference, reference));
      if (!found) return { outcome: 'unknown' as const };
      await lockSubscription(tx, found.subscriberCompanyId);
      const [payment] = await tx
        .select()
        .from(schema.subscriptionPayment)
        .where(eq(schema.subscriptionPayment.id, found.id))
        .for('update');
      if (!payment) return { outcome: 'unknown' as const };
      if (payment.status === 'succeeded' || payment.status === 'reversed')
        return { outcome: 'already_posted' as const, payment };
      // Refused once, refused for good: a person looks at it (the alert went then).
      if (payment.failureReason?.startsWith(VERIFICATION_PREFIX))
        return { outcome: 'rejected' as const, payment, reason: null };
      const now = this.clock.now();
      const result = compareVerified(
        {
          reference: payment.reference,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
        },
        verified,
      );
      // Anything that must match and does not is refused. A different amount is refused too:
      // subscription money posts only as asked. And the platform's charges settle to its own
      // balance (decision 9), never to a subaccount.
      const refusal =
        payment.provider !== provider
          ? 'provider_differs'
          : result.kind === 'reject'
            ? result.reason
            : result.kind === 'post_and_flag'
              ? result.reason
              : result.kind === 'post' && verified.subaccountCode
                ? 'paid_to_subaccount'
                : null;
      if (refusal !== null) {
        await this.update(tx, payment.id, {
          status: 'failed',
          failedAt: now,
          failureReason: `${VERIFICATION_PREFIX}${refusal}`,
          message:
            'The payment could not be confirmed, so nothing was recorded. We are looking into it.',
        });
        return { outcome: 'rejected' as const, payment, reason: refusal };
      }
      if (result.kind === 'not_paid') {
        if (result.status === 'pending') return { outcome: 'pending' as const, payment };
        if (payment.status !== 'failed')
          await this.update(tx, payment.id, {
            status: 'failed',
            failedAt: now,
            failureReason: result.status,
            message: 'The payment did not go through. You can try again.',
          });
        return { outcome: 'failed' as const, payment };
      }
      return {
        outcome: 'posted' as const,
        payment,
        ...(await this.post(tx, platformId, payment, verified)),
      };
    });

    if (done.outcome === 'rejected' && done.reason !== null)
      await this.alerts.raise({
        severity: 'critical',
        code: 'subscription.verification_mismatch',
        message:
          'A subscription payment did not match what the provider verified; nothing was posted',
        context: { paymentId: done.payment.id, provider, reason: done.reason },
      });
    if (done.outcome === 'posted') {
      await this.core.auditSubscriber(
        done.payment.subscriberCompanyId,
        'subscription.payment_received',
        done.payment.id,
        {
          amountMinor: done.payment.amountMinor,
          purpose: done.payment.purpose,
          receiptNumber: done.receipt.number,
          accessRestored: done.accessRestored,
        },
        done.payment.initiatedBy,
      );
    }
    if (
      done.outcome === 'posted' ||
      (done.outcome === 'already_posted' && done.payment.status === 'succeeded')
    )
      await this.notifyPaid(done.payment);
    return done.outcome;
  }

  /**
   * P26 payment, allocations, settled invoices, the receipt and its PDF, and the refreshed status,
   * in the platform company's transaction that holds the subscription's lock.
   */
  private async post(tx: Tx, platformId: string, payment: PaymentRow, verified: VerifiedCharge) {
    const company = await this.core.subscriberCompany(tx, payment.subscriberCompanyId);
    const sub = await this.core.byId(tx, payment.subscriptionId);
    if (!company || !sub) throw new Error(`Subscription payment ${payment.id} has no subscription`);
    const now = this.clock.now();
    const today = this.core.todayIn(company.timeZone);
    const paidOn = this.dayOf(verified.paidAt, company.timeZone, today);
    const bookId = await platformBookId(tx, platformId);

    // Oldest first (decision 7: an annual payment allocates nothing; it is all prepaid credit).
    const open = payment.purpose === 'invoices' ? await this.core.openInvoices(tx, company.id) : [];
    const { allocations, creditMinor } =
      payment.purpose === 'invoices'
        ? allocateSubscriptionPayment(
            payment.amountMinor,
            open.map((i) => ({
              invoiceId: i.id,
              issuedOn: i.issuedOn,
              number: i.number,
              outstandingMinor: Math.max(0, i.outstandingMinor),
            })),
          )
        : { allocations: [] as SubscriptionAllocation[], creditMinor: payment.amountMinor };

    await this.posting.post(tx, {
      companyId: platformId,
      rule: 'P26',
      key: subscriptionPostingKeys.payment(payment.id),
      valueDate: paidOn,
      lines: subscriptionPaymentLines({
        bookId,
        paymentId: payment.id,
        amountMinor: payment.amountMinor,
        allocations,
      }),
      record: { type: 'subscription_payment', id: payment.id },
    });
    if (allocations.length > 0)
      await tx.insert(schema.subscriptionAllocation).values(
        allocations.map((a) => ({
          companyId: platformId,
          subscriberCompanyId: company.id,
          source: 'payment',
          paymentId: payment.id,
          invoiceId: a.invoiceId,
          amountMinor: a.amountMinor,
        })),
      );
    const settled = allocations
      .filter(
        (a) => a.amountMinor >= (open.find((i) => i.id === a.invoiceId)?.outstandingMinor ?? 0),
      )
      .map((a) => a.invoiceId);
    if (settled.length > 0)
      await tx
        .update(schema.subscriptionInvoice)
        .set({ status: 'paid', paidAt: now, updatedAt: now })
        .where(
          and(
            inArray(schema.subscriptionInvoice.id, settled),
            eq(schema.subscriptionInvoice.status, 'open'),
          ),
        );
    await this.update(tx, payment.id, {
      status: 'succeeded',
      succeededAt: now,
      failedAt: null,
      failureReason: null,
      message: null,
    });

    if (payment.purpose === 'annual' && payment.annualFirstMonth) {
      const term = annualTerm(payment.annualFirstMonth);
      await this.core.event(tx, platformId, sub, 'annual_started', {
        effectiveOn: term.startsOn,
        data: {
          paymentId: payment.id,
          firstMonth: term.firstMonth,
          lastMonth: term.lastMonth,
          endsOn: term.endsOn,
          discountBps: payment.annualDiscountBps,
          amountMinor: payment.amountMinor,
        },
        actorPersonId: payment.initiatedBy,
      });
    }

    // The receipt: gap-free, taken in this transaction (a rollback gives its number back).
    const number = await nextSubscriptionNumber(
      tx,
      platformId,
      'receipt',
      Number(paidOn.slice(0, 4)),
    );
    const [receipt] = await tx
      .insert(schema.subscriptionReceipt)
      .values({
        companyId: platformId,
        subscriberCompanyId: company.id,
        paymentId: payment.id,
        number,
        paidOn,
        amountMinor: payment.amountMinor,
        templateKey: SUBSCRIPTION_RECEIPT_TEMPLATE.key,
        templateVersion: SUBSCRIPTION_RECEIPT_TEMPLATE.version,
      })
      .returning({ id: schema.subscriptionReceipt.id });
    const platform = await companyRecord(tx, platformId);
    const data: SubscriptionReceiptDocumentData = {
      platformName: platform?.displayName ?? 'The platform',
      subscriberName: company.displayName,
      number,
      paidOn,
      amountMinor: payment.amountMinor,
      channel: payment.channel as SubscriptionPaymentChannel,
      reference: payment.reference,
      purpose: payment.purpose as SubscriptionPaymentPurpose,
      invoices: allocations.map((a) => ({
        number: open.find((i) => i.id === a.invoiceId)!.number,
        amountMinor: a.amountMinor,
      })),
      creditMinor,
    };
    const renderRequestId = await this.documents.requestRender(tx, {
      companyId: platformId,
      templateKey: SUBSCRIPTION_RECEIPT_TEMPLATE.key,
      templateVersion: SUBSCRIPTION_RECEIPT_TEMPLATE.version,
      data,
      requestedBy: payment.initiatedBy,
    });
    await tx
      .update(schema.subscriptionReceipt)
      .set({ renderRequestId })
      .where(eq(schema.subscriptionReceipt.id, receipt!.id));

    // Paying in full restores full access at once (decision 11).
    const refreshed = await this.core.refresh(tx, platformId, sub, company, {
      personId: payment.initiatedBy,
    });
    return {
      receipt: { id: receipt!.id, number },
      accessRestored: refreshed.accessChanged && refreshed.access === 'full',
    };
  }

  /**
   * `documents.rendered` for a receipt (as OwnerStatementsService.onDocumentRendered): its
   * document and SHA-256 are recorded once. `companyId` is the platform company's. Idempotent.
   */
  async onDocumentRendered(companyId: string, renderRequestId: string): Promise<boolean> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const rendered = await this.documents.renderedDocument(tx, renderRequestId);
      if (
        !rendered ||
        rendered.templateKey !== SUBSCRIPTION_RECEIPT_TEMPLATE.key ||
        rendered.status !== 'rendered' ||
        !rendered.documentId ||
        !rendered.sha256
      )
        return false;
      const updated = await tx.execute(
        sql`update subscription_receipt set document_id = ${rendered.documentId}::uuid,
              sha256 = ${rendered.sha256}
            where render_request_id = ${renderRequestId}::uuid and document_id is null`,
      );
      return (updated.rowCount ?? 0) > 0;
    });
  }

  // Money taken back ---------------------------------------------------------------------------

  /**
   * A chargeback, or a refund made at the provider (as P21b for rent). The provider is asked what
   * was taken back; a webhook body is never trusted. When all of it was taken, the payment is
   * reversed from its allocations as they stand now (P26 reversal): the invoices it paid owe again
   * and reopen, and the credit it left comes out of 2020. Prepaid credit is shared, and later
   * invoices may already have drawn it: when the subscriber's credit is now less than what this
   * payment left, nothing is reversed and a person decides (`needs_review`). A part taken back is
   * left for a person too (`partial`).
   */
  async recordReversal(provider: string, reference: string): Promise<SubscriptionReversalOutcome> {
    if (!this.providers.has(provider)) return 'ignored';
    const known = await withPlatform(
      this.database,
      {},
      async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.subscriptionPayment)
          .where(eq(schema.subscriptionPayment.reference, reference));
        return row ?? null;
      },
      { accessMode: 'read only' },
    );
    if (!known || known.status !== 'succeeded') return 'ignored';
    const taken = sumOf(
      (await this.providers.get(provider).reversals(reference))
        .filter((r) => r.status === 'processed')
        .map((r) => r.amountMinor),
    );
    if (taken <= 0) return 'ignored';
    const done = await withPlatform(this.database, {}, async (tx, platformId) => {
      await lockSubscription(tx, known.subscriberCompanyId);
      const [payment] = await tx
        .select()
        .from(schema.subscriptionPayment)
        .where(eq(schema.subscriptionPayment.id, known.id))
        .for('update');
      if (!payment || payment.status !== 'succeeded') return { outcome: 'ignored' as const };
      if (taken !== payment.amountMinor) return { outcome: 'partial' as const };
      const direct = await tx
        .select({
          invoiceId: schema.subscriptionAllocation.invoiceId,
          amountMinor: schema.subscriptionAllocation.amountMinor,
        })
        .from(schema.subscriptionAllocation)
        .where(eq(schema.subscriptionAllocation.paymentId, payment.id));
      const leftAsCredit = payment.amountMinor - sumOf(direct.map((a) => a.amountMinor));
      if ((await this.core.creditMinor(tx, payment.subscriberCompanyId)) < leftAsCredit)
        return { outcome: 'needs_review' as const };
      const company = await this.core.subscriberCompany(tx, payment.subscriberCompanyId);
      const sub = await this.core.byId(tx, payment.subscriptionId);
      if (!company || !sub)
        throw new Error(`Subscription payment ${payment.id} has no subscription`);
      const now = this.clock.now();
      await this.posting.post(tx, {
        companyId: platformId,
        rule: 'P26',
        key: subscriptionPostingKeys.paymentReversal(payment.id),
        valueDate: this.core.todayIn(company.timeZone),
        lines: subscriptionPaymentReversalLines({
          bookId: await platformBookId(tx, platformId),
          paymentId: payment.id,
          amountMinor: payment.amountMinor,
          allocations: direct,
        }),
        record: { type: 'subscription_payment', id: payment.id },
      });
      await this.update(tx, payment.id, { status: 'reversed', reversedAt: now });
      if (direct.length > 0)
        await tx
          .update(schema.subscriptionInvoice)
          .set({ status: 'open', paidAt: null, updatedAt: now })
          .where(
            and(
              inArray(
                schema.subscriptionInvoice.id,
                direct.map((a) => a.invoiceId),
              ),
              eq(schema.subscriptionInvoice.status, 'paid'),
            ),
          );
      await this.core.refresh(tx, platformId, sub, company);
      return { outcome: 'reversed' as const, payment };
    });
    if (done.outcome !== 'reversed') {
      if (done.outcome !== 'ignored')
        await this.alerts.raise({
          severity: 'critical',
          code: 'subscription.reversal_needs_review',
          message:
            done.outcome === 'partial'
              ? 'Part of a subscription payment was taken back at the provider; nothing was reversed'
              : 'A subscription payment was taken back after its credit was used; nothing was reversed',
          context: { paymentId: known.id, provider, takenMinor: taken },
        });
      return done.outcome;
    }
    await this.alerts.raise({
      severity: 'warning',
      code: 'subscription.chargeback',
      message: 'A subscription payment was charged back or refunded at the provider and reversed',
      context: { paymentId: known.id, provider },
    });
    await this.core.auditSubscriber(
      known.subscriberCompanyId,
      'subscription.payment_reversed',
      known.id,
      { amountMinor: known.amountMinor },
    );
    await this.notify(known.subscriberCompanyId, `${known.id}:reversed`, {
      subject: 'A subscription payment was taken back',
      body: `A subscription payment of ${format(money(known.amountMinor))} was charged back or refunded at the payment provider, so it no longer counts. Anything it paid is owed again; see the subscription page.`,
      related: { type: 'subscription_payment', id: known.id },
    });
    return 'reversed';
  }

  // Reconciliation and settlement (plan 4.4) ----------------------------------------------------

  /**
   * The day's platform transactions (`SUB-`), never matched to rent: a successful charge missing
   * here goes through the normal path; one taken back is checked with the provider; anything else
   * unexplained is raised for a person.
   */
  async reconcile(
    provider: string,
    range: { readonly from: string; readonly to: string },
    transactions: readonly ProviderTransaction[],
    reversals: readonly ListedReversal[],
  ): Promise<{
    readonly matched: number;
    readonly processed: number;
    readonly exceptions: number;
  }> {
    const references = transactions.map((t) => t.reference);
    const local = await withPlatform(
      this.database,
      {},
      (tx) =>
        tx.execute<{
          id: string;
          reference: string;
          amount_minor: string | number;
          status: string;
        }>(
          sql`select id, reference, amount_minor, status from subscription_payment
              where provider = ${provider} and status in ('succeeded', 'reversed')
                and (reference = any(${`{${references.map((r) => `"${r.replace(/"/g, '')}"`).join(',')}}`}::text[])
                     or (succeeded_at >= ${range.from}::timestamptz and succeeded_at < ${range.to}::timestamptz))`,
        ),
      { accessMode: 'read only' },
    );
    const byRef = new Map(local.rows.map((r) => [r.reference, r]));
    const result = reconcileTransactions(
      transactions.map((t) => ({
        reference: t.reference,
        status: t.status,
        amountMinor: t.amountMinor,
        currency: t.currency,
      })),
      local.rows.map((r) => ({
        reference: r.reference,
        amountMinor: Number(r.amount_minor),
        reversed: r.status === 'reversed',
      })),
    );
    let processed = 0;
    for (const reference of result.toProcess) {
      const outcome = await this.processReference(provider, reference);
      if (outcome === 'posted' || outcome === 'already_posted') processed += 1;
      this.logger.info({ provider, outcome }, 'reconciliation processed a subscription payment');
    }
    const takenBack = new Set([
      ...result.toReverse,
      ...reversals.filter((r) => r.status === 'processed').map((r) => r.reference),
    ]);
    for (const reference of takenBack) await this.recordReversal(provider, reference);
    let exceptions = 0;
    for (const exception of result.exceptions) {
      if (exception.kind === 'missing_here') {
        const now = await this.paymentByReference(exception.reference);
        if (now?.status === 'succeeded') continue;
      }
      if (exception.kind === 'missing_at_provider') {
        // Listed under another day (started before midnight, paid after): ask directly.
        const verified = await this.providers
          .get(provider)
          .verify(exception.reference)
          .catch(() => null);
        const ours = byRef.get(exception.reference);
        if (
          verified?.status === 'success' &&
          ours &&
          verified.amountMinor === Number(ours.amount_minor)
        )
          continue;
      }
      exceptions += 1;
      await this.alerts.raise({
        severity: 'warning',
        code: 'subscription.reconciliation_difference',
        message:
          'Reconciliation found a subscription payment that does not agree with the provider',
        context: {
          provider,
          kind: exception.kind,
          paymentId: byRef.get(exception.reference)?.id ?? null,
          reference: exception.reference,
        },
      });
    }
    return { matched: result.matched, processed, exceptions };
  }

  /**
   * A payout of the platform's own provider balance (P26 settlement, once per settlement): the
   * payments it names leave provider clearing (1050), the fee is an expense (5200), refunds and
   * chargebacks it deducted clear what their reversals took from 1050, and the net reaches the
   * platform's bank (1010). Posted only when the report is fully explained by our payments;
   * anything else is raised for a person and nothing posts.
   */
  async settlement(provider: string, s: ProviderSettlement): Promise<boolean> {
    const recordId = uuidv5(`${provider}:${s.settlementId}`, SETTLEMENT_NAMESPACE);
    const key = `P26:${recordId}`;
    const outcome = await withPlatform(this.database, {}, async (tx, platformId) => {
      if (await this.posting.findByKey(tx, platformId, key))
        return { posted: false, problems: [] as string[] };
      const refs = [...new Set([...s.references, ...s.deductedReferences.map((d) => d.reference)])];
      const rows =
        refs.length > 0
          ? await tx
              .select({
                id: schema.subscriptionPayment.id,
                reference: schema.subscriptionPayment.reference,
                amountMinor: schema.subscriptionPayment.amountMinor,
                status: schema.subscriptionPayment.status,
              })
              .from(schema.subscriptionPayment)
              .where(
                and(
                  eq(schema.subscriptionPayment.provider, provider),
                  inArray(schema.subscriptionPayment.reference, refs),
                ),
              )
          : [];
      const byRef = new Map(rows.map((r) => [r.reference, r]));
      const problems: string[] = [];
      if (s.currency !== 'GHS') problems.push('not in cedis');
      const paid = s.references.flatMap((r) => {
        const row = byRef.get(r);
        return row && (row.status === 'succeeded' || row.status === 'reversed') ? [row] : [];
      });
      if (paid.length !== s.references.length)
        problems.push(
          `${s.references.length - paid.length} payment(s) in the report are not ours or not posted yet`,
        );
      const gross = sumOf(paid.map((p) => p.amountMinor));
      if (gross !== s.grossMinor)
        problems.push(`the report's gross differs from its payments by ${gross - s.grossMinor}`);
      const named = sumOf(
        s.deductedReferences
          .filter((d) => byRef.get(d.reference)?.status === 'reversed')
          .map((d) => d.amountMinor),
      );
      if (named !== s.deductionsMinor)
        problems.push('deductions name no reversed subscription payment');
      if (s.grossMinor - s.feesMinor - s.deductionsMinor !== s.netMinor || s.netMinor < 0)
        problems.push("the report's gross less fees and deductions is not its net");
      if (problems.length > 0) return { posted: false, problems };
      const platform = await companyRecord(tx, platformId);
      const posted = await this.posting.post(tx, {
        companyId: platformId,
        rule: 'P26',
        key,
        valueDate: toIsoDate(
          businessDateOf(instantFrom(new Date(s.settledAt)), platform?.timeZone ?? 'Africa/Accra'),
        ),
        // `settlement_id` names rent's provider settlements (a key to them), and the platform has
        // none: the entry's record is the payout instead.
        lines: settlementLines({
          bookId: await platformBookId(tx, platformId),
          to: '1010',
          provider,
          settlementId: recordId,
          settlementAccountId: null,
          payments: paid.map((p) => ({ paymentId: p.id, amountMinor: p.amountMinor })),
          feesMinor: s.feesMinor,
          deductionsMinor: s.deductionsMinor,
          netMinor: s.netMinor,
        }).map((line) => ({ ...line, settlementId: null })),
        record: { type: 'subscription_settlement', id: recordId },
      });
      return { posted: posted !== null && !posted.replayed, problems: [] as string[] };
    });
    if (outcome.problems.length > 0)
      await this.alerts.raise({
        severity: 'critical',
        code: 'subscription.settlement_difference',
        message: `A payout of the platform balance was not posted: ${outcome.problems.join('; ')}`,
        context: { provider, settlementRef: s.settlementId },
      });
    return outcome.posted;
  }

  /**
   * Payments still waiting after 5 minutes are checked with the provider, so a lost webhook is
   * caught within minutes (as rent's verify-pending); one the provider never heard of is
   * abandoned after an hour. For a worker job; returns how many were checked.
   */
  async verifyPending(): Promise<number> {
    const now = this.clock.now();
    const waiting = await withPlatform(
      this.database,
      {},
      (tx) =>
        tx
          .select()
          .from(schema.subscriptionPayment)
          .where(
            and(
              inArray(schema.subscriptionPayment.status, ['initiated', 'pending']),
              sql`${schema.subscriptionPayment.createdAt} < ${new Date(now.getTime() - VERIFY_AFTER_MS)}`,
            ),
          ),
      { accessMode: 'read only' },
    );
    let checked = 0;
    for (const payment of waiting) {
      const outcome = await this.processReference(payment.provider, payment.reference).catch(
        (error: unknown) => {
          this.logger.warn({ err: error, paymentId: payment.id }, 'verify-pending could not check');
          return null;
        },
      );
      if (outcome !== null) checked += 1;
      if (outcome === 'unknown' && now.getTime() - payment.createdAt.getTime() > ABANDON_AFTER_MS)
        await this.record(payment.id, {
          status: 'failed',
          failedAt: now,
          failureReason: 'never_charged',
          message: 'The payment was not completed. You can try again.',
        });
    }
    return checked;
  }

  // Helpers -------------------------------------------------------------------------------------

  /** Updates a payment's progress in the platform company's context and returns the row. */
  private async record(
    paymentId: string,
    values: Partial<typeof schema.subscriptionPayment.$inferInsert>,
  ): Promise<PaymentRow> {
    return withPlatform(this.database, {}, async (tx) => {
      await this.update(tx, paymentId, values);
      const [row] = await tx
        .select()
        .from(schema.subscriptionPayment)
        .where(eq(schema.subscriptionPayment.id, paymentId));
      return row!;
    });
  }

  private async update(
    tx: Tx,
    paymentId: string,
    values: Partial<typeof schema.subscriptionPayment.$inferInsert>,
  ): Promise<void> {
    await tx
      .update(schema.subscriptionPayment)
      .set({ ...values, updatedAt: this.clock.now() })
      .where(eq(schema.subscriptionPayment.id, paymentId));
  }

  private async paymentByReference(reference: string): Promise<PaymentRow | null> {
    const [row] = await withPlatform(
      this.database,
      {},
      (tx) =>
        tx
          .select()
          .from(schema.subscriptionPayment)
          .where(eq(schema.subscriptionPayment.reference, reference)),
      { accessMode: 'read only' },
    );
    return row ?? null;
  }

  /**
   * 12 months up front (decision 7): `annualPrice` on last month's invoice net, or, with none,
   * this month's bill for a whole month at the current tier from the units leased now (D8), with
   * the tier's minimum as the floor, its annual discount and the VAT the terms charge.
   */
  private async annualQuote(
    tx: Tx,
    sub: {
      readonly id: string;
      readonly subscriberCompanyId: string;
      readonly tier: SubscriptionTier;
    },
    today: string,
    liveUnits: readonly SnapshotUnitInput[] | null,
  ): Promise<{ totalMinor: number; firstMonth: string; lastMonth: string; discountBps: number }> {
    const month = monthOf(today);
    const running = await tx
      .select({ id: schema.subscriptionPayment.id })
      .from(schema.subscriptionPayment)
      .where(
        and(
          eq(schema.subscriptionPayment.subscriberCompanyId, sub.subscriberCompanyId),
          eq(schema.subscriptionPayment.purpose, 'annual'),
          eq(schema.subscriptionPayment.status, 'succeeded'),
          sql`${schema.subscriptionPayment.annualLastMonth} >= ${month}`,
        ),
      );
    if (running.length > 0)
      throw conflict('annual_already_paid', 'This subscription is already paid a year ahead');
    const prices = (await priceListsAsOf(tx, today))[sub.tier];
    const terms = await termsAsOf(tx, today);
    const vat = await subscriptionVatAsOf(tx, this.rules, terms, today);
    const [last] = await tx
      .select({ netMinor: schema.subscriptionInvoice.netMinor })
      .from(schema.subscriptionInvoice)
      .where(
        and(
          eq(schema.subscriptionInvoice.subscriberCompanyId, sub.subscriberCompanyId),
          eq(schema.subscriptionInvoice.month, previousMonth(month)),
          sql`${schema.subscriptionInvoice.status} <> 'void'`,
        ),
      );
    let monthlyNetMinor = last?.netMinor ?? null;
    if (monthlyNetMinor === null) {
      const counts: BandCounts = countsByBand(billableUnits(month, liveUnits ?? []));
      const bounds = monthBounds(month);
      monthlyNetMinor = monthlyBill({
        month,
        counts,
        spans: [{ tier: sub.tier, firstDay: bounds.first, lastDay: bounds.last, prices }],
        annual: false,
        discount: null,
        vat: null,
      }).netMinor;
    }
    const price = annualPrice({
      monthlyNetMinor,
      minimumMinor: prices.minimumMinor,
      annualDiscountBps: prices.annualDiscountBps,
      vat: vat.rates,
    });
    const term = annualTerm(month);
    if (compareMonths(term.lastMonth, month) < 0)
      throw new Error('An annual term ends before it starts');
    return {
      totalMinor: price.totalMinor,
      firstMonth: term.firstMonth,
      lastMonth: term.lastMonth,
      discountBps: prices.annualDiscountBps,
    };
  }

  /** The subscriber's units with their leases that became active, for this month's estimate. */
  private async unitsForEstimate(tx: Tx): Promise<SnapshotUnitInput[]> {
    const rows = await tx.execute<{
      unit_id: string;
      unit_code: string;
      band: string;
      lease_id: string;
      start_date: string;
      last_day: string | null;
    }>(
      sql`select u.id as unit_id, u.code as unit_code, u.billing_band as band, l.id as lease_id,
            l.start_date::text, coalesce(l.move_out_date, l.ended_on)::text as last_day
          from unit u join lease l on l.unit_id = u.id
          where l.status in ('active', 'ending', 'holding_over', 'ended', 'terminated')
          order by u.id, l.id`,
    );
    const units = new Map<
      string,
      SnapshotUnitInput & { leases: SnapshotUnitInput['leases'][number][] }
    >();
    for (const r of rows.rows) {
      if (!isBillingBand(r.band)) continue;
      const unit = units.get(r.unit_id) ?? {
        unitId: r.unit_id,
        unitCode: r.unit_code,
        band: r.band,
        leases: [],
      };
      unit.leases.push({ leaseId: r.lease_id, startDate: r.start_date, lastDay: r.last_day });
      units.set(r.unit_id, unit);
    }
    return [...units.values()];
  }

  /** The business day a payment was made, in the subscriber's time zone; never after today. */
  private dayOf(paidAt: string | undefined, timeZone: string, today: string): string {
    if (!paidAt) return today;
    const day = toIsoDate(businessDateOf(instantFrom(new Date(paidAt)), timeZone));
    return day > today ? today : day;
  }

  /** Tells the subscriber's admins a payment was received (once, whatever the retries). */
  private async notifyPaid(payment: PaymentRow): Promise<void> {
    const [receipt] = await withPlatform(
      this.database,
      {},
      (tx) =>
        tx
          .select({ id: schema.subscriptionReceipt.id, number: schema.subscriptionReceipt.number })
          .from(schema.subscriptionReceipt)
          .where(eq(schema.subscriptionReceipt.paymentId, payment.id)),
      { accessMode: 'read only' },
    );
    if (!receipt) return;
    await this.notify(payment.subscriberCompanyId, `${payment.id}:paid`, {
      subject: 'Subscription payment received',
      body:
        `We received ${format(money(payment.amountMinor))} for your subscription. Receipt ${receipt.number} is on the subscription page.` +
        (payment.purpose === 'annual'
          ? ' It is held as prepaid credit, and each monthly invoice of the next 12 months is paid from it first.'
          : ''),
      related: { type: 'subscription_receipt', id: receipt.id },
    });
  }

  /**
   * A staff notice to the subscriber's people who manage the subscription, queued in the
   * subscriber's own context; ids are fixed per event and person, so a retry queues nothing new.
   */
  private async notify(
    subscriberCompanyId: string,
    event: string,
    message: {
      readonly subject: string;
      readonly body: string;
      readonly related: { readonly type: string; readonly id: string };
    },
  ): Promise<void> {
    await withCompany(
      this.database,
      { companyId: subscriberCompanyId, actorKind: 'system' },
      async (tx) => {
        const company = await companyRecord(tx, subscriberCompanyId);
        if (!company) return;
        for (const personId of await membersWhoCan(
          tx,
          this.policy,
          { id: company.id, kind: company.kind },
          'subscription.manage',
        ))
          await queueMessage(tx, subscriberCompanyId, {
            messageId: uuidv5(`${event}:${personId}`, NOTICE_NAMESPACE),
            recipient: { type: 'staff', personId },
            purpose: 'staff_notice',
            subject: message.subject,
            body: message.body,
            channels: ['email'],
            related: message.related,
          });
      },
    );
  }
}
